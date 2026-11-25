import crypto from 'node:crypto';
import {
  AGY_NATIVE_CONTRACT_VERSION,
  NativeCommandRequestSchema,
  NativeCommandResponseSchema,
  NativeControlRequestSchema,
  NativeControlResponseSchema,
  asActivityId,
  type ActivityId,
  type Attachment,
  type CapabilityDescriptor,
  type NativeApiErrorCode,
  type NativeCommandRequest,
  type NativeCommandResponse,
  type NativeControlRequest,
  type NativeControlResponse,
  type PermissionMode,
  type ReasoningEffort,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import {
  AgyConsumerProvenanceError,
  assertAgyConsumerProvenance,
  mintAgyDispatchProvenance,
  type AgyDispatchProvenance,
  type AgyTargetDescriptor,
} from '../wiring/provenance.js';
import type { NativeCommandRouterPort } from '../wiring/types.js';
import type {
  AgyNativeCommandCatalogService,
  BindingCatalogSnapshot,
} from './catalog.js';
import type { NativeCommandActionMetadata, NativeCommandArgSpec } from './descriptors.js';

export class NativeCommandRouterError extends Error {
  readonly code: NativeApiErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: NativeApiErrorCode,
    statusCode: number,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'NativeCommandRouterError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface LiveWorkflowDispatchInput {
  readonly binding: RuntimeBinding;
  readonly receiptId: string;
  readonly capabilityId: string;
  readonly actionKey: string;
  /** Formatted slash command utterance (always placed before attachments). */
  readonly promptText: string;
  /** Ordered attachment IDs or attachment references preserved after slash text. */
  readonly attachmentIds: readonly string[];
  readonly attachments?: readonly Attachment[];
  readonly provenance: AgyDispatchProvenance;
}

export interface LiveWorkflowDispatchResult {
  readonly activityId?: ActivityId;
  readonly turnId?: string;
  readonly modeEvidenceObserved?: boolean;
}

export interface NativeConfigApplyInput {
  readonly binding: RuntimeBinding;
  readonly kind: 'model' | 'effort' | 'permission_mode';
  readonly value: string | null;
  readonly enforcement?: 'native' | 'client_guard';
}

export interface NativeConfigApplyResult {
  readonly applied: boolean;
  readonly effectiveScope: 'immediate' | 'next_turn' | 'read_only';
  readonly effectiveValue: string | null;
  readonly enforcement?: 'native' | 'client_guard';
  readonly note?: string;
}

export interface NativeQueryResult {
  readonly output: string;
  readonly summaryFields?: Record<string, string | number | boolean | null>;
}

export interface NativeManagerSnapshotData {
  readonly agentCount?: number;
  readonly activeWorkCount?: number;
  readonly daemonCount?: number;
  readonly workflowCount?: number;
  readonly swarmBoardAvailable?: boolean;
  readonly mcpGlobalPresent?: boolean;
  readonly tierName?: string | null;
  readonly summaryLines?: readonly string[];
}

export interface AgyNativeCommandRouterDeps {
  readonly catalog: AgyNativeCommandCatalogService;
  /** Resolve target descriptor for consumer OAuth provenance enforcement (Risk R-07). */
  readonly resolveTargetDescriptor?: (binding: RuntimeBinding) => AgyTargetDescriptor;
  /** Optional explicit provenance provider (defaults to verified `human_direct` when invoked via local routes). */
  readonly resolveDefaultProvenance?: (binding: RuntimeBinding) => AgyDispatchProvenance;
  /** Profile-scoped read-only `/usage` query (must NOT write conversation). */
  readonly queryUsage?: (binding: RuntimeBinding) => Promise<NativeQueryResult>;
  /** Profile-scoped read-only `/skills` query (must NOT write conversation). */
  readonly querySkills?: (
    binding: RuntimeBinding,
  ) => Promise<{ readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly enabled?: boolean }>; readonly output?: string }>;
  /** Applies validated live ACP session configuration (`/model`, `/effort`, `/permissions`, `/plan`). */
  readonly applySessionConfig?: (input: NativeConfigApplyInput) => Promise<NativeConfigApplyResult>;
  /** Dispatches a live native workflow utterance ONCE on the existing live ACP session. */
  readonly dispatchLiveWorkflow?: (
    input: LiveWorkflowDispatchInput,
  ) => Promise<LiveWorkflowDispatchResult>;
  /** Sends a live native cancel/stop signal on the active ACP connection. */
  readonly dispatchNativeCancel?: (input: {
    readonly binding: RuntimeBinding;
    readonly target: NativeControlRequest['target'];
    readonly action: string;
  }) => Promise<{
    readonly accepted: boolean;
    readonly state: NativeControlResponse['state'];
    readonly revision: number;
    readonly reasonCode?: string;
  }>;
  /** Optional read-only manager data provider (projection / ecosystem snapshot). */
  readonly readManagerSnapshot?: (
    binding: RuntimeBinding,
    managerKey: string,
  ) => Promise<NativeManagerSnapshotData | null> | NativeManagerSnapshotData | null;
  /** Optional feature gate checker for native workflow live routing. Defaults to true when router is mounted. */
  readonly isNativeWorkflowRoutingEnabled?: () => boolean;
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/[\]-]*$/;
const EFFORT_VALUES = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizePermissionModeInput(raw: string): PermissionMode | null {
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'default' || lowered === 'manual') return 'manual';
  if (lowered === 'plan') return 'plan';
  if (lowered === 'accept-edits' || lowered === 'accept_edits') return 'accept_edits';
  if (lowered === 'auto') return 'auto';
  return null;
}

