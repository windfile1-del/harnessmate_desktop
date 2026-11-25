import crypto from 'node:crypto';
import path from 'node:path';
import { EvidenceSchema } from '@harnessmate/protocol';
import type {
  BindingGeneration,
  Evidence,
  NativeRuntimeStatus,
  NativeWork,
  Observed,
  RuntimeBinding,
  RuntimeId,
  WorkId,
  WorkState,
} from '@harnessmate/protocol';
import type { AgyNativeRuntimeRegistry } from '../wiring/registry.js';
import type { NativeIngress } from '../wiring/types.js';
import { AgyRecoveryHistorySource } from './history-source.js';
import {
  evaluateCliVersionCompatibility,
  negotiateAcpProtocol,
  selectAttachStrategy,
  type NegotiateAcpProtocolResult,
} from './protocol-adapter.js';
import {
  DEFAULT_AGY_NATIVE_RECOVERY_CONFIG,
  type AgyNativeRecoveryConfig,
  type AttachStrategyDecision,
  type CliVersionCompatProfile,
  type CompatIncidentRecord,
  type CrashRecoveryRecord,
  type FreshScheduleOccurrenceEvidence,
  type NativeScheduleRecoveryPort,
  type ParsedAcpInitializeCapabilities,
  type PersistedScheduleOccurrenceInput,
  type ReconciledScheduleOccurrence,
  type RecoverableJobEvidence,
  type RecoveryBindingGuardInput,
  type RecoveryGuardResult,
  type RecoveryPhase,
  type RecoveryReasonCode,
  type RecoveryStatusSummaryDto,
} from './types.js';

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.generation === b.generation &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId
  );
}

function normalizeWorkspacePath(input: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(input.trim());
  const forward = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? forward.toLowerCase() : forward;
}

interface ActiveConnectionState {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly nativeSessionId: string;
  readonly attemptOrdinal: number;
  readonly strategy: AttachStrategyDecision;
  readonly compat: CliVersionCompatProfile;
  readonly negotiated?: ParsedAcpInitializeCapabilities;
  inHistoryReplay: boolean;
  attachedAt: number;
  lastSeenAt: number;
}

export interface AgyNativeRecoveryServiceOptions {
  readonly registry: AgyNativeRuntimeRegistry;
  readonly config?: Partial<AgyNativeRecoveryConfig>;
  readonly historySource?: AgyRecoveryHistorySource;
  readonly now?: () => number;
  readonly bootId?: string;
}

/**
 * NP-15 Session Recovery & Protocol Compatibility Coordinator.
 *
 * Implements:
 * - Startup crash/reboot reconciliation (strictly behind `activeReconcileEnabled` & schema compatibility gates)
 * - Immutable binding / profile / source / revision / workspace / auth guards (never triggers auto-login)
 * - Same-generation connection replacement & out-of-order attach fencing
 * - Old-generation fencing & late-frame/late-response isolation
 * - Workflow control gating while `reconciling` or in `history_replay`
 * - Evidence-backed native job continuation assessment (never claims cross-process daemon survival without proof)
 * - NP-12 `NativeScheduleRecoveryPort` schedule occurrence reconciliation & cross-generation deduplication
 * - NP-03-aligned `RecoveryStatusSummaryDto` projection
 */
export class AgyNativeRecoveryService implements NativeScheduleRecoveryPort {
  private readonly registry: AgyNativeRuntimeRegistry;
  private config: AgyNativeRecoveryConfig;
  private readonly historySource: AgyRecoveryHistorySource;
  private readonly nowFn: () => number;
  private readonly bootId: string;

  private readonly activeConnectionsBySession = new Map<string, ActiveConnectionState>();
  private readonly retiredConnectionsBySession = new Map<string, Set<string>>();
  private readonly attachAttemptOrdinalBySession = new Map<string, number>();
  private readonly reconcilingSessions = new Map<string, { reasonCode: RecoveryReasonCode; since: number }>();
  private readonly invalidatedGenerationsByRuntime = new Map<RuntimeId, BindingGeneration[]>();
  private readonly lastSeenAtByRuntime = new Map<RuntimeId, number>();
  private readonly invalidatedApprovalsByRuntime = new Map<RuntimeId, Set<string>>();
  private readonly deliveryUnknownReceiptsByRuntime = new Map<RuntimeId, Set<string>>();
  private readonly uncertainEntitiesByRuntime = new Map<RuntimeId, Set<string>>();

  private readonly crashRecords: CrashRecoveryRecord[] = [];
  private readonly compatIncidents: CompatIncidentRecord[] = [];

  constructor(opts: AgyNativeRecoveryServiceOptions) {
    this.registry = opts.registry;
    this.config = Object.freeze({
      ...DEFAULT_AGY_NATIVE_RECOVERY_CONFIG,
      ...opts.config,
    });
    this.nowFn = opts.now ?? (() => Date.now());
    this.historySource =
      opts.historySource ??
      new AgyRecoveryHistorySource({
        maxHistoryReplayFrames: this.config.maxHistoryReplayFrames,
        now: this.nowFn,
      });
    this.bootId = opts.bootId ?? `boot_${crypto.randomBytes(4).toString('hex')}`;
  }

  getConfig(): Readonly<AgyNativeRecoveryConfig> {
    return this.config;
  }

  setActiveReconcileEnabled(enabled: boolean): Readonly<AgyNativeRecoveryConfig> {
    this.config = Object.freeze({
      ...this.config,
      activeReconcileEnabled: enabled,
    });
    return this.config;
  }

  updateConfig(patch: Partial<AgyNativeRecoveryConfig>): Readonly<AgyNativeRecoveryConfig> {
    this.config = Object.freeze({
      ...this.config,
      ...patch,
    });
    return this.config;
  }

  getHistorySource(): AgyRecoveryHistorySource {
    return this.historySource;
  }

