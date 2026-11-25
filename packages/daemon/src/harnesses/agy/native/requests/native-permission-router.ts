import crypto from 'node:crypto';
import {
  ResolveNativeRequestInputSchema,
  toPublicEvidenceDto,
  type ApprovalRequest,
  type NativeRequestReceiptState,
  type PendingNativeRequest,
  type ResolveApprovalRequest,
  type ResolveNativeRequestInput,
  type RiskLevel,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../wiring/registry.js';
import type {
  NativePermissionDecisionWireResult,
  NativePermissionPort,
} from '../wiring/types.js';
import { StubNativeRequestTargetResolver } from './target-resolver.js';
import {
  NativeRequestValidationError,
  type InternalPendingNativeRequestRecord,
  type LegacyApprovalBridgeInput,
  type NativeApprovalCenterBridge,
  type NativePermissionRouterOptions,
  type NativeRequestDetailDto,
  type NativeRequestOption,
  type NativeRequestResolutionOutcome,
  type NativeRequestTargetResolver,
  type NativeRequestValidationResult,
  type ResolveNativeRequestWithCasInput,
  type UnknownChildRequestPolicy,
} from './types.js';
import {
  JSON_RPC_METHOD_NOT_FOUND,
  buildCancelWireResponse,
  encodeNativeWireResponse,
  parseIncomingWireRequest,
} from './wire-codec.js';

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_UNKNOWN_CHILD_DEADLINE_MS = 30_000;

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function isRejectOnlyOption(opt: NativeRequestOption): boolean {
  return opt.kind === 'reject_once' || opt.kind === 'reject_always' || opt.kind === 'decline';
}

function defaultScheduleTimer(fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(fn, delayMs);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}

/**
 * NP-07 Native Approval, Elicitation & Question Router implementing `NativePermissionPort`.
 *
 * Guarantees:
 * - Tracks session / child / binding / generation / connectionId / RpcId (preserving number vs string) / occurrence.
 * - Routes in-turn, detached out-of-turn, confirmed child, and confirmed workflow requests reliably.
 * - Enforces unknown-child & conflicting-lineage security boundaries without ever widening permissions.
 * - Uses shared DB CAS (`claimApprovalReceiptCas`) + single-write wire guard against double-click,
 *   expiry, Stop, legacy+native dual-entry, and generation switch races.
 * - Rejects unknown methods (-32601), malformed wire/form schemas (-32602), and history_replay requests (-32601).
 * - Never implicitly maps free-text to options[0] and never replays stale authorizations after disconnect.
 * - Never auto-approves and never modifies general Approval Center risk rules or scores.
 */
export class NativePermissionRouter implements NativePermissionPort {
  private readonly recordsByApprovalId = new Map<string, InternalPendingNativeRequestRecord>();
  private readonly occurrenceCounters = new Map<string, number>();
  private readonly closedConnections = new Set<string>();
  private readonly targetResolver: NativeRequestTargetResolver;
  private readonly approvalCenterBridge?: NativeApprovalCenterBridge;
  private readonly onRequestSettled?: NativePermissionRouterOptions['onRequestSettled'];
  private readonly unknownChildPolicy: UnknownChildRequestPolicy;
  private readonly defaultDeadlineMs: number;
  private readonly unknownChildDeadlineMs: number;
  private readonly rejectUrlElicitationMode: boolean;
  private readonly now: () => number;
  private readonly generateApprovalId: () => string;
  private readonly scheduleTimer: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly registry: AgyNativeRuntimeRegistry,
    options: NativePermissionRouterOptions = {},
  ) {
    this.targetResolver = options.targetResolver ?? new StubNativeRequestTargetResolver();
    this.approvalCenterBridge = options.approvalCenterBridge;
    this.onRequestSettled = options.onRequestSettled;
    this.unknownChildPolicy = options.unknownChildPolicy ?? 'hold_bounded_cancel_only';
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.unknownChildDeadlineMs = options.unknownChildDeadlineMs ?? DEFAULT_UNKNOWN_CHILD_DEADLINE_MS;
    this.rejectUrlElicitationMode = options.rejectUrlElicitationMode ?? true;
    this.now = options.now ?? (() => Date.now());
    this.generateApprovalId =
      options.generateApprovalId ?? (() => `appr_nat_${crypto.randomBytes(6).toString('hex')}`);
    this.scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  onIncomingRequest(req: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly ingressOrdinal: number;
    readonly channel: 'live' | 'history_replay';
    readonly wireRequestId: string | number;
    readonly method: string;
    readonly params: Record<string, unknown>;
    readonly respond: (result: unknown) => boolean;
    readonly respondError: (code: number, message: string) => boolean;
  }): NativePermissionDecisionWireResult | null {
    // Defense-in-depth: history replay must NEVER create live approvals or side effects
    if (req.channel === 'history_replay') {
      return {
        handled: true,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: 'Server requests are not permitted during history replay',
        },
      };
    }

    if (this.closedConnections.has(req.connectionId)) {
      return {
        handled: true,
        error: {
          code: -32000,
          message: 'Connection already closed',
        },
      };
    }

    // Fence stale generation requests before creating any pending entry
    const activeBinding = this.registry.getActiveBinding(req.binding.sessionId, req.binding.instanceId);
    if (
      activeBinding &&
      (activeBinding.runtimeId !== req.binding.runtimeId ||
        activeBinding.generation !== req.binding.generation)
    ) {
      return {
        handled: true,
        error: {
          code: -32002,
          message: 'Request arrived for a stale runtime generation',
        },
      };
    }

    const rootNativeSessionId =
      this.targetResolver.getRootNativeSessionId?.(req.binding, req.connectionId) ?? null;

    const wireParsed = parseIncomingWireRequest(req.method, req.params, {
      defaultNativeSessionId: rootNativeSessionId,
      rejectUrlElicitationMode: this.rejectUrlElicitationMode,
    });
    if (!wireParsed.ok) {
      return {
        handled: true,
        error: wireParsed.rpcError,
      };
    }

    const parsed = wireParsed.parsed;
    const target = this.targetResolver.resolveTarget({
      binding: req.binding,
      connectionId: req.connectionId,
      wireRequestId: req.wireRequestId,
      actualNativeSessionId: parsed.actualNativeSessionId,
      rootNativeSessionId,
      toolCallId: parsed.toolCallId,
      parentSessionHint: parsed.parentSessionHint,
      childSessionHint: parsed.childSessionHint,
      workflowIdHint: parsed.workflowIdHint,
      rawParams: req.params,
    });

    const nowMs = this.now();
    const isUnknownOrConflicting =
      target.scope === 'unknown_child' || target.targetLineage === 'conflicting';
    const isUnresolvedForwarded =
      !isUnknownOrConflicting && target.targetLineage === 'unresolved';

    // Allocate strictly monotonic occurrence for (runtime, generation, nativeSession, dedupKey)
    const occKey = `${req.binding.runtimeId}::${req.binding.generation}::${parsed.actualNativeSessionId}::${parsed.dedupKey}`;
    const occurrence = (this.occurrenceCounters.get(occKey) ?? 0) + 1;
    this.occurrenceCounters.set(occKey, occurrence);

    const approvalId = this.generateApprovalId();
    const evidence = {
      kind: 'live_protocol' as const,
      connectionId: req.connectionId,
      ingressOrdinal: req.ingressOrdinal,
      wireVariant: 'acp_v1',
      observedAt: nowMs,
    };

    // Unknown child / conflicting lineage with immediate-reject policy:
    // record a terminal cancelled receipt and return wire cancel immediately (zero widening!).
    if (isUnknownOrConflicting && this.unknownChildPolicy === 'reject_immediately') {
      const receipt = this.registry.persistence.createPendingApprovalReceipt({
        binding: req.binding,
        approvalId,
      });
      this.registry.persistence.transitionApprovalReceiptState(
        receipt.receiptId,
        ['pending'],
        'cancelled',
        { reason: target.provenanceReason, policy: 'reject_immediately' },
      );

      const record: InternalPendingNativeRequestRecord = {
        approvalId,
        receiptId: receipt.receiptId,
        binding: req.binding,
        connectionId: req.connectionId,
        ingressOrdinal: req.ingressOrdinal,
        wireRequestId: req.wireRequestId,
        occurrence,
        actualNativeSessionId: parsed.actualNativeSessionId,
        method: parsed.method,
        kind: parsed.kind,
        scope: target.scope,
        targetLineage: target.targetLineage,
        ...(target.agentId ? { agentId: target.agentId } : {}),
        ...(target.agentLabel ? { agentLabel: target.agentLabel } : {}),
        ...(target.activityId ? { activityId: target.activityId } : {}),
        ...(target.workflowId ? { workflowId: target.workflowId } : {}),
        ...(target.workflowKind ? { workflowKind: target.workflowKind } : {}),
        ...(target.workflowLabel ? { workflowLabel: target.workflowLabel } : {}),
        turnId: target.turnId,
        isDetached: target.isDetached,
        forwardedToParentSession: target.forwardedToParentSession,
        provenanceReason: target.provenanceReason,
        ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
        toolName: parsed.toolName,
        toolKind: parsed.toolKind,
        legacyRequestKind: parsed.legacyRequestKind,
        summary: parsed.summary,
        diffPreview: parsed.diffPreview ?? null,
        riskLevel: parsed.riskLevel,
        annotations: [],
        securityWarnings: parsed.securityWarnings,
        options: parsed.options,
        allowedOptionIds: [],
        allowsFreeText: false,
        ...(parsed.questionText ? { questionText: parsed.questionText } : {}),
        ...(parsed.formSpec ? { formSpec: parsed.formSpec } : {}),
        canAnswer: false,
        canCancel: false,
        unsupportedReason: 'unknown_child_rejected_by_policy',
        deadline: nowMs,
        evidence,
        createdAt: nowMs,
        updatedAt: nowMs,
        resolvedAt: nowMs,
        terminalReason: target.provenanceReason,
        receiptState: 'cancelled',
        wireWritten: true,
        respond: null,
        respondError: null,
      };
      this.recordsByApprovalId.set(approvalId, record);
      this.publishRequestChanged(record, `req:${approvalId}:rejected_unknown_child`);

      return {
        handled: true,
        response: buildCancelWireResponse(parsed.kind),
      };
    }

    // Compute allowed options strictly without widening permissions:
    // - Unknown foreign child or conflicting lineage (hold_bounded_cancel_only):
    //   strip ALL allow/custom options; permit ONLY explicit reject/decline options or cancel!
    // - Unresolved forwarded child hint on root session:
    //   strip scope-widening options (allow_always / allow_session), permit only non-widening options or cancel!
    // - Confirmed root / child / workflow:
    //   permit exact wire-declared native optionIds.
    let allowedOptionIds: string[];
    let allowsFreeText = parsed.allowsFreeText;
    let canAnswer = parsed.canAnswer;
    let unsupportedReason = parsed.unsupportedReason;

    if (isUnknownOrConflicting) {
      allowedOptionIds = parsed.options.filter(isRejectOnlyOption).map((o) => o.optionId);
      allowsFreeText = false;
      canAnswer = false;
      unsupportedReason =
        target.targetLineage === 'conflicting'
          ? 'conflicting_child_lineage_cancel_only'
          : 'unknown_child_target_cancel_only';
    } else if (isUnresolvedForwarded) {
      allowedOptionIds = parsed.options.filter((o) => !o.scopeWidening).map((o) => o.optionId);
      if (parsed.kind === 'elicitation') {
        // Keep form capability if schema is supported, or restrict if unsupported
        canAnswer = parsed.canAnswer;
      } else {
        canAnswer = allowedOptionIds.length > 0;
      }
    } else {
      allowedOptionIds = parsed.options.map((o) => o.optionId);
    }

    const deadlineMs = isUnknownOrConflicting || isUnresolvedForwarded
      ? Math.min(this.unknownChildDeadlineMs, this.defaultDeadlineMs)
      : this.defaultDeadlineMs;
    const deadline = nowMs + Math.max(1, deadlineMs);

    // Read-only Approval Center annotation evaluation (NEVER modifies general rules or risk scores!)
    const sessionCtx = this.approvalCenterBridge?.getSessionContext?.(req.binding.sessionId) ?? null;
    const annotations =
      this.approvalCenterBridge?.evaluateLocalAnnotations?.({
        approvalId,
        sessionId: req.binding.sessionId,
        workspaceId: sessionCtx?.workspaceId ?? 'unknown',
        cwd: sessionCtx?.cwd,
        kind: parsed.legacyRequestKind,
        toolName: parsed.toolName,
        toolKind: parsed.toolKind,
        summary: parsed.summary,
        input: parsed.rawInput,
        diffPreview: parsed.diffPreview ?? null,
        riskLevel: parsed.riskLevel,
      }) ?? [];

    let effectiveRisk: RiskLevel = parsed.riskLevel;
    for (const note of annotations) {
      if (note.risk && RISK_RANK[note.risk] > RISK_RANK[effectiveRisk]) {
        effectiveRisk = note.risk;
      }
    }

    // Persist durable pending approval receipt in SQLite so DB CAS is authoritative
    const receipt = this.registry.persistence.createPendingApprovalReceipt({
      binding: req.binding,
      approvalId,
    });

    const record: InternalPendingNativeRequestRecord = {
      approvalId,
      receiptId: receipt.receiptId,
      binding: req.binding,
      connectionId: req.connectionId,
      ingressOrdinal: req.ingressOrdinal,
      wireRequestId: req.wireRequestId,
      occurrence,
      actualNativeSessionId: parsed.actualNativeSessionId,
      method: parsed.method,
      kind: parsed.kind,
      scope: target.scope,
      targetLineage: target.targetLineage,
      ...(target.agentId ? { agentId: target.agentId } : {}),
      ...(target.agentLabel ? { agentLabel: target.agentLabel } : {}),
      ...(target.activityId ? { activityId: target.activityId } : {}),
      ...(target.workflowId ? { workflowId: target.workflowId } : {}),
      ...(target.workflowKind ? { workflowKind: target.workflowKind } : {}),
      ...(target.workflowLabel ? { workflowLabel: target.workflowLabel } : {}),
      turnId: target.turnId,
      isDetached: target.isDetached,
      forwardedToParentSession: target.forwardedToParentSession,
      provenanceReason: target.provenanceReason,
      ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
      toolName: parsed.toolName,
      toolKind: parsed.toolKind,
      legacyRequestKind: parsed.legacyRequestKind,
      summary: parsed.summary,
      diffPreview: parsed.diffPreview ?? null,
      riskLevel: effectiveRisk,
      annotations,
      securityWarnings: parsed.securityWarnings,
      options: parsed.options,
      allowedOptionIds,
      allowsFreeText,
      ...(parsed.questionText ? { questionText: parsed.questionText } : {}),
      ...(parsed.formSpec ? { formSpec: parsed.formSpec } : {}),
      canAnswer,
      canCancel: true,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      deadline,
      evidence,
      createdAt: nowMs,
      updatedAt: nowMs,
      receiptState: 'pending',
      wireWritten: false,
      respond: req.respond,
      respondError: req.respondError,
    };

    record.timer = this.scheduleTimer(() => {
      this.expireRequest(approvalId);
    }, Math.max(1, deadline - nowMs));

    this.recordsByApprovalId.set(approvalId, record);

    // Optional mirror into legacy Approval Center (sanitized, same approvalId)
    if (this.approvalCenterBridge?.mirrorPendingApproval) {
      try {
        this.approvalCenterBridge.mirrorPendingApproval(this.buildLegacyApprovalMirror(record, sessionCtx?.parentSessionId ?? null));
      } catch {
        // isolate legacy bridge mirror failures
      }
    }

    this.publishRequestChanged(record, `req:${approvalId}:pending`);

    // Handled asynchronously: do NOT write wire response yet
    return { handled: true };
  }

  /**
   * Pure pre-CAS validation seam (can be invoked by routes before claiming DB CAS so invalid
   * form inputs return 400 INVALID_REQUEST while keeping the request pending).
   */
  validateResolutionInput(
    binding: RuntimeBinding,
    approvalId: string,
    request: ResolveNativeRequestInput,
  ): NativeRequestValidationResult {
    const parsedInput = ResolveNativeRequestInputSchema.safeParse(request);
    if (!parsedInput.success) {
      return {
        valid: false,
        errorCode: 'INVALID_PAYLOAD',
        message: parsedInput.error.issues[0]?.message ?? 'Invalid native resolution payload',
      };
    }

    const record = this.recordsByApprovalId.get(approvalId);
    if (!record) {
      return {
        valid: false,
        errorCode: 'REQUEST_NOT_PENDING',
        message: `Native request "${approvalId}" not found`,
      };
    }

    if (
      record.binding.runtimeId !== binding.runtimeId ||
      record.binding.sessionId !== binding.sessionId ||
      record.binding.instanceId !== binding.instanceId ||
      record.binding.generation !== binding.generation ||
      parsedInput.data.generation !== binding.generation
    ) {
      return {
        valid: false,
        errorCode: 'STALE_GENERATION',
        message: 'Binding generation does not match pending request',
      };
    }

    if (record.receiptState !== 'pending') {
      return {
        valid: false,
        errorCode: 'REQUEST_NOT_PENDING',
        message: `Native request "${approvalId}" is no longer pending (state: ${record.receiptState})`,
      };
    }

    if (this.now() >= record.deadline) {
      return {
        valid: false,
        errorCode: 'REQUEST_EXPIRED',
        message: `Native request "${approvalId}" has expired`,
      };
    }

    try {
      encodeNativeWireResponse(record, parsedInput.data);
      return { valid: true };
    } catch (err) {
      if (err instanceof NativeRequestValidationError) {
        return {
          valid: false,
          errorCode: err.code,
          message: err.message,
          details: err.details,
        };
      }
      throw err;
    }
  }

  async resolveNativeRequest(input: {
    readonly binding: RuntimeBinding;
    readonly approvalId: string;
    readonly receiptId: string;
    readonly request: ResolveNativeRequestInput;
    readonly resolvedBy: 'desktop' | 'mobile';
  }): Promise<NativeRequestResolutionOutcome> {
    const parsedInput = ResolveNativeRequestInputSchema.safeParse(input.request);
    if (!parsedInput.success) {
      throw new NativeRequestValidationError(
        'INVALID_PAYLOAD',
        parsedInput.error.issues[0]?.message ?? 'Invalid native request resolution input',
      );
    }

    const record = this.recordsByApprovalId.get(input.approvalId);
    if (!record) {
      const storedReceipt = this.registry.persistence.getApprovalReceiptByApprovalId(input.approvalId);
      return {
        approvalId: input.approvalId,
        receiptId: storedReceipt?.receiptId ?? input.receiptId,
        receiptState: (storedReceipt?.state as NativeRequestReceiptState | undefined) ?? 'expired',
        conflict: true,
      };
    }

    // Verify full binding scope + generation
    if (
      record.binding.runtimeId !== input.binding.runtimeId ||
      record.binding.sessionId !== input.binding.sessionId ||
      record.binding.instanceId !== input.binding.instanceId ||
      record.binding.generation !== input.binding.generation ||
      parsedInput.data.generation !== record.binding.generation
    ) {
      return {
        approvalId: record.approvalId,
        receiptId: input.receiptId,
        receiptState: record.receiptState === 'pending' ? 'connection_lost' : record.receiptState,
        conflict: true,
      };
    }

    // Already settled or in-flight -> never write a second wire response!
    if (record.receiptState !== 'pending' || record.wireWritten) {
      return {
        approvalId: record.approvalId,
        receiptId: record.receiptId,
        receiptState: record.receiptState,
        conflict: true,
      };
    }

    // Deadline expiry guard
    if (this.now() >= record.deadline) {
      this.finalizeExpiryInternal(record, false);
      return {
        approvalId: record.approvalId,
        receiptId: input.receiptId,
        receiptState: 'expired',
        conflict: true,
      };
    }

    // Connection liveness check
    if (this.closedConnections.has(record.connectionId) || !record.respond) {
      this.clearRecordTimer(record);
      record.receiptState = 'connection_lost';
      record.updatedAt = this.now();
      record.resolvedAt = record.updatedAt;
      record.terminalReason = 'connection_closed';
      record.respond = null;
      record.respondError = null;
      this.publishRequestChanged(record, `req:${record.approvalId}:connection_lost`);
      this.syncLegacyBridge(record, input.resolvedBy);
      return {
        approvalId: record.approvalId,
        receiptId: input.receiptId,
        receiptState: 'connection_lost',
        conflict: true,
      };
    }

    // Strict wire & form schema validation BEFORE claiming in-memory write slot!
    // Throws NativeRequestValidationError without touching the wire.
    const wireResponse = encodeNativeWireResponse(record, parsedInput.data);

    // Atomic single-write transition
    this.clearRecordTimer(record);
    record.receiptState = 'claimed';
    record.wireWritten = true;
    record.updatedAt = this.now();

    const responder = record.respond;
    record.respond = null;
    record.respondError = null;

    let writeOk: boolean;
    try {
      writeOk = responder(wireResponse);
    } catch {
      record.receiptState = 'delivery_unknown';
      record.updatedAt = this.now();
      record.resolvedAt = record.updatedAt;
      record.terminalReason = 'wire_write_threw';
      this.publishRequestChanged(record, `req:${record.approvalId}:delivery_unknown`);
      this.syncLegacyBridge(record, input.resolvedBy);
      return {
        approvalId: record.approvalId,
        receiptId: input.receiptId,
        receiptState: 'delivery_unknown',
        conflict: false,
      };
    }

    const nowMs = this.now();
    if (!writeOk) {
      record.receiptState = 'connection_lost';
      record.updatedAt = nowMs;
      record.resolvedAt = nowMs;
      record.terminalReason = 'wire_write_returned_false';
      this.publishRequestChanged(record, `req:${record.approvalId}:connection_lost`);
      this.syncLegacyBridge(record, input.resolvedBy);
      return {
        approvalId: record.approvalId,
        receiptId: input.receiptId,
        receiptState: 'connection_lost',
        conflict: false,
      };
    }

    const finalState: NativeRequestReceiptState =
      parsedInput.data.outcome === 'cancelled' ? 'cancelled' : 'response_written';
    record.receiptState = finalState;
    record.updatedAt = nowMs;
    record.resolvedAt = nowMs;
    record.terminalReason =
      parsedInput.data.outcome === 'selected'
        ? `selected:${parsedInput.data.optionId}`
        : parsedInput.data.outcome === 'form_submitted'
          ? 'form_submitted'
          : 'user_cancelled';

    this.publishRequestChanged(record, `req:${record.approvalId}:${finalState}`);
    this.syncLegacyBridge(record, input.resolvedBy, parsedInput.data);

    return {
      approvalId: record.approvalId,
      receiptId: input.receiptId,
      receiptState: finalState,
      conflict: false,
    };
  }

  /**
   * Self-contained DB CAS + resolution helper for direct callers and dual-entry tests.
   * Mirrors `routes.ts`: pre-validates, claims authoritative DB CAS, dispatches to
   * `resolveNativeRequest`, and transitions DB receipt to final state.
   */
  async resolveWithCas(input: ResolveNativeRequestWithCasInput): Promise<NativeRequestResolutionOutcome> {
    const precheck = this.validateResolutionInput(input.binding, input.approvalId, input.request);
    if (!precheck.valid && precheck.errorCode && precheck.errorCode !== 'REQUEST_NOT_PENDING' && precheck.errorCode !== 'REQUEST_EXPIRED' && precheck.errorCode !== 'STALE_GENERATION') {
      throw new NativeRequestValidationError(
        precheck.errorCode,
        precheck.message ?? 'Invalid native request resolution',
        precheck.details,
      );
    }

    const cas = this.registry.persistence.claimApprovalReceiptCas({
      approvalId: input.approvalId,
      expectedGeneration: input.binding.generation,
      expectedSessionId: input.binding.sessionId,
      idempotencyKey: input.request.idempotencyKey,
    });

    if (!cas.claimed || !cas.receipt) {
      return {
        approvalId: input.approvalId,
        receiptId: cas.receipt?.receiptId ?? '',
        receiptState:
          (cas.receipt?.state as NativeRequestReceiptState | undefined) ??
          (cas.staleGeneration ? 'connection_lost' : 'expired'),
        conflict: true,
      };
    }

    try {
      const outcome = await this.resolveNativeRequest({
        binding: input.binding,
        approvalId: input.approvalId,
        receiptId: cas.receipt.receiptId,
        request: input.request,
        resolvedBy: input.resolvedBy,
      });
      const transitioned = this.registry.persistence.transitionApprovalReceiptState(
        cas.receipt.receiptId,
        ['claimed'],
        outcome.receiptState,
        { outcome: input.request.outcome, resolvedBy: input.resolvedBy },
      );
      if (!transitioned.transitioned) {
        return {
          approvalId: input.approvalId,
          receiptId: cas.receipt.receiptId,
          receiptState: (transitioned.receipt?.state as NativeRequestReceiptState | undefined) ?? 'delivery_unknown',
          conflict: true,
        };
      }
      return outcome;
    } catch (err) {
      this.registry.persistence.transitionApprovalReceiptState(
        cas.receipt.receiptId,
        ['claimed'],
        'delivery_unknown',
        { error: 'resolve_with_cas_threw' },
      );
      throw err;
    }
  }

  /**
   * Safe compatibility adapter for legacy Approval Center (`SessionManager.resolveRuntimeRequest`)
   * when an approval is owned by `NativePermissionRouter`.
   *
   * Enforces:
   * - Never maps unencoded free-text to `options[0]`.
   * - Never widens permissions on unknown/unconfirmed child requests.
   * - Uses the already-claimed shared DB CAS `receiptId`.
   */
  async resolveViaLegacyApprovalCenter(
    input: LegacyApprovalBridgeInput,
  ): Promise<NativeRequestResolutionOutcome> {
    const record = this.recordsByApprovalId.get(input.approvalId);
    if (!record) {
      return {
        approvalId: input.approvalId,
        receiptId: input.receiptId,
        receiptState: 'expired',
        conflict: true,
      };
    }

    const mapped = this.mapLegacyRequestToNativeInput(record, input.request);
    return this.resolveNativeRequest({
      binding: input.binding,
      approvalId: input.approvalId,
      receiptId: input.receiptId,
      request: mapped,
      resolvedBy: input.resolvedBy,
    });
  }

  async resolveLegacyWithCas(input: Omit<LegacyApprovalBridgeInput, 'receiptId'>): Promise<NativeRequestResolutionOutcome> {
    const record = this.recordsByApprovalId.get(input.approvalId);
    if (!record) {
      return { approvalId: input.approvalId, receiptId: '', receiptState: 'expired', conflict: true };
    }
    return this.resolveWithCas({ ...input, request: this.mapLegacyRequestToNativeInput(record, input.request) });
  }

  onConnectionClosed(binding: RuntimeBinding, connectionId: string): void {
    this.closedConnections.add(connectionId);
    const nowMs = this.now();

    for (const record of this.recordsByApprovalId.values()) {
      if (record.binding.runtimeId !== binding.runtimeId || record.connectionId !== connectionId) {
        continue;
      }
      this.clearRecordTimer(record);
      record.respond = null;
      record.respondError = null;

      if (record.receiptState === 'pending') {
        record.receiptState = 'connection_lost';
        record.updatedAt = nowMs;
        record.resolvedAt = nowMs;
        record.terminalReason = 'connection_closed';
        this.publishRequestChanged(record, `req:${record.approvalId}:conn_closed_lost`);
        this.syncLegacyBridge(record, null);
      } else if (record.receiptState === 'claimed') {
        record.receiptState = 'delivery_unknown';
        record.updatedAt = nowMs;
        record.resolvedAt = nowMs;
        record.terminalReason = 'connection_closed_in_flight';
        this.publishRequestChanged(record, `req:${record.approvalId}:conn_closed_unknown`);
        this.syncLegacyBridge(record, null);
      }
    }
  }

  /**
   * Handles explicit user Stop / Cancel racing with pending native approvals.
   * Acquires DB CAS per pending request so Stop vs user click never double-writes.
   */
  handleStopRequested(
    binding: RuntimeBinding,
    target?: { readonly type: string; readonly id: string },
  ): { readonly cancelledApprovalIds: string[] } {
    const cancelledApprovalIds: string[] = [];
    const nowMs = this.now();

    for (const record of this.recordsByApprovalId.values()) {
      if (
        record.binding.runtimeId !== binding.runtimeId ||
        record.binding.generation !== binding.generation ||
        record.receiptState !== 'pending'
      ) {
        continue;
      }

      if (target) {
        const matchesTarget =
          target.type === 'runtime' ||
          (target.type === 'agent' && record.agentId === target.id) ||
          (target.type === 'activity' && record.activityId === target.id) ||
          (target.type === 'workflow' && record.workflowId === target.id);
        if (!matchesTarget) continue;
      }

      const cas = this.registry.persistence.claimApprovalReceiptCas({
        approvalId: record.approvalId,
        expectedGeneration: binding.generation,
        expectedSessionId: binding.sessionId,
      });
      if (!cas.claimed || !cas.receipt) {
        continue;
      }

      this.clearRecordTimer(record);
      record.wireWritten = true;
      const responder = record.respond;
      record.respond = null;
      record.respondError = null;

      let finalState: NativeRequestReceiptState = 'cancelled';
      if (responder && !this.closedConnections.has(record.connectionId)) {
        try {
          const ok = responder(buildCancelWireResponse(record.kind));
          finalState = ok ? 'cancelled' : 'connection_lost';
        } catch {
          finalState = 'delivery_unknown';
        }
      } else {
        finalState = 'connection_lost';
      }

      record.receiptState = finalState;
      record.updatedAt = nowMs;
      record.resolvedAt = nowMs;
      record.terminalReason = 'stop_requested';

      this.registry.persistence.transitionApprovalReceiptState(
        cas.receipt.receiptId,
        ['claimed'],
        finalState,
        { reason: 'stop_requested' },
      );
      this.publishRequestChanged(record, `req:${record.approvalId}:stop_${finalState}`);
      this.syncLegacyBridge(record, null);
      cancelledApprovalIds.push(record.approvalId);
    }

    return { cancelledApprovalIds };
  }

  /**
   * Fences and invalidates in-memory pending/claimed requests from a retired generation/epoch.
   * Never replays stale requests onto the new generation.
   */
  handleGenerationChanged(prevBinding: RuntimeBinding | null, nextBinding: RuntimeBinding): void {
    const nowMs = this.now();
    for (const record of this.recordsByApprovalId.values()) {
      const sameRuntimeDifferentGen =
        record.binding.runtimeId === nextBinding.runtimeId &&
        record.binding.generation !== nextBinding.generation;
      const matchesPrev =
        prevBinding !== null &&
        record.binding.runtimeId === prevBinding.runtimeId &&
        record.binding.generation === prevBinding.generation;

      if (!sameRuntimeDifferentGen && !matchesPrev) continue;

      this.clearRecordTimer(record);
      record.respond = null;
      record.respondError = null;
      if (record.receiptState === 'pending') {
        record.receiptState = 'connection_lost';
        record.updatedAt = nowMs;
        record.resolvedAt = nowMs;
        record.terminalReason = 'generation_changed';
        this.syncLegacyBridge(record, null);
      } else if (record.receiptState === 'claimed') {
        record.receiptState = 'delivery_unknown';
        record.updatedAt = nowMs;
        record.resolvedAt = nowMs;
        record.terminalReason = 'generation_changed_in_flight';
        this.syncLegacyBridge(record, null);
      }
    }
  }

  /** Deterministic deadline sweep for tests or periodic reconciliation. */
  expireDueRequests(nowMs = this.now()): string[] {
    const expiredIds: string[] = [];
    for (const record of this.recordsByApprovalId.values()) {
      if (record.receiptState === 'pending' && nowMs >= record.deadline) {
        if (this.expireRequest(record.approvalId)) {
          expiredIds.push(record.approvalId);
        }
      }
    }
    return expiredIds;
  }

  listPendingRequests(binding: RuntimeBinding): readonly PendingNativeRequest[] {
    const result: PendingNativeRequest[] = [];
    for (const record of this.recordsByApprovalId.values()) {
      if (
        record.binding.runtimeId !== binding.runtimeId ||
        record.binding.sessionId !== binding.sessionId ||
        record.binding.instanceId !== binding.instanceId ||
        record.binding.generation !== binding.generation ||
        record.receiptState !== 'pending'
      ) {
        continue;
      }
      result.push({
        approvalId: record.approvalId,
        runtimeId: record.binding.runtimeId,
        generation: record.binding.generation,
        connectionId: record.connectionId,
        wireRequestId: record.wireRequestId,
        occurrence: record.occurrence,
        actualNativeSessionId: record.actualNativeSessionId,
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.activityId ? { activityId: record.activityId } : {}),
        kind: record.kind,
        allowedOptionIds: [...record.allowedOptionIds],
        allowsFreeText: record.allowsFreeText,
        deadline: record.deadline,
      });
    }
    return result;
  }

  /**
   * Returns strictly sanitized public request details (zero private connectionId, wireRequestId,
   * actualNativeSessionId, or host path leakage).
   */
  listRequestDetails(
    binding: RuntimeBinding,
    opts: { readonly includeResolved?: boolean; readonly includePriorGenerations?: boolean } = {},
  ): readonly NativeRequestDetailDto[] {
    const nowMs = this.now();
    const items: NativeRequestDetailDto[] = [];
    for (const record of this.recordsByApprovalId.values()) {
      if (
        record.binding.runtimeId !== binding.runtimeId ||
        record.binding.sessionId !== binding.sessionId ||
        record.binding.instanceId !== binding.instanceId
      ) {
        continue;
      }
      if (!opts.includePriorGenerations && record.binding.generation !== binding.generation) {
        continue;
      }
      if (!opts.includeResolved && record.receiptState !== 'pending') {
        continue;
      }
      items.push(this.toDetailDto(record, nowMs));
    }
    return items;
  }

  getRequestDetail(approvalId: string): NativeRequestDetailDto | null {
    const record = this.recordsByApprovalId.get(approvalId);
    return record ? this.toDetailDto(record, this.now()) : null;
  }

  dispose(): void {
    for (const record of this.recordsByApprovalId.values()) {
      this.clearRecordTimer(record);
      record.respond = null;
      record.respondError = null;
    }
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private expireRequest(approvalId: string): boolean {
    const record = this.recordsByApprovalId.get(approvalId);
    if (!record || record.receiptState !== 'pending') return false;

    // Acquire shared DB CAS before writing expiry cancel on wire so double-click vs timeout never races
    let cas;
    try {
      cas = this.registry.persistence.claimApprovalReceiptCas({
        approvalId: record.approvalId,
        expectedGeneration: record.binding.generation,
        expectedSessionId: record.binding.sessionId,
      });
    } catch {
      return false;
    }
    if (!cas.claimed || !cas.receipt) {
      return false;
    }

    const finalState = this.finalizeExpiryInternal(record, true);
    try {
      this.registry.persistence.transitionApprovalReceiptState(
        cas.receipt.receiptId,
        ['claimed'],
        finalState,
        { reason: 'deadline_expired' },
      );
    } catch {
      // ignore if generation already changed
    }
    return true;
  }

  private finalizeExpiryInternal(
    record: InternalPendingNativeRequestRecord,
    writeCancelToWire: boolean,
  ): NativeRequestReceiptState {
    this.clearRecordTimer(record);
    const nowMs = this.now();
    const responder = record.respond;
    record.respond = null;
    record.respondError = null;
    record.wireWritten = true;

    let finalState: NativeRequestReceiptState = 'expired';
    if (writeCancelToWire && responder && !this.closedConnections.has(record.connectionId)) {
      try {
        const ok = responder(buildCancelWireResponse(record.kind));
        finalState = ok ? 'expired' : 'connection_lost';
      } catch {
        finalState = 'delivery_unknown';
      }
    }

    record.receiptState = finalState;
    record.updatedAt = nowMs;
    record.resolvedAt = nowMs;
    record.terminalReason = 'deadline_expired';
    this.publishRequestChanged(record, `req:${record.approvalId}:${finalState}`);
    this.syncLegacyBridge(record, null);
    return finalState;
  }

  private mapLegacyRequestToNativeInput(
    record: InternalPendingNativeRequestRecord,
    legacyReq: ResolveApprovalRequest,
  ): ResolveNativeRequestInput {
    const generation = record.binding.generation;

    if (legacyReq.decision === 'deny') {
      const rejectOpt = record.options.find(
        (o) => (o.kind === 'reject_once' || o.kind === 'decline') && record.allowedOptionIds.includes(o.optionId),
      );
      if (rejectOpt && record.kind === 'permission') {
        return {
          generation,
          outcome: 'selected',
          optionId: rejectOpt.optionId,
          ...(legacyReq.comment ? { comment: legacyReq.comment } : {}),
        };
      }
      return {
        generation,
        outcome: 'cancelled',
        ...(legacyReq.comment ? { comment: legacyReq.comment } : {}),
      };
    }

    if (record.kind === 'question') {
      const selectedId = legacyReq.questionAnswer?.selectedOptionIds?.[0]?.trim();
      const freeText = legacyReq.questionAnswer?.freeText?.trim();
      if (selectedId) {
        if (!record.allowedOptionIds.includes(selectedId)) {
          throw new NativeRequestValidationError(
            'INVALID_OPTION',
            `Selected option "${selectedId}" is not in allowedOptionIds`,
            { optionId: selectedId },
          );
        }
        return {
          generation,
          outcome: 'selected',
          optionId: selectedId,
          ...(legacyReq.comment ? { comment: legacyReq.comment } : {}),
        };
      }
      // Strictly forbid silently mapping freeText onto options[0]!
      if (freeText) {
        throw new NativeRequestValidationError(
          'FREE_TEXT_NOT_SUPPORTED',
          'Fixed-option native question does not accept free-text answers and will not map to the first option',
        );
      }
      return { generation, outcome: 'cancelled' };
    }

    if (record.kind === 'elicitation') {
      throw new NativeRequestValidationError(
        'UNSUPPORTED_FORM',
        'Structured elicitation forms must be submitted via POST /native/requests/:approvalId/resolve with validated formPayload',
      );
    }

    if (legacyReq.decision === 'allow_session') {
      const allowAlways = record.options.find(
        (o) => o.kind === 'allow_always' && record.allowedOptionIds.includes(o.optionId),
      );
      if (!allowAlways) {
        throw new NativeRequestValidationError(
          record.scope === 'unknown_child' || record.targetLineage !== 'confirmed'
            ? 'UNKNOWN_CHILD_WIDENING_BLOCKED'
            : 'INVALID_OPTION',
          'allow_session / allow_always option is not permitted for this native request',
        );
      }
      return {
        generation,
        outcome: 'selected',
        optionId: allowAlways.optionId,
        ...(legacyReq.comment ? { comment: legacyReq.comment } : {}),
      };
    }

    if (legacyReq.decision === 'allow_once') {
      const allowOnce = record.options.find(
        (o) => o.kind === 'allow_once' && record.allowedOptionIds.includes(o.optionId),
      );
      if (!allowOnce) {
        throw new NativeRequestValidationError(
          record.scope === 'unknown_child' || record.targetLineage !== 'confirmed'
            ? 'UNKNOWN_CHILD_WIDENING_BLOCKED'
            : 'INVALID_OPTION',
          'allow_once option is not permitted for this native request',
        );
      }
      return {
        generation,
        outcome: 'selected',
        optionId: allowOnce.optionId,
        ...(legacyReq.comment ? { comment: legacyReq.comment } : {}),
      };
    }

    throw new NativeRequestValidationError(
      'INVALID_PAYLOAD',
      'Legacy approval request must specify a valid decision or selectedOptionIds',
    );
  }

  private toDetailDto(
    record: InternalPendingNativeRequestRecord,
    nowMs: number,
  ): NativeRequestDetailDto {
    return {
      approvalId: record.approvalId,
      runtimeId: record.binding.runtimeId,
      generation: record.binding.generation,
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.activityId ? { activityId: record.activityId } : {}),
      targetLineage: record.targetLineage,
      kind: record.kind,
      allowedOptionIds: [...record.allowedOptionIds],
      allowsFreeText: record.allowsFreeText,
      receiptId: record.receiptId,
      receiptState: record.receiptState,
      deadline: record.deadline,
      evidence: toPublicEvidenceDto(record.evidence, nowMs),
      updatedAt: record.updatedAt,
      scope: record.scope,
      ...(record.agentLabel ? { agentLabel: record.agentLabel } : {}),
      ...(record.workflowId ? { workflowId: record.workflowId } : {}),
      ...(record.workflowKind ? { workflowKind: record.workflowKind } : {}),
      ...(record.workflowLabel ? { workflowLabel: record.workflowLabel } : {}),
      isDetached: record.isDetached,
      forwardedToParentSession: record.forwardedToParentSession,
      provenanceReason: record.provenanceReason,
      occurrence: record.occurrence,
      toolName: record.toolName,
      toolKind: record.toolKind,
      summary: record.summary,
      diffPreview: record.diffPreview ?? null,
      riskLevel: record.riskLevel,
      annotations: [...record.annotations],
      securityWarnings: [...record.securityWarnings],
      options: record.options.map((o) => ({ ...o })),
      ...(record.questionText ? { questionText: record.questionText } : {}),
      ...(record.formSpec ? { formSpec: record.formSpec } : {}),
      canAnswer: record.canAnswer && record.receiptState === 'pending',
      canCancel: record.canCancel && record.receiptState === 'pending',
      ...(record.unsupportedReason ? { unsupportedReason: record.unsupportedReason } : {}),
      ...(record.resolvedAt !== undefined ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
    };
  }

  private buildLegacyApprovalMirror(
    record: InternalPendingNativeRequestRecord,
    parentSessionId: string | null,
  ): ApprovalRequest {
    const supportedDecisions: string[] = [];
    if (record.options.some((o) => o.kind === 'allow_once' && record.allowedOptionIds.includes(o.optionId))) {
      supportedDecisions.push('allow_once');
    }
    if (record.options.some((o) => o.kind === 'allow_always' && record.allowedOptionIds.includes(o.optionId))) {
      supportedDecisions.push('allow_session');
    }
    supportedDecisions.push('deny');

    return {
      id: record.approvalId,
      sessionId: record.binding.sessionId,
      parentSessionId,
      instanceId: record.binding.instanceId,
      nativeRequestId: `native_req_${record.occurrence}_${record.approvalId}`,
      kind: record.legacyRequestKind,
      toolName: record.toolName,
      toolKind: record.toolKind,
      summary: record.summary,
      input: {},
      diffPreview: record.diffPreview ?? null,
      riskLevel: record.riskLevel,
      supportedDecisions,
      questionSpec:
        record.kind === 'question' && record.questionText
          ? {
              question: record.questionText,
              selectionMode: 'single',
              allowFreeText: false,
              options: record.options
                .filter((o) => record.allowedOptionIds.includes(o.optionId))
                .map((o) => ({
                  id: o.optionId,
                  label: o.name,
                  ...(o.description ? { description: o.description } : {}),
                })),
            }
          : null,
      secretSpec: null,
      annotations: record.annotations.length > 0 ? [...record.annotations] : undefined,
      status: 'pending',
      resolvedBy: null,
      decision: null,
      comment: null,
      createdAt: record.createdAt,
      resolvedAt: null,
    };
  }

  private syncLegacyBridge(
    record: InternalPendingNativeRequestRecord,
    resolvedBy: 'desktop' | 'mobile' | null,
    input?: ResolveNativeRequestInput,
  ): void {
    if (!this.approvalCenterBridge?.syncResolvedApproval) return;
    try {
      const status: ApprovalRequest['status'] =
        record.receiptState === 'expired'
          ? 'expired'
          : record.receiptState === 'cancelled' ||
              record.receiptState === 'connection_lost' ||
              record.receiptState === 'delivery_unknown'
            ? 'cancelled'
            : record.kind === 'question' || record.kind === 'elicitation'
              ? 'resolved'
              : 'approved';
      const chosenOpt =
        input?.outcome === 'selected'
          ? record.options.find((o) => o.optionId === input.optionId)
          : undefined;
      const decision: ApprovalRequest['decision'] =
        status === 'cancelled' || status === 'expired'
          ? 'deny'
          : chosenOpt?.kind === 'reject_once' || chosenOpt?.kind === 'reject_always' || chosenOpt?.kind === 'decline'
            ? 'deny'
            : chosenOpt?.kind === 'allow_always'
              ? 'allow_session'
              : 'allow_once';

      this.approvalCenterBridge.syncResolvedApproval({
        approvalId: record.approvalId,
        status: decision === 'deny' && status === 'approved' ? 'denied' : status,
        decision,
        resolvedBy,
        comment: input?.comment ?? record.terminalReason ?? null,
      });
    } catch {
      // isolate legacy bridge sync failures
    }
  }

  private publishRequestChanged(
    record: InternalPendingNativeRequestRecord,
    mutationKey: string,
  ): void {
    if (record.receiptState !== 'pending' && record.receiptState !== 'claimed') {
      try {
        this.onRequestSettled?.(record.binding, record.wireRequestId, record.receiptState, record.connectionId);
      } catch {
        // The wire reply and its receipt remain authoritative if an observer fails.
      }
    }
    try {
      this.registry.commitAndPublish(
        record.binding,
        {},
        {
          type: 'native.request.changed',
          turnId: record.turnId,
          payload: {
            approvalId: record.approvalId,
            ...(record.agentId ? { targetAgentId: record.agentId } : {}),
            ...(record.activityId ? { activityId: record.activityId } : {}),
            receiptId: record.receiptId,
            receiptState: record.receiptState,
            kind: record.kind,
          },
          mutationKey,
          createdAt: record.updatedAt,
        },
      );
    } catch {
      // Stale generation or disconnected binding writes are fenced cleanly by NativeRuntimeStore
    }
  }

  private clearRecordTimer(record: InternalPendingNativeRequestRecord): void {
    if (record.timer !== undefined) {
      this.clearTimer(record.timer);
      record.timer = undefined;
    }
  }
}