function resolvePermissionEnforcement(
  mode: PermissionMode,
  advertisedModes: ReadonlyArray<{ readonly id: string; readonly name?: string }>,
): { readonly modeId: string; readonly enforcement: 'native' | 'client_guard' } {
  const requestedWireId =
    mode === 'manual' ? 'default' : mode === 'accept_edits' ? 'accept-edits' : mode;
  const exact = advertisedModes.find((m) => m.id === requestedWireId)?.id;
  if (exact) {
    return { modeId: exact, enforcement: 'native' };
  }
  if (mode === 'auto') {
    // Never fake native 'auto' support if not advertised by the runtime
    return {
      modeId: advertisedModes.find((m) => m.id === 'default')?.id ?? 'default',
      enforcement: 'client_guard',
    };
  }
  return {
    modeId: requestedWireId,
    enforcement: mode === 'plan' ? 'native' : 'client_guard',
  };
}

function validateArgsAgainstSpecs(
  args: Record<string, string | number | boolean | null | string[]>,
  specs: readonly NativeCommandArgSpec[] | undefined,
): void {
  if (!specs || specs.length === 0) return;

  for (const spec of specs) {
    const val = args[spec.name];
    if (val === undefined || val === null || val === '') {
      if (spec.required) {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Missing required parameter "${spec.name}" (${spec.description})`,
          { parameter: spec.name },
        );
      }
      continue;
    }

    if (spec.type === 'string') {
      if (typeof val !== 'string') {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" must be a string`,
          { parameter: spec.name },
        );
      }
      const trimmed = val.trim();
      if (spec.required && trimmed.length === 0) {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" cannot be blank`,
          { parameter: spec.name },
        );
      }
      if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" exceeds max length ${spec.maxLength}`,
          { parameter: spec.name },
        );
      }
      if (spec.pattern && !spec.pattern.test(trimmed)) {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" has invalid format`,
          { parameter: spec.name },
        );
      }
    } else if (spec.type === 'boolean') {
      if (typeof val !== 'boolean') {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" must be a boolean`,
          { parameter: spec.name },
        );
      }
    } else if (spec.type === 'string_array') {
      if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
        throw new NativeCommandRouterError(
          'INVALID_REQUEST',
          400,
          `Parameter "${spec.name}" must be a string array`,
          { parameter: spec.name },
        );
      }
    }
  }
}