  listCrashRecords(): readonly CrashRecoveryRecord[] {
    return [...this.crashRecords];
  }

  listCompatIncidents(): readonly CompatIncidentRecord[] {
    return [...this.compatIncidents];
  }

  // ── 1. Daemon Startup Reconciliation ─────────────────────────────────

  reconcileOnDaemonStartup(opts?: {
    readonly sessionScopes?: ReadonlyArray<{ readonly sessionId: string; readonly instanceId: string }>;
    readonly trigger?: 'daemon_startup' | 'windows_reboot';
  }): {
    readonly skipped: boolean;
    readonly reasonCode: RecoveryReasonCode;
    readonly reconciledBindings: number;
    readonly emittedRecoveryEvents: number;
  } {
    const schemaStatus = this.registry.getSchemaStatus();
    if (!schemaStatus.compatible) {
      this.recordCompatIncident({
        category: 'schema_newer_than_reader',
        reasonCode: 'native_schema_newer_than_reader',
        summary: `Stored agy-native-runtime schema v${schemaStatus.storedVersion} > supported v${schemaStatus.supportedVersion}; native recovery closed while legacy reads stay intact.`,
      });
      return {
        skipped: true,
        reasonCode: 'native_schema_newer_than_reader',
        reconciledBindings: 0,
        emittedRecoveryEvents: 0,
      };
    }

    if (!this.config.activeReconcileEnabled) {
      return {
        skipped: true,
        reasonCode: 'active_reconcile_disabled',
        reconciledBindings: 0,
        emittedRecoveryEvents: 0,
      };
    }

    const trigger = opts?.trigger ?? 'daemon_startup';
    const reasonCode: RecoveryReasonCode =
      trigger === 'windows_reboot' ? 'windows_reboot_recovery' : 'daemon_startup_reconcile';

    // Capture previously-attached bindings for supplied session scopes before marking reconciling
    const previouslyAttached: Array<{
      binding: RuntimeBinding;
      uncertainEntityIds: string[];
      pendingApprovals: string[];
    }> = [];

    for (const scope of opts?.sessionScopes ?? []) {
      const stored = this.registry.persistence.getLatestBindingForSession(
        scope.sessionId,
        scope.instanceId,
      );
      if (stored && stored.status === 'attached') {
        const proj = this.registry.persistence.readProjection(stored.runtimeId, {
          enabled: true,
          nowMs: this.nowFn(),
        });
        const uncertainEntityIds: string[] = [];
        for (const act of proj?.activities ?? []) {
          if (['starting', 'running', 'waiting_background', 'requires_action', 'cancelling'].includes(act.state)) {
            uncertainEntityIds.push(act.id);
          }
        }
        for (const work of proj?.work ?? []) {
          if (work.state.kind === 'known' && ['queued', 'running', 'waiting', 'requires_action'].includes(work.state.value)) {
            uncertainEntityIds.push(work.id);
          }
        }
        previouslyAttached.push({
          binding: {
            runtimeId: stored.runtimeId,
            sessionId: stored.sessionId,
            instanceId: stored.instanceId,
            generation: stored.generation,
          },
          uncertainEntityIds,
          pendingApprovals: [...(proj?.requestIds ?? [])],
        });
      }
    }

    const reconciledBindings =
      this.registry.persistence.markAttachedBindingsReconcilingOnStartup();

    let emittedRecoveryEvents = 0;
    const now = this.nowFn();

    for (const item of previouslyAttached) {
      this.reconcilingSessions.set(item.binding.sessionId, { reasonCode, since: now });
      this.addSetValues(this.uncertainEntitiesByRuntime, item.binding.runtimeId, item.uncertainEntityIds);
      this.addSetValues(this.invalidatedApprovalsByRuntime, item.binding.runtimeId, item.pendingApprovals);

      if (this.registry.isEnabled()) {
        try {
          this.registry.commitAndPublish(
            item.binding,
            { status: 'reconciling', retentionReasons: [] },
            {
              type: 'native.recovery.changed',
              turnId: null,
              mutationKey: `startup_reconcile:${this.bootId}:${item.binding.runtimeId}:${item.binding.generation}`,
              payload: {
                status: 'reconciling',
                invalidatedGenerations: [],
                uncertainEntityIds: item.uncertainEntityIds,
                reasonCode,
              },
            },
          );
          emittedRecoveryEvents += 1;
        } catch {
          // isolate if binding changed concurrently
        }
      }
    }

    if (reconciledBindings > 0 || previouslyAttached.length > 0) {
      this.recordCrash({
        trigger,
        invalidatedApprovalCount: previouslyAttached.reduce((acc, p) => acc + p.pendingApprovals.length, 0),
        deliveryUnknownCount: 0,
        uncertainEntityCount: previouslyAttached.reduce((acc, p) => acc + p.uncertainEntityIds.length, 0),
        reasonCode,
      });
    }

    return {
      skipped: false,
      reasonCode,
      reconciledBindings,
      emittedRecoveryEvents,
    };
  }

  // ── 2. Binding / Profile / Source / Revision / Workspace / Auth Guard ─