function extractOrderedAttachmentIds(
  args: Record<string, string | number | boolean | null | string[]>,
): string[] {
  const raw = args.attachmentIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function formatLiveWorkflowPrompt(
  action: NativeCommandActionMetadata,
  args: Record<string, string | number | boolean | null | string[]>,
): string {
  const asText = (key: string): string => {
    const value = args[key];
    return typeof value === 'string' ? value.trim() : '';
  };

  switch (action.key) {
    case 'launch_goal':
      return `/goal ${asText('objective')}`.trim();
    case 'launch_swarm':
      return `/swarm ${asText('task')}`.trim();
    case 'launch_boost':
      return `/boost ${asText('task')}`.trim();
    case 'launch_teamwork':
      return `/teamwork ${asText('goal')}`.trim();
    case 'launch_dynamic_workflow':
      return `/run-workflow ${asText('task')}`.trim();
    case 'launch_schedule':
      return `/schedule ${asText('when')} ${asText('task')}`.trim();
    case 'launch_grill_me': {
      const topic = asText('topic');
      return topic ? `/grill-me ${topic}` : '/grill-me';
    }
    case 'run_compact':
      return '/compact';
    case 'invoke_skill': {
      const name = asText('name');
      const text = asText('text');
      return text ? `/${name} ${text}` : `/${name}`;
    }
    default: {
      const prefix = action.slashCommand?.trim();
      const text = asText('text') || asText('task') || asText('objective') || asText('goal');
      if (!prefix) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          `Live workflow action "${action.key}" has no verified slash command mapping`,
        );
      }
      return text ? `${prefix} ${text}` : prefix;
    }
  }
}

function mintActivityId(): ActivityId {
  return asActivityId(`act_cmd_${crypto.randomBytes(6).toString('hex')}`);
}

/**
 * AGY Native Command Router (NP-06) implementing `NativeCommandRouterPort`.
 *
 * Responsibilities:
 * - Single command execution authority across `query`, `config`, `live_workflow`, and `manager`.
 * - Enforces binding generation, catalog revision, capability gate, consumer OAuth user-direct
 *   provenance, profile/plan/permission constraints, and strict parameter validation.
 * - Routes interactive native workflows directly to the SAME live ACP session (once, preserving
 *   slash prefix + ordered attachments) so workflows NEVER fall back to final-only auxiliary CLI.
 * - Closes execution for unknown dynamically advertised slash commands.
 * - Leaves idempotent receipt claiming & duplicate replay to NP-02 shared wiring; returns only
 *   observed `kind: 'inspect' | 'accepted'` receipts.
 */
export class AgyNativeCommandRouter implements NativeCommandRouterPort {
  constructor(private readonly deps: AgyNativeCommandRouterDeps) {}

  getCapabilities(binding: RuntimeBinding): {
    readonly capabilitiesRevision: number;
    readonly descriptors: readonly CapabilityDescriptor[];
  } {
    return this.deps.catalog.getCapabilities(binding);
  }