  evaluateBindingGuard(input: RecoveryBindingGuardInput): RecoveryGuardResult {
    // Never auto-trigger login when unauthenticated
    if (input.authState === 'unauthenticated') {
      return {
        allowed: false,
        reasonCode: 'auth_required_manual_login',
        requiresManualAttach: false,
        requiresManualAuth: true,
        details: 'Profile requires explicit user authentication via official AGY login path',
      };
    }

    if (
      input.stored.sessionId !== input.sessionId ||
      input.stored.instanceId !== input.instanceId
    ) {
      return {
        allowed: false,
        reasonCode: 'profile_or_source_mismatch',
        requiresManualAttach: true,
        requiresManualAuth: false,
        details: 'Session ID or instance ID does not match stored runtime binding',
      };
    }

    if (this.config.strictProfileGuard) {
      if (input.stored.profileRef !== input.profileRef || input.stored.sourceRef !== input.sourceRef) {
        return {
          allowed: false,
          reasonCode: 'profile_or_source_mismatch',
          requiresManualAttach: true,
          requiresManualAuth: false,
          details: `Immutable profile/source mismatch (${input.stored.profileRef}/${input.stored.sourceRef} != ${input.profileRef}/${input.sourceRef})`,
        };
      }
    }

    if (
      input.expectedBindingRevision !== undefined &&
      input.stored.bindingRevision !== input.expectedBindingRevision
    ) {
      return {
        allowed: false,
        reasonCode: 'binding_revision_mismatch',
        requiresManualAttach: true,
        requiresManualAuth: false,
        details: `Expected bindingRevision ${input.expectedBindingRevision}, got ${input.stored.bindingRevision}`,
      };
    }

    if (input.stored.workspaceRoot) {
      const platform = input.platform ?? process.platform;
      const expectedWs = normalizeWorkspacePath(input.stored.workspaceRoot, platform);
      const actualWs = normalizeWorkspacePath(input.workspaceRoot, platform);
      if (expectedWs !== actualWs) {
        return {
          allowed: false,
          reasonCode: 'workspace_scope_mismatch',
          requiresManualAttach: true,
          requiresManualAuth: false,
          details: 'Workspace root scope mismatch; refusing cross-workspace attach',
        };
      }
    }

    if (input.candidateNativeSessionId !== undefined && !input.candidateNativeSessionId) {
      return {
        allowed: false,
        reasonCode: 'native_session_id_missing',
        requiresManualAttach: true,
        requiresManualAuth: false,
        details: 'Confirmed native session ID is missing for attach/resume',
      };
    }

    return {
      allowed: true,
      requiresManualAttach: false,
      requiresManualAuth: false,
    };
  }

  // ── 3. Attach / Connection Replacement / Generation Fencing ──────────

  beginAttach(input: {
    readonly guard: RecoveryBindingGuardInput;
    readonly requestedProtocol?: 1 | 2;
    readonly initializeResult: unknown;
    readonly requireNativeResume?: boolean;
    readonly replayFromCursor?: string;
  }): {
    readonly attemptOrdinal: number;
    readonly allowed: boolean;
    readonly negotiation: NegotiateAcpProtocolResult;
    readonly guardResult: RecoveryGuardResult;
    readonly strategy: AttachStrategyDecision;
  } {
    const attemptOrdinal = (this.attachAttemptOrdinalBySession.get(input.guard.sessionId) ?? 0) + 1;
    this.attachAttemptOrdinalBySession.set(input.guard.sessionId, attemptOrdinal);

    const guardResult = this.evaluateBindingGuard(input.guard);
    const requestedProtocol = input.requestedProtocol ?? (this.config.allowV2Preview ? 2 : 1);
    const negotiation = negotiateAcpProtocol({
      requestedProtocol,
      allowV2Preview: this.config.allowV2Preview,
      initializeResult: input.initializeResult,
      quarantinedCliVersions: this.config.quarantinedCliVersions,
    });

    if (!negotiation.ok) {
      this.recordCompatIncident({
        category: 'protocol_negotiation',
        cliVersion: negotiation.cliVersion,
        requestedProtocol,
        negotiatedProtocol: typeof negotiation.observedProtocol === 'number' ? negotiation.observedProtocol : null,
        reasonCode: negotiation.reasonCode,
        summary: negotiation.message,
      });

      const strategy: AttachStrategyDecision = {
        mode: guardResult.requiresManualAuth ? 'auth_blocked' : 'manual_attach_only',
        channelDuringAttach: 'history_replay',
        willReplayHistory: false,
        allowsLiveApprovalsDuringAttach: false,
        allowsWorkflowControlDuringReconcile: false,
        reasonCode: guardResult.requiresManualAuth
          ? 'auth_required_manual_login'
          : negotiation.reasonCode,
      };
      return { attemptOrdinal, allowed: false, negotiation, guardResult, strategy };
    }

    if (negotiation.capabilities.downgradedFromV2) {
      this.recordCompatIncident({
        category: 'protocol_negotiation',
        cliVersion: negotiation.capabilities.cliVersion,
        requestedProtocol,
        negotiatedProtocol: negotiation.capabilities.negotiatedProtocol,
        reasonCode: 'v2_downgraded_to_v1',
        summary: 'Server negotiated ACP protocolVersion 1 after v2 preview request; fell back before prompt dispatch.',
      });
    }
    if (negotiation.compat.degradedToSafeMode) {
      this.recordCompatIncident({
        category: 'bad_cli_version',
        cliVersion: negotiation.compat.cliVersion,
        requestedProtocol,
        negotiatedProtocol: negotiation.capabilities.negotiatedProtocol,
        reasonCode: 'bad_cli_version_degraded',
        summary: negotiation.compat.notes,
      });
    }

    const strategy = selectAttachStrategy({
      negotiated: negotiation.capabilities,
      compat: negotiation.compat,
      hasNativeSessionId: Boolean(input.guard.candidateNativeSessionId),
      guard: guardResult,
      requireNativeResume: input.requireNativeResume,
      allowV2Preview: this.config.allowV2Preview,
      replayFromCursor: input.replayFromCursor,
    });

    // Gate workflow controls while reconciling/attaching
    this.reconcilingSessions.set(input.guard.sessionId, {
      reasonCode: strategy.reasonCode,
      since: this.nowFn(),
    });

    return {
      attemptOrdinal,
      allowed:
        guardResult.allowed &&
        strategy.mode !== 'manual_attach_only' &&
        strategy.mode !== 'auth_blocked',
      negotiation,
      guardResult,
      strategy,
    };
  }