  /**
   * Domain command execution with optional explicit provenance override for unit/integration tests.
   */
  async executeCommand(input: {
    readonly binding: RuntimeBinding;
    readonly request: NativeCommandRequest;
    readonly receiptId: string;
    readonly provenance?: unknown;
  }): Promise<NativeCommandResponse> {
    const parsedReq = NativeCommandRequestSchema.safeParse(input.request);
    if (!parsedReq.success) {
      throw new NativeCommandRouterError(
        'INVALID_REQUEST',
        400,
        parsedReq.error.issues[0]?.message ?? 'Invalid native command request',
      );
    }
    const req = parsedReq.data;

    // 1. Binding generation check
    if (req.bindingGeneration !== input.binding.generation) {
      throw new NativeCommandRouterError(
        'STALE_BINDING',
        409,
        'Binding generation does not match active runtime generation',
        { currentGeneration: input.binding.generation },
      );
    }

    // 2. Per-binding catalog revision check
    const snapshot = this.deps.catalog.getSnapshot(input.binding);
    if (req.catalogRevision !== snapshot.capabilitiesRevision) {
      throw new NativeCommandRouterError(
        'STALE_BINDING',
        409,
        'Capability catalog revision is stale; refresh capabilities before retrying',
        { currentCatalogRevision: snapshot.capabilitiesRevision },
      );
    }

    // 3. Consumer OAuth user-direct provenance verification (Risk R-07)
    const targetDescriptor: AgyTargetDescriptor = this.deps.resolveTargetDescriptor?.(
      input.binding,
    ) ?? {
      instanceId: input.binding.instanceId,
      driverId: 'agy',
      authMethod: snapshot.signals.authMethod ?? 'oauth-personal',
    };
    const effectiveProvenance =
      input.provenance !== undefined
        ? input.provenance
        : this.deps.resolveDefaultProvenance?.(input.binding) ??
          mintAgyDispatchProvenance('human_direct', 'desktop', 'AgyNativeCommandRouter.executeCommand');

    try {
      assertAgyConsumerProvenance(targetDescriptor, effectiveProvenance);
    } catch (err) {
      if (err instanceof AgyConsumerProvenanceError) {
        throw new NativeCommandRouterError('CONSUMER_PROVENANCE_BLOCKED', 403, err.message);
      }
      throw err;
    }

    // 4. Resolve descriptor & action gate (reject unknown dynamic slashes & closed gates)
    const canonicalId = this.deps.catalog.resolveCanonicalCapabilityId(req.capabilityId);
    const descriptor = snapshot.descriptors.find(
      (d) => d.id === req.capabilityId || d.id === canonicalId,
    );
    const actionDesc = descriptor?.actions.find((a) => a.key === req.actionKey);
    if (!descriptor || !actionDesc) {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        `Unknown capability "${req.capabilityId}" or action "${req.actionKey}"`,
      );
    }
    if (actionDesc.reasonCode === 'unknown_dynamic_slash_disabled') {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        'Unknown dynamically advertised slash commands are disabled for runtime execution',
        { reasonCode: 'unknown_dynamic_slash_disabled' },
      );
    }
    if (actionDesc.gate !== 'available') {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        `Action "${req.actionKey}" on "${descriptor.id}" is gated (${actionDesc.gate}${actionDesc.reasonCode ? `: ${actionDesc.reasonCode}` : ''})`,
        {
          gate: actionDesc.gate,
          ...(actionDesc.reasonCode ? { reasonCode: actionDesc.reasonCode } : {}),
        },
      );
    }

    const meta = this.deps.catalog.getActionMetadata(descriptor.id, req.actionKey);
    if (!meta) {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        `No verified metadata registered for "${descriptor.id}:${req.actionKey}"`,
      );
    }

    // 5. Parameter & arity validation
    validateArgsAgainstSpecs(req.args, meta.action.args);

    // 6. Dispatch by CommandLane
    let response: NativeCommandResponse;
    switch (actionDesc.lane) {
      case 'query':
        response = await this.handleQueryLane(input.binding, input.receiptId, meta.action);
        break;
      case 'config':
        response = await this.handleConfigLane(
          input.binding,
          input.receiptId,
          snapshot,
          meta.action,
          req.args,
          effectiveProvenance as AgyDispatchProvenance,
        );
        break;
      case 'live_workflow':
        response = await this.handleLiveWorkflowLane(
          input.binding,
          input.receiptId,
          snapshot,
          descriptor.id,
          meta.action,
          req.args,
          effectiveProvenance as AgyDispatchProvenance,
        );
        break;
      case 'manager':
        response = await this.handleManagerLane(
          input.binding,
          input.receiptId,
          snapshot,
          meta.action,
        );
        break;
    }

    return NativeCommandResponseSchema.parse(response);
  }

  async executeControl(input: {
    readonly binding: RuntimeBinding;
    readonly request: NativeControlRequest;
    readonly receiptId: string;
  }): Promise<NativeControlResponse> {
    const parsed = NativeControlRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new NativeCommandRouterError(
        'INVALID_REQUEST',
        400,
        parsed.error.issues[0]?.message ?? 'Invalid native control request',
      );
    }
    const req = parsed.data;
    if (req.generation !== input.binding.generation) {
      throw new NativeCommandRouterError(
        'STALE_BINDING',
        409,
        'Control generation does not match active runtime generation',
        { currentGeneration: input.binding.generation },
      );
    }

    // Only root runtime / activity / work cancel is verified on v1 ACP;
    // child agent cancel requires explicit protocol capability evidence.
    if (req.target.type === 'agent') {
      const snapshot = this.deps.catalog.getSnapshot(input.binding);
      const subagentCap = snapshot.descriptors.find(
        (d) => d.id === 'AGY-W01' || d.id === 'agy.subagents',
      );
      if (!subagentCap || subagentCap.control !== 'available') {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Child agent native control is not verified on this runtime',
          { targetType: 'agent', action: req.action },
        );
      }
    }

    if (req.action !== 'cancel' && req.action !== 'stop') {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        `Control action "${req.action}" is not supported by native router`,
      );
    }

    if (!this.deps.dispatchNativeCancel) {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        'No live cancel handler is attached for this runtime',
      );
    }

    const result = await this.deps.dispatchNativeCancel({
      binding: input.binding,
      target: req.target,
      action: req.action,
    });

    return NativeControlResponseSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      receiptId: input.receiptId,
      accepted: result.accepted,
      state: result.state,
      revision: result.revision,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
  }

  private async handleQueryLane(
    binding: RuntimeBinding,
    receiptId: string,
    action: NativeCommandActionMetadata,
  ): Promise<NativeCommandResponse> {
    if (action.key === 'query_usage') {
      if (!this.deps.queryUsage) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Profile-scoped /usage query handler is not configured',
        );
      }
      const res = await this.deps.queryUsage(binding);
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output: res.output,
        summaryFields: {
          lane: 'query',
          command: '/usage',
          profileInstanceId: binding.instanceId,
          mutatedConversation: false,
          ...(res.summaryFields ?? {}),
        },
      };
    }

    if (action.key === 'query_skills') {
      if (!this.deps.querySkills) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Profile-scoped /skills query handler is not configured',
        );
      }
      const res = await this.deps.querySkills(binding);
      const enabledSkills = res.skills.filter((s) => s.enabled !== false);
      const output =
        res.output ??
        (enabledSkills
          .map((s) => `${s.name}${s.description ? ` · ${s.description}` : ''}`)
          .join('\n') || '未发现可调用技能');
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output,
        summaryFields: {
          lane: 'query',
          command: '/skills',
          profileInstanceId: binding.instanceId,
          skillCount: enabledSkills.length,
          mutatedConversation: false,
        },
      };
    }

    throw new NativeCommandRouterError(
      'UNSUPPORTED_ACTION',
      422,
      `Unsupported query action "${action.key}"`,
    );
  }

  private async handleConfigLane(
    binding: RuntimeBinding,
    receiptId: string,
    snapshot: BindingCatalogSnapshot,
    action: NativeCommandActionMetadata,
    args: Record<string, string | number | boolean | null | string[]>,
    provenance: AgyDispatchProvenance,
  ): Promise<NativeCommandResponse> {
    const opts = snapshot.modelEffortOptions;

    if (action.key === 'inspect_models') {
      const current = opts.currentModelId ?? 'CLI 默认';
      const lines = [
        `当前模型: ${current}`,
        ...opts.models.map(
          (m) =>
            `${m.id} · ${m.displayName}${m.group ? ` [${m.group}]` : ''}${m.supportedEfforts?.length ? ` (effort: ${m.supportedEfforts.join('/')})` : ''}`,
        ),
      ];
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output: lines.join('\n'),
        summaryFields: {
          lane: 'config',
          command: '/model',
          currentModel: opts.currentModelId,
          modelCount: opts.models.length,
          effortObserved: opts.effortObserved,
        },
      };
    }

    if (action.key === 'set_model') {
      const rawModel = String(args.modelId ?? '').trim();
      if (!rawModel || !MODEL_ID_PATTERN.test(rawModel)) {
        throw new NativeCommandRouterError('INVALID_REQUEST', 400, '请输入一个有效的模型 ID');
      }
      const targetModel = rawModel === 'default' ? null : rawModel;
      // If the runtime advertised explicit model choices, enforce them strictly (no silent fallback)
      if (
        targetModel !== null &&
        opts.models.length > 0 &&
        !opts.models.some((m) => m.id === targetModel)
      ) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          `模型 "${targetModel}" 不在当前绑定实际广告的可用模型列表中`,
          { requestedModel: targetModel },
        );
      }
      if (!this.deps.applySessionConfig) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Session configuration handler is not attached',
        );
      }
      const applied = await this.deps.applySessionConfig({
        binding,
        kind: 'model',
        value: targetModel,
      });
      this.deps.catalog.updateBindingSignals(binding, {
        effectiveModel: applied.effectiveValue,
      });
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output: applied.note ?? `已选择模型 ${applied.effectiveValue ?? 'CLI 默认'} (${applied.effectiveScope})`,
        summaryFields: {
          lane: 'config',
          command: '/model',
          applied: applied.applied,
          effectiveScope: applied.effectiveScope,
          effectiveModel: applied.effectiveValue,
        },
      };
    }

    if (action.key === 'set_effort') {
      const rawEffort = String(args.effort ?? '').trim() as ReasoningEffort;
      if (!EFFORT_VALUES.has(rawEffort)) {
        throw new NativeCommandRouterError('INVALID_REQUEST', 400, `无效的思考强度: ${rawEffort}`);
      }
      if (!opts.effortObserved || !opts.availableEfforts.includes(rawEffort)) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          `思考强度 "${rawEffort}" 未在当前模型实际观测到的 thought_level 选项中`,
          { requestedEffort: rawEffort },
        );
      }
      if (!this.deps.applySessionConfig) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Session configuration handler is not attached',
        );
      }
      const applied = await this.deps.applySessionConfig({
        binding,
        kind: 'effort',
        value: rawEffort,
      });
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output: applied.note ?? `已设置思考强度 ${applied.effectiveValue ?? rawEffort} (${applied.effectiveScope})`,
        summaryFields: {
          lane: 'config',
          command: '/effort',
          applied: applied.applied,
          effectiveScope: applied.effectiveScope,
          effectiveEffort: applied.effectiveValue,
        },
      };
    }

    if (action.key === 'set_permission_mode') {
      const mode = normalizePermissionModeInput(String(args.mode ?? ''));
      if (!mode) {
        throw new NativeCommandRouterError('INVALID_REQUEST', 400, '无效的权限模式');
      }
      const resolved = resolvePermissionEnforcement(mode, opts.advertisedModes);
      if (!this.deps.applySessionConfig) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Session configuration handler is not attached',
        );
      }
      const applied = await this.deps.applySessionConfig({
        binding,
        kind: 'permission_mode',
        value: mode,
        enforcement: resolved.enforcement,
      });
      this.deps.catalog.updateBindingSignals(binding, {
        effectivePermissionMode: mode,
        effectiveEnforcement: applied.enforcement ?? resolved.enforcement,
      });
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output:
          applied.note ??
          `权限模式已切换为 ${mode}（执行边界: ${applied.enforcement ?? resolved.enforcement}）`,
        summaryFields: {
          lane: 'config',
          command: '/permissions',
          applied: applied.applied,
          effectiveScope: applied.effectiveScope,
          permissionMode: mode,
          enforcement: applied.enforcement ?? resolved.enforcement,
        },
      };
    }

    if (action.key === 'set_plan_mode') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!this.deps.applySessionConfig) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Session configuration handler is not attached',
        );
      }
      if (text.toLowerCase() === 'off') {
        const applied = await this.deps.applySessionConfig({
          binding,
          kind: 'permission_mode',
          value: 'manual',
          enforcement: 'native',
        });
        this.deps.catalog.updateBindingSignals(binding, {
          effectivePermissionMode: 'manual',
        });
        return {
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          kind: 'inspect',
          receiptId,
          output: applied.note ?? '已退出计划模式',
          summaryFields: {
            lane: 'config',
            command: '/plan',
            planMode: false,
            applied: applied.applied,
          },
        };
      }

      await this.deps.applySessionConfig({
        binding,
        kind: 'permission_mode',
        value: 'plan',
        enforcement: 'native',
      });
      this.deps.catalog.updateBindingSignals(binding, {
        effectivePermissionMode: 'plan',
      });

      if (!text) {
        return {
          schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
          kind: 'inspect',
          receiptId,
          output: '已启用计划模式',
          summaryFields: {
            lane: 'config',
            command: '/plan',
            planMode: true,
            applied: true,
          },
        };
      }

      if (!this.deps.dispatchLiveWorkflow) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'Live ACP session dispatcher is not attached for /plan <task>',
        );
      }
      const dispatched = await this.deps.dispatchLiveWorkflow({
        binding,
        receiptId,
        capabilityId: 'AGY-W13',
        actionKey: action.key,
        promptText: `/plan ${text}`,
        attachmentIds: extractOrderedAttachmentIds(args),
        provenance,
      });
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'accepted',
        receiptId,
        activityId: dispatched.activityId ?? mintActivityId(),
        ...(dispatched.turnId ? { turnId: dispatched.turnId } : {}),
        modeEvidenceObserved: dispatched.modeEvidenceObserved ?? false,
      };
    }

    throw new NativeCommandRouterError(
      'UNSUPPORTED_ACTION',
      422,
      `Unsupported config action "${action.key}"`,
    );
  }

  private async handleLiveWorkflowLane(
    binding: RuntimeBinding,
    receiptId: string,
    snapshot: BindingCatalogSnapshot,
    capabilityId: string,
    action: NativeCommandActionMetadata,
    args: Record<string, string | number | boolean | null | string[]>,
    provenance: AgyDispatchProvenance,
  ): Promise<NativeCommandResponse> {
    if (this.deps.isNativeWorkflowRoutingEnabled && !this.deps.isNativeWorkflowRoutingEnabled()) {
      throw new NativeCommandRouterError(
        'NATIVE_RUNTIME_DISABLED',
        503,
        'Native workflow live routing is disabled by feature gate',
      );
    }

    if (action.key === 'cancel') {
      if (!this.deps.dispatchNativeCancel) {
        throw new NativeCommandRouterError(
          'UNSUPPORTED_ACTION',
          422,
          'No live cancel handler is attached for this runtime',
        );
      }
      const cancelRes = await this.deps.dispatchNativeCancel({
        binding,
        target: { type: 'runtime', id: binding.runtimeId },
        action: 'cancel',
      });
      return {
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        kind: 'inspect',
        receiptId,
        output: cancelRes.accepted ? '已发送原生取消请求，等待对端确认' : '当前无可取消的活动',
        summaryFields: {
          lane: 'live_workflow',
          action: 'cancel',
          accepted: cancelRes.accepted,
          state: cancelRes.state,
        },
      };
    }

    if (snapshot.signals.hasLiveConnection === false) {
      throw new NativeCommandRouterError(
        'CONNECTION_LOST',
        409,
        'Active live ACP connection is required to dispatch native workflows',
      );
    }

    // For /skill, verify the target skill exists in the profile-scoped query before live dispatch
    if (action.key === 'invoke_skill' && this.deps.querySkills) {
      const skillName = String(args.name ?? '').trim();
      const listed = await this.deps.querySkills(binding);
      const found = listed.skills.find(
        (s) => s.enabled !== false && s.name === skillName,
      );
      if (!found) {
        throw new NativeCommandRouterError(
          'NOT_FOUND',
          404,
          `未在当前 Profile 中找到可用技能 "${skillName}"`,
          { skillName },
        );
      }
    }

    if (!this.deps.dispatchLiveWorkflow) {
      throw new NativeCommandRouterError(
        'UNSUPPORTED_ACTION',
        422,
        'Live ACP session dispatcher is not attached; refusing final-only auxiliary fallback',
      );
    }

    const promptText = formatLiveWorkflowPrompt(action, args);
    const attachmentIds = action.supportsAttachments ? extractOrderedAttachmentIds(args) : [];

    const dispatched = await this.deps.dispatchLiveWorkflow({
      binding,
      receiptId,
      capabilityId,
      actionKey: action.key,
      promptText,
      attachmentIds,
      provenance,
    });

    return {
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      kind: 'accepted',
      receiptId,
      activityId: dispatched.activityId ?? mintActivityId(),
      ...(dispatched.turnId ? { turnId: dispatched.turnId } : {}),
      // Honest confirmation: do not claim mode activation unless live evidence proved it.
      modeEvidenceObserved: dispatched.modeEvidenceObserved ?? false,
    };
  }

  private async handleManagerLane(
    binding: RuntimeBinding,
    receiptId: string,
    snapshot: BindingCatalogSnapshot,
    action: NativeCommandActionMetadata,
  ): Promise<NativeCommandResponse> {
    const data = (await this.deps.readManagerSnapshot?.(binding, action.key)) ?? null;
    const lines: string[] = [];

    if (data?.summaryLines && data.summaryLines.length > 0) {
      lines.push(...data.summaryLines);
    } else {
      switch (action.key) {
        case 'inspect_agents':
          lines.push(
            `已观测原生 Agents: ${data?.agentCount ?? 0}（当前 ACP 未暴露统一 Agent Manager 控制接口，不新开竞争进程）。`,
          );
          break;
        case 'inspect_tasks':
          lines.push(
            `已观测后台任务: 有限/活跃 ${data?.activeWorkCount ?? 0} · 常驻 daemon ${data?.daemonCount ?? 0}（以当前运行时投影为准，不抢占原 conversation）。`,
          );
          break;
        case 'open_swarm_board':
          lines.push(
            data?.swarmBoardAvailable
              ? '当前运行存在已观测的 Swarm Board 数据，请在 Swarm Studio 查看线程。'
              : '当前 ACP 会话未暴露原生 Swarm Board feed；请查看协调者活动或使用官方入口。',
          );
          break;
        case 'inspect_mcp':
          lines.push(
            `本机全局 AGY MCP 配置: ${data?.mcpGlobalPresent ? '已发现' : '未发现或未探测'}（跨 Profile 共享；HarnessMate 会话级 MCP 独立隔离）。`,
          );
          break;
        case 'inspect_credits':
          lines.push(
            `当前已观测计划/Tier: ${data?.tierName ?? snapshot.signals.tierName ?? '未知'}（账单与购买仅支持官方入口）。`,
          );
          break;
        default:
          lines.push(action.description);
      }
    }

    lines.push(`官方入口: ${action.officialEntry}`);

    return {
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      kind: 'inspect',
      receiptId,
      output: lines.join('\n'),
      summaryFields: {
        lane: 'manager',
        action: action.key,
        officialEntry: action.officialEntry,
        upstreamLimited: true,
        mutatedConversation: false,
        ...(data?.agentCount !== undefined ? { agentCount: data.agentCount } : {}),
        ...(data?.activeWorkCount !== undefined ? { activeWorkCount: data.activeWorkCount } : {}),
        ...(data?.daemonCount !== undefined ? { daemonCount: data.daemonCount } : {}),
        ...(data?.swarmBoardAvailable !== undefined
          ? { swarmBoardAvailable: data.swarmBoardAvailable }
          : {}),
      },
    };
  }
}