  completeAttach(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly attemptOrdinal: number;
    readonly nativeSessionId: string;
    readonly strategy: AttachStrategyDecision;
    readonly compat: CliVersionCompatProfile;
    readonly negotiated?: ParsedAcpInitializeCapabilities;
  }): {
    readonly accepted: boolean;
    readonly reasonCode: RecoveryReasonCode;
    readonly replacedConnectionId?: string;
    readonly invalidatedGenerations: readonly BindingGeneration[];
  } {
    const latestOrdinal = this.attachAttemptOrdinalBySession.get(input.binding.sessionId) ?? 0;
    if (input.attemptOrdinal < latestOrdinal) {
      return {
        accepted: false,
        reasonCode: 'out_of_order_attach_discarded',
        invalidatedGenerations: [],
      };
    }

    const schemaStatus = this.registry.getSchemaStatus();
    if (!schemaStatus.compatible) {
      return {
        accepted: false,
        reasonCode: 'native_schema_newer_than_reader',
        invalidatedGenerations: [],
      };
    }

    const stored = this.registry.persistence.getBinding(input.binding.runtimeId);
    const active = this.registry.getActiveBinding(input.binding.sessionId, input.binding.instanceId);
    if (
      !stored ||
      !active ||
      !sameBinding(active, input.binding) ||
      stored.generation !== input.binding.generation
    ) {
      return {
        accepted: false,
        reasonCode: 'generation_retired',
        invalidatedGenerations: [],
      };
    }

    const now = this.nowFn();
    const prev = this.activeConnectionsBySession.get(input.binding.sessionId);
    let replacedConnectionId: string | undefined;
    const invalidatedGenerations: BindingGeneration[] = [];

    if (prev && prev.connectionId !== input.connectionId) {
      // Retire previous connection BEFORE activating replacement (G3-04 same-gen / cross-gen fence)
      let retiredSet = this.retiredConnectionsBySession.get(input.binding.sessionId);
      if (!retiredSet) {
        retiredSet = new Set();
        this.retiredConnectionsBySession.set(input.binding.sessionId, retiredSet);
      }
      retiredSet.add(prev.connectionId);
      replacedConnectionId = prev.connectionId;

      if (prev.binding.generation !== input.binding.generation) {
        invalidatedGenerations.push(prev.binding.generation);
        const list = this.invalidatedGenerationsByRuntime.get(input.binding.runtimeId) ?? [];
        if (!list.includes(prev.binding.generation)) list.push(prev.binding.generation);
        this.invalidatedGenerationsByRuntime.set(input.binding.runtimeId, list);
      } else {
        // Same-generation connection replacement: invalidate prior pending approvals so stale conn cannot resolve
        const inv = this.registry.persistence.invalidateApprovalReceiptsForRuntime(
          input.binding.runtimeId,
          input.binding.generation,
        );
        this.recordCrash({
          trigger: 'connection_replaced',
          runtimeId: input.binding.runtimeId,
          generation: input.binding.generation,
          invalidatedApprovalCount: inv.lostCount,
          deliveryUnknownCount: inv.unknownCount,
          uncertainEntityCount: 0,
          reasonCode: 'connection_replaced_same_generation',
        });
      }
    }

    const inHistoryReplay = input.strategy.willReplayHistory;
    this.activeConnectionsBySession.set(input.binding.sessionId, {
      binding: input.binding,
      connectionId: input.connectionId,
      nativeSessionId: input.nativeSessionId,
      attemptOrdinal: input.attemptOrdinal,
      strategy: input.strategy,
      compat: input.compat,
      negotiated: input.negotiated,
      inHistoryReplay,
      attachedAt: now,
      lastSeenAt: now,
    });
    this.lastSeenAtByRuntime.set(input.binding.runtimeId, now);

    if (!inHistoryReplay) {
      this.reconcilingSessions.delete(input.binding.sessionId);
    }

    if (this.config.activeReconcileEnabled && this.registry.isEnabled()) {
      const targetStatus: NativeRuntimeStatus = inHistoryReplay ? 'reconciling' : 'attached';
      this.registry.commitAndPublish(
        input.binding,
        { status: targetStatus },
        {
          type: 'native.recovery.changed',
          turnId: null,
          mutationKey: `attach:${input.binding.runtimeId}:${input.binding.generation}:${input.connectionId}`,
          payload: {
            status: targetStatus,
            invalidatedGenerations,
            uncertainEntityIds: [],
            reasonCode: input.strategy.reasonCode,
          },
        },
      );
    }

    return {
      accepted: true,
      reasonCode: input.strategy.reasonCode,
      ...(replacedConnectionId ? { replacedConnectionId } : {}),
      invalidatedGenerations,
    };
  }

  markHistoryReplayFinished(binding: RuntimeBinding, connectionId: string): boolean {
    const active = this.activeConnectionsBySession.get(binding.sessionId);
    if (!active || !sameBinding(active.binding, binding) || active.connectionId !== connectionId) {
      return false;
    }
    active.inHistoryReplay = false;
    active.lastSeenAt = this.nowFn();
    this.lastSeenAtByRuntime.set(binding.runtimeId, active.lastSeenAt);
    this.reconcilingSessions.delete(binding.sessionId);

    if (this.config.activeReconcileEnabled && this.registry.isEnabled()) {
      this.registry.commitAndPublish(
        binding,
        { status: 'attached' },
        {
          type: 'native.runtime.changed',
          turnId: null,
          mutationKey: `replay_done:${binding.runtimeId}:${binding.generation}:${connectionId}`,
          payload: {
            status: 'attached',
            retentionReasons: [],
            revision: this.registry.persistence.getBinding(binding.runtimeId)?.asOfSeq ?? 0,
            reasonCode: 'replay_complete',
          },
        },
      );
    }
    return true;
  }

  /**
   * Validates whether an incoming frame/response may mutate live runtime state.
   * Rejects `history_replay` frames, retired same-gen connections, and stale generations.
   */
  acceptLiveIngressCheck(envelope: NativeIngress): {
    readonly accepted: boolean;
    readonly reasonCode?: RecoveryReasonCode;
  } {
    if (envelope.channel === 'history_replay') {
      return { accepted: false, reasonCode: 'history_replay_only' };
    }

    const retired = this.retiredConnectionsBySession.get(envelope.binding.sessionId);
    if (retired?.has(envelope.connectionId)) {
      return { accepted: false, reasonCode: 'connection_replaced_same_generation' };
    }

    const activeDbBinding = this.registry.getActiveBinding(
      envelope.binding.sessionId,
      envelope.binding.instanceId,
    );
    if (!activeDbBinding || !sameBinding(activeDbBinding, envelope.binding)) {
      return { accepted: false, reasonCode: 'generation_retired' };
    }

    const current = this.activeConnectionsBySession.get(envelope.binding.sessionId);
    if (!current || !sameBinding(current.binding, envelope.binding)) {
      return { accepted: false, reasonCode: 'generation_retired' };
    }
    if (current.connectionId !== envelope.connectionId) {
      return { accepted: false, reasonCode: 'connection_replaced_same_generation' };
    }

    if (current.inHistoryReplay || this.reconcilingSessions.has(envelope.binding.sessionId)) {
      return { accepted: false, reasonCode: 'reconciling_control_gated' };
    }

    const now = this.nowFn();
    current.lastSeenAt = now;
    this.lastSeenAtByRuntime.set(envelope.binding.runtimeId, now);
    return { accepted: true };
  }

  handleTransportLost(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly trigger: 'process_crash' | 'network_disconnect' | 'windows_reboot' | 'transport_closed';
    readonly reasonCode?: RecoveryReasonCode;
    readonly knownApprovalIds?: readonly string[];
  }): {
    readonly applied: boolean;
    readonly ignoredStaleConnection: boolean;
    readonly status: NativeRuntimeStatus;
    readonly invalidatedApprovals: number;
    readonly deliveryUnknownReceipts: number;
    readonly uncertainEntityIds: readonly string[];
  } {
    const retired = this.retiredConnectionsBySession.get(input.binding.sessionId);
    const active = this.activeConnectionsBySession.get(input.binding.sessionId);

    // G3-04 guard: late close from a retired connection MUST NOT clobber replacement connection
    if (
      retired?.has(input.connectionId) ||
      (active && active.connectionId !== input.connectionId)
    ) {
      return {
        applied: false,
        ignoredStaleConnection: true,
        status: active ? (active.inHistoryReplay ? 'reconciling' : 'attached') : 'disconnected',
        invalidatedApprovals: 0,
        deliveryUnknownReceipts: 0,
        uncertainEntityIds: [],
      };
    }

    if (active && sameBinding(active.binding, input.binding) && active.connectionId === input.connectionId) {
      let set = this.retiredConnectionsBySession.get(input.binding.sessionId);
      if (!set) {
        set = new Set();
        this.retiredConnectionsBySession.set(input.binding.sessionId, set);
      }
      set.add(input.connectionId);
      this.activeConnectionsBySession.delete(input.binding.sessionId);
    }

    const now = this.nowFn();
    const reasonCode: RecoveryReasonCode =
      input.reasonCode ??
      (input.trigger === 'process_crash'
        ? 'process_crash_detected'
        : input.trigger === 'network_disconnect'
          ? 'network_disconnect'
          : input.trigger === 'windows_reboot'
            ? 'windows_reboot_recovery'
            : 'transport_closed');

    const schemaStatus = this.registry.getSchemaStatus();
    if (!schemaStatus.compatible) {
      return {
        applied: false,
        ignoredStaleConnection: false,
        status: 'disconnected',
        invalidatedApprovals: 0,
        deliveryUnknownReceipts: 0,
        uncertainEntityIds: [],
      };
    }

    const stored = this.registry.persistence.getBinding(input.binding.runtimeId);
    if (!stored || stored.generation !== input.binding.generation) {
      return {
        applied: false,
        ignoredStaleConnection: true,
        status: 'disconnected',
        invalidatedApprovals: 0,
        deliveryUnknownReceipts: 0,
        uncertainEntityIds: [],
      };
    }

    const proj = this.registry.persistence.readProjection(input.binding.runtimeId, {
      enabled: true,
      nowMs: now,
    });
    const uncertainEntityIds: string[] = [];
    for (const act of proj?.activities ?? []) {
      if (['starting', 'running', 'waiting_background', 'requires_action', 'cancelling'].includes(act.state)) {
        uncertainEntityIds.push(act.id);
      }
    }
    for (const work of proj?.work ?? []) {
      if (work.state.kind === 'known' && ['queued', 'running', 'waiting', 'requires_action'].includes(work.state.value)) {
        uncertainEntityIds.push(work.id);
      }
    }

    const inv = this.registry.persistence.invalidateApprovalReceiptsForRuntime(
      input.binding.runtimeId,
      input.binding.generation,
    );
    this.addSetValues(this.uncertainEntitiesByRuntime, input.binding.runtimeId, uncertainEntityIds);
    this.addSetValues(this.invalidatedApprovalsByRuntime, input.binding.runtimeId, proj?.requestIds ?? []);
    for (const apprId of input.knownApprovalIds ?? []) {
      const receipt = this.registry.persistence.getApprovalReceiptByApprovalId(apprId);
      if (receipt?.state === 'delivery_unknown') {
        this.addSetValues(this.deliveryUnknownReceiptsByRuntime, input.binding.runtimeId, [receipt.receiptId]);
      } else if (receipt?.state === 'connection_lost') {
        this.addSetValues(this.invalidatedApprovalsByRuntime, input.binding.runtimeId, [apprId]);
      }
    }

    const nextStatus: NativeRuntimeStatus = this.config.activeReconcileEnabled
      ? 'reconciling'
      : 'disconnected';

    if (nextStatus === 'reconciling') {
      this.reconcilingSessions.set(input.binding.sessionId, { reasonCode, since: now });
    }

    if (this.config.activeReconcileEnabled && this.registry.isEnabled()) {
      try {
        this.registry.commitAndPublish(
          input.binding,
          { status: nextStatus, retentionReasons: [] },
          {
            type: 'native.recovery.changed',
            turnId: null,
            mutationKey: `lost:${input.binding.runtimeId}:${input.binding.generation}:${input.connectionId}`,
            payload: {
              status: nextStatus,
              invalidatedGenerations: [],
              uncertainEntityIds,
              reasonCode,
            },
          },
        );
      } catch {
        // binding may have been superseded concurrently
      }
    }

    this.recordCrash({
      trigger: input.trigger,
      runtimeId: input.binding.runtimeId,
      generation: input.binding.generation,
      invalidatedApprovalCount: inv.lostCount,
      deliveryUnknownCount: inv.unknownCount,
      uncertainEntityCount: uncertainEntityIds.length,
      reasonCode,
    });

    return {
      applied: true,
      ignoredStaleConnection: false,
      status: nextStatus,
      invalidatedApprovals: inv.lostCount,
      deliveryUnknownReceipts: inv.unknownCount,
      uncertainEntityIds,
    };
  }

  /**
   * Enforces workflow & command control gate during reconciling, replay, retired connections,
   * stale generations, or degraded bad CLI versions.
   */
  isWorkflowControlAllowed(
    binding: RuntimeBinding,
    connectionId?: string,
  ): { readonly allowed: boolean; readonly reasonCode?: RecoveryReasonCode } {
    const active = this.activeConnectionsBySession.get(binding.sessionId);
    if (!active) {
      return {
        allowed: false,
        reasonCode: this.reconcilingSessions.has(binding.sessionId)
          ? 'reconciling_control_gated'
          : 'transport_closed',
      };
    }
    const activeDbBinding = this.registry.getActiveBinding(binding.sessionId, binding.instanceId);
    if (!activeDbBinding || !sameBinding(activeDbBinding, binding)) {
      return { allowed: false, reasonCode: 'generation_retired' };
    }
    if (!sameBinding(active.binding, binding)) {
      return { allowed: false, reasonCode: 'generation_retired' };
    }
    if (connectionId && active.connectionId !== connectionId) {
      return { allowed: false, reasonCode: 'connection_replaced_same_generation' };
    }
    if (active.inHistoryReplay || this.reconcilingSessions.has(binding.sessionId)) {
      return { allowed: false, reasonCode: 'reconciling_control_gated' };
    }
    if (active.compat.degradedToSafeMode) {
      return { allowed: false, reasonCode: 'bad_cli_version_degraded' };
    }
    return { allowed: true };
  }

  // ── 4. Native Job Continuation & NP-12 Schedule/Occurrence Interop ───

  /**
   * Evaluates whether prior native jobs (finite or daemon) are genuinely continuable.
   * NEVER assumes cross-process survival without fresh `live_protocol` or non-stale `native_snapshot` proof!
   */
  evaluateNativeJobContinuation(input: {
    readonly priorWorks: readonly NativeWork[];
    readonly freshEvidenceByWorkId: ReadonlyMap<WorkId, Evidence>;
    readonly hasLiveConnection: boolean;
    readonly nowMs?: number;
  }): readonly RecoverableJobEvidence[] {
    const now = input.nowMs ?? this.nowFn();
    return input.priorWorks.map((work) => {
      if (work.state.kind === 'known' && ['finished', 'failed', 'cancelled'].includes(work.state.value)) {
        return {
          workId: work.id,
          kind: work.kind,
          continuationState: 'not_continuable',
          evidenceSource: 'prior_generation_only',
          reasonCode: 'no_live_continuation_evidence',
          lastObservedAt: work.state.evidence.observedAt,
        };
      }

      const fresh = input.freshEvidenceByWorkId.get(work.id);
      if (fresh?.kind === 'live_protocol' && input.hasLiveConnection) {
        return {
          workId: work.id,
          kind: work.kind,
          continuationState: 'confirmed_continuable',
          evidenceSource: 'live_protocol',
          reasonCode: 'v1_resume_attached',
          lastObservedAt: fresh.observedAt,
        };
      }

      if (fresh?.kind === 'native_snapshot' && now < fresh.staleAt) {
        return {
          workId: work.id,
          kind: work.kind,
          continuationState: 'confirmed_continuable',
          evidenceSource: 'native_snapshot',
          reasonCode: 'v1_resume_attached',
          lastObservedAt: fresh.observedAt,
        };
      }

      const priorObservedAt =
        work.state.kind === 'known'
          ? work.state.evidence.observedAt
          : work.state.kind === 'stale'
            ? work.state.evidence?.observedAt ?? null
            : null;

      return {
        workId: work.id,
        kind: work.kind,
        continuationState: 'stale_needs_evidence',
        evidenceSource: 'prior_generation_only',
        reasonCode: 'no_live_continuation_evidence',
        lastObservedAt: priorObservedAt,
      };
    });
  }

  /**
   * NP-12 NativeScheduleRecoveryPort:
   * - Deduplicates schedule occurrences across generations by the pair of native IDs
   * - Keeps independent occurrence -> workId linkage intact
   * - Applies fresh live/snapshot evidence when available, else marks `stale_unverified` honestly
   * - Never routes native schedules into HM scheduler
   */
  reconcileScheduleOccurrences(input: {
    readonly binding: RuntimeBinding;
    readonly persistedOccurrences: readonly PersistedScheduleOccurrenceInput[];
    readonly freshEvidence: readonly FreshScheduleOccurrenceEvidence[];
    readonly nowMs?: number;
  }): {
    readonly occurrences: readonly ReconciledScheduleOccurrence[];
    readonly deduplicatedCount: number;
    readonly unverifiedCount: number;
    readonly nextAt?: Observed<number>;
  } {
    const now = input.nowMs ?? this.nowFn();
    const active = this.activeConnectionsBySession.get(input.binding.sessionId);
    const canUseLiveEvidence = active && sameBinding(active.binding, input.binding) &&
      !active.inHistoryReplay && !this.reconcilingSessions.has(input.binding.sessionId) &&
      this.registry.isActiveBinding(input.binding);
    const freshByKey = new Map<string, { observation: FreshScheduleOccurrenceEvidence; evidence: Evidence }>();
    for (const observation of input.freshEvidence) {
      if (observation.source === 'live_protocol' &&
          (!canUseLiveEvidence || observation.connectionId !== active.connectionId)) continue;
      const parsed = EvidenceSchema.safeParse(observation.source === 'live_protocol'
        ? {
            kind: 'live_protocol',
            connectionId: observation.connectionId,
            ingressOrdinal: observation.ingressOrdinal,
            wireVariant: observation.wireVariant,
            observedAt: observation.observedAt,
          }
        : {
            kind: 'native_snapshot',
            sourceId: observation.sourceId,
            schemaVersion: observation.schemaVersion,
            observedAt: observation.observedAt,
            staleAt: observation.staleAt,
          });
      if (!parsed.success || observation.observedAt > now ||
          (parsed.data.kind === 'native_snapshot' && now >= parsed.data.staleAt)) continue;
      const key = JSON.stringify([observation.scheduleNativeId, observation.occurrenceId]);
      const prev = freshByKey.get(key);
      if (!prev || observation.observedAt >= prev.observation.observedAt) {
        freshByKey.set(key, { observation, evidence: parsed.data });
      }
    }

    const deduped = new Map<string, PersistedScheduleOccurrenceInput>();
    let deduplicatedCount = 0;
    for (const item of input.persistedOccurrences) {
      const key = JSON.stringify([item.scheduleNativeId, item.occurrenceId]);
      const existing = deduped.get(key);
      if (existing) {
        deduplicatedCount += 1;
        const itemIsCurrent = item.originGeneration === input.binding.generation;
        const existingIsCurrent = existing.originGeneration === input.binding.generation;
        if (itemIsCurrent !== existingIsCurrent ? itemIsCurrent :
            (item.lastObservedAt ?? 0) >= (existing.lastObservedAt ?? 0)) {
          deduped.set(key, item);
        }
      } else {
        deduped.set(key, item);
      }
    }

    const occurrences: ReconciledScheduleOccurrence[] = [];
    let unverifiedCount = 0;
    let earliestNextAt: { value: number; evidence: Evidence } | undefined;

    for (const [dedupeKey, occ] of deduped.entries()) {
      const freshMatch = freshByKey.get(dedupeKey);
      const deduplicatedAcrossGenerations = occ.originGeneration !== input.binding.generation;

      if (freshMatch) {
        const { observation: fresh, evidence } = freshMatch;
        const status =
          fresh.state === 'finished'
            ? 'fired_observed'
            : fresh.state === 'cancelled'
              ? 'cancelled_observed'
              : 'confirmed_active';

        if (fresh.nextAt !== undefined && (!earliestNextAt || fresh.nextAt < earliestNextAt.value)) {
          earliestNextAt = { value: fresh.nextAt, evidence };
        }

        occurrences.push({
          dedupeKey,
          workflowId: occ.workflowId,
          workId: occ.workId,
          occurrenceId: occ.occurrenceId,
          status,
          observedState: { kind: 'known', value: fresh.state, evidence },
          statusSource: fresh.source,
          deduplicatedAcrossGenerations,
          originGeneration: occ.originGeneration,
          reconciledGeneration: input.binding.generation,
          reasonCode: 'v1_resume_attached',
        });
        continue;
      }

      // Missing or expired evidence: remain strictly honest (`stale_unverified`)
      unverifiedCount += 1;
      occurrences.push({
        dedupeKey,
        workflowId: occ.workflowId,
        workId: occ.workId,
        occurrenceId: occ.occurrenceId,
        status: 'stale_unverified',
        observedState: {
          kind: 'stale',
          last: occ.lastState,
          reasonCode: 'schedule_occurrence_unverified',
        },
        statusSource: 'prior_generation_only',
        deduplicatedAcrossGenerations,
        originGeneration: occ.originGeneration,
        reconciledGeneration: input.binding.generation,
        reasonCode: 'schedule_occurrence_unverified',
      });
    }

    const nextAt: Observed<number> | undefined = earliestNextAt
      ? { kind: 'known', value: earliestNextAt.value, evidence: earliestNextAt.evidence }
      : occurrences.length > 0
        ? { kind: 'unknown', reasonCode: 'schedule_occurrence_unverified' }
        : undefined;

    return {
      occurrences,
      deduplicatedCount,
      unverifiedCount,
      ...(nextAt ? { nextAt } : {}),
    };
  }

  // ── 5. UI Selector Summary (Aligned with NP-03 Shared Selectors) ────

  buildRecoveryStatusSummary(input: {
    readonly sessionId: string;
    readonly instanceId: string;
    readonly authState?: 'authenticated' | 'unauthenticated' | 'unknown';
    readonly freshEvidenceByWorkId?: ReadonlyMap<WorkId, Evidence>;
    readonly indexedHistoryAvailable?: boolean;
    readonly nowMs?: number;
  }): RecoveryStatusSummaryDto | null {
    const schemaStatus = this.registry.getSchemaStatus();
    if (!schemaStatus.compatible) {
      return null;
    }

    const stored = this.registry.persistence.getLatestBindingForSession(
      input.sessionId,
      input.instanceId,
    );
    if (!stored) return null;

    const binding: RuntimeBinding = {
      runtimeId: stored.runtimeId,
      sessionId: stored.sessionId,
      instanceId: stored.instanceId,
      generation: stored.generation,
    };
    const now = input.nowMs ?? this.nowFn();
    const activeConn = this.activeConnectionsBySession.get(input.sessionId);
    const hasLiveConnection = Boolean(activeConn && sameBinding(activeConn.binding, binding));
    const proj = this.registry.persistence.readProjection(stored.runtimeId, { enabled: true, nowMs: now });

    const recoverableJobs = this.evaluateNativeJobContinuation({
      priorWorks: (proj?.work ?? []).map((w) => ({
        id: w.id,
        kind: w.kind,
        originActivityId: w.originActivityId,
        ownerAgentId: w.ownerAgentId,
        workflowId: w.workflowId,
        blocking: w.blocking,
        state:
          w.state.kind === 'known'
            ? {
                kind: 'known',
                value: w.state.value,
                evidence: {
                  kind: 'host_observation',
                  observedAt: w.state.evidence.observedAt,
                  reasonCode: w.state.evidence.reasonCode ?? 'persisted_projection',
                },
              }
            : w.state.kind === 'stale'
              ? {
                  kind: 'stale',
                  last: w.state.last,
                  reasonCode: w.state.reasonCode,
                }
              : {
                  kind: 'unknown',
                  reasonCode: w.state.reasonCode,
                },
        observedLabel: w.observedLabel,
        revision: w.revision,
      })),
      freshEvidenceByWorkId: input.freshEvidenceByWorkId ?? new Map(),
      hasLiveConnection,
      nowMs: now,
    });

    const reconcilingInfo = this.reconcilingSessions.get(input.sessionId);
    const invalidatedApprovals = Array.from(
      this.invalidatedApprovalsByRuntime.get(stored.runtimeId) ?? [],
    );
    const deliveryUnknownReceipts = Array.from(
      this.deliveryUnknownReceiptsByRuntime.get(stored.runtimeId) ?? [],
    );
    const uncertainEntityIds = Array.from(
      this.uncertainEntitiesByRuntime.get(stored.runtimeId) ?? [],
    );

    let recoveryPhase: RecoveryPhase;
    let reasonCode: RecoveryReasonCode;
    let manualActionHint: string | undefined;

    if (input.authState === 'unauthenticated') {
      recoveryPhase = 'auth_required';
      reasonCode = 'auth_required_manual_login';
      manualActionHint = '请通过官方 AGY 登录流程完成授权后再手动接入';
    } else if (hasLiveConnection && activeConn && !activeConn.inHistoryReplay) {
      recoveryPhase = 'attached';
      reasonCode = activeConn.strategy.reasonCode;
    } else if (stored.status === 'reconciling' || reconcilingInfo) {
      recoveryPhase = 'reconciling';
      reasonCode = reconcilingInfo?.reasonCode ?? 'daemon_startup_reconcile';
      manualActionHint = '连接恢复与状态校准中，当前仅可读取历史记录';
    } else if (!this.config.activeReconcileEnabled) {
      recoveryPhase = 'read_only_history';
      reasonCode = 'active_reconcile_disabled';
      manualActionHint = '主动恢复已关闭，原生历史记录维持只读保留';
    } else if (recoverableJobs.some((j) => j.continuationState === 'confirmed_continuable')) {
      recoveryPhase = 'recoverable';
      reasonCode = 'v1_resume_attached';
    } else {
      recoveryPhase = 'manual_attach_required';
      reasonCode = 'no_live_continuation_evidence';
      manualActionHint = '未证实后台任务继续存活，请按需手动接入或查看只读历史';
    }

    const historyReadSource: RecoveryStatusSummaryDto['historyReadSource'] =
      stored.asOfSeq > 0
        ? 'native_feed'
        : input.indexedHistoryAvailable
          ? 'indexed_sqlite'
          : activeConn?.strategy.willReplayHistory
            ? 'session_load_replay'
            : 'none';

    return {
      binding,
      asOfSeq: stored.asOfSeq,
      runtimeStatus: stored.status,
      recoveryPhase,
      lastSeenAt: this.lastSeenAtByRuntime.get(stored.runtimeId) ?? stored.updatedAt ?? null,
      invalidatedApprovalIds: invalidatedApprovals,
      deliveryUnknownReceiptIds: deliveryUnknownReceipts,
      uncertainEntityIds,
      recoverableJobs,
      historyReadPathAvailable: historyReadSource !== 'none',
      historyReadSource,
      autoLoginTriggered: false,
      ...(manualActionHint ? { manualActionHint } : {}),
      reasonCode,
    };
  }

  // ── Internal Audit Helpers ───────────────────────────────────────────

  private addSetValues(map: Map<RuntimeId, Set<string>>, runtimeId: RuntimeId, values: readonly string[]): void {
    if (values.length === 0) return;
    let set = map.get(runtimeId);
    if (!set) {
      set = new Set();
      map.set(runtimeId, set);
    }
    for (const v of values) set.add(v);
  }

  private recordCrash(input: Omit<CrashRecoveryRecord, 'recordId' | 'recordedAt'>): void {
    this.crashRecords.push({
      recordId: `crash_${crypto.randomBytes(4).toString('hex')}`,
      recordedAt: this.nowFn(),
      ...input,
    });
    if (this.crashRecords.length > this.config.maxRecoveryAuditRecords) {
      this.crashRecords.splice(0, this.crashRecords.length - this.config.maxRecoveryAuditRecords);
    }
  }

  private recordCompatIncident(input: Omit<CompatIncidentRecord, 'incidentId' | 'recordedAt'>): void {
    this.compatIncidents.push({
      incidentId: `compat_${crypto.randomBytes(4).toString('hex')}`,
      recordedAt: this.nowFn(),
      ...input,
    });
    if (this.compatIncidents.length > this.config.maxRecoveryAuditRecords) {
      this.compatIncidents.splice(0, this.compatIncidents.length - this.config.maxRecoveryAuditRecords);
    }
  }
}
