import type {
  ActivityId,
  BindingGeneration,
  RuntimeBinding,
  WorkId,
  WorkOutcome,
  WorkState,
  WorkflowId,
} from '@harnessmate/protocol';
import type { AgyNativeCommandCatalogService } from '../../commands/catalog.js';
import type { NativeWorkflowDescriptorContribution } from '../../commands/descriptors.js';
import type { OccurrenceRecoveryState, ScheduleKind } from './types.js';

export const TASKS_RECOVERY_PORT_REVISION = 'agy-np12-np15-recovery-port-v1.0.0' as const;

const OPAQUE_ARTIFACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const EXPLICIT_UTC_OFFSET_RE = /^(?:UTC|GMT)?[+-](?:0\d|1[0-4]):[0-5]\d$/;

/**
 * Validates that a Goal verification artifact ID is an opaque identifier rather than
 * an unapproved filesystem path (drive letters, slashes, traversal, or file:// URLs).
 */
export function isValidOpaqueArtifactId(value: string): boolean {
  if (!value || value.length > 128) return false;
  if (
    /^[a-zA-Z]:/.test(value) ||
    value.includes('://') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.startsWith('.')
  ) {
    return false;
  }
  return OPAQUE_ARTIFACT_ID_RE.test(value);
}

/**
 * Validates that a timezone token supplied by native wire/snapshot is a real IANA timezone
 * or explicit UTC/GMT offset — NEVER substitutes host OS/browser timezone.
 */
export function isValidNativeTimezone(raw: string): boolean {
  const tz = raw.trim();
  if (!tz || tz.length > 80) return false;
  if (tz === 'UTC' || tz === 'GMT' || tz === 'Z' || EXPLICIT_UTC_OFFSET_RE.test(tz)) {
    return true;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── NP-06 Capability Descriptor Contributions ──────────────────────────

export const GOAL_CAPABILITY_CONTRIBUTION: NativeWorkflowDescriptorContribution =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-12.goal',
    capabilityId: 'AGY-W09',
    aliasIds: ['agy.workflow.goal'],
    slashName: 'goal',
    title: 'Goal 目标驱动工作流',
    description:
      '观察原生 Goal 启动、状态、替换、验证结果与停止边界；在当前 live ACP 会话内执行，绝不回落 final-only 辅助进程。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /goal <objective>',
    evidenceRefs: ['E05', 'S12', 'T09-synthetic'],
    verifiedLevel: null,
    launchGateOverride: 'unknown',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'unknown',
    localReadGateOverride: 'not_tested',
  });

export const SCHEDULE_CAPABILITY_CONTRIBUTION: NativeWorkflowDescriptorContribution =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-12.schedule',
    capabilityId: 'AGY-W10',
    aliasIds: ['agy.workflow.schedule'],
    slashName: 'schedule',
    title: 'Schedule 定时唤醒',
    description:
      '区分单次与 cron 定时、计划/实际触发时间、原生时区与多次 occurrence 唤醒；使用原生 nextAt 而非本地猜测，不用 HM 调度器替代。',
    surfaces: ['desktop', 'cli', 'ide', 'acp'],
    officialEntry: '官方 CLI /schedule <when> <task>',
    evidenceRefs: ['E05', 'S06', 'T09-synthetic'],
    verifiedLevel: null,
    launchGateOverride: 'unknown',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'upstream_limited',
    localReadGateOverride: 'not_tested',
  });

export const TASKS_MANAGER_CAPABILITY_CONTRIBUTION: NativeWorkflowDescriptorContribution =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-12.tasks-manager',
    capabilityId: 'AGY-W11',
    aliasIds: ['agy.tasks.manager'],
    slashName: 'tasks',
    title: 'Native Tasks 管理中心 (/tasks)',
    description:
      '聚合 Runtime Center 中有限命令、常驻 Daemon、Goal 与定时来源；ACP 未暴露列表/直删控制时保留只读投影与官方 /tasks 入口。',
    surfaces: ['desktop', 'cli'],
    officialEntry: '官方 CLI /tasks · Ctrl+T',
    evidenceRefs: ['E01', 'E06', 'T09-synthetic'],
    verifiedLevel: 1,
    launchGateOverride: 'available',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'upstream_limited',
    localReadGateOverride: 'unknown',
  });

export const APP_AUTOMATIONS_CAPABILITY_CONTRIBUTION: NativeWorkflowDescriptorContribution =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-12.app-automations',
    capabilityId: 'AGY-W12',
    aliasIds: ['agy.app.automations'],
    slashName: 'automation',
    title: 'App Automations（官方 App 持久计划）',
    description:
      '仅作只读证据收口：跨会话持久 Automations (/automation) 与 Sidecars 属官方 App 能力，不在 ACP 仿制，不重绑用户现有任务。',
    surfaces: ['desktop'],
    officialEntry: '官方 Antigravity App /automation · Automations tab',
    evidenceRefs: ['E01', '03_Official_Research'],
    verifiedLevel: null,
    launchGateOverride: 'unsupported',
    observeGateOverride: 'unsupported',
    controlGateOverride: 'unsupported',
    localReadGateOverride: 'unsupported',
  });

export const TASKS_CAPABILITY_CONTRIBUTIONS: readonly NativeWorkflowDescriptorContribution[] =
  Object.freeze([
    GOAL_CAPABILITY_CONTRIBUTION,
    SCHEDULE_CAPABILITY_CONTRIBUTION,
    TASKS_MANAGER_CAPABILITY_CONTRIBUTION,
    APP_AUTOMATIONS_CAPABILITY_CONTRIBUTION,
  ]);

export function registerTasksCapabilityDescriptors(
  catalog: AgyNativeCommandCatalogService,
): () => void {
  const disposers = TASKS_CAPABILITY_CONTRIBUTIONS.map((contrib) =>
    catalog.registerWorkflowDescriptor(contrib),
  );
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

// ── NP-12 <-> NP-15 Recovery Evidence Seam ─────────────────────────────

export interface TasksOccurrenceRecoveryEvidence {
  readonly binding: RuntimeBinding;
  readonly workflowId: WorkflowId;
  readonly workflowKind: 'goal' | 'schedule';
  readonly nativeWorkflowKey: string;
  readonly scheduleKind?: ScheduleKind;
  readonly objectiveOrLabel?: string;
  readonly workId?: WorkId;
  readonly occurrenceIndex?: number;
  readonly nativeOccurrenceKey?: string;
  readonly originSource: 'live_protocol' | 'native_snapshot' | 'replay';
  readonly originGeneration: BindingGeneration;
  readonly lastKnownState: WorkState;
  readonly lastOutcome?: WorkOutcome;
  readonly plannedAt?: number;
  readonly actualTriggeredAt?: number;
  readonly nextAt?: number;
  readonly timezone?: string;
  readonly wakeActivityIds: readonly ActivityId[];
  readonly observedAt: number;
  readonly authoritativeAfterRestart: boolean;
  readonly reasonCode: string;
}

export interface TasksRecoveryScopeCheck {
  readonly profileMatches: boolean;
  readonly sourceMatches: boolean;
  readonly workspaceMatches: boolean;
  readonly conversationIdMatches: boolean;
}

export interface TasksRecoveryReconcileRequest {
  readonly nextBinding: RuntimeBinding;
  readonly scopeCheck: TasksRecoveryScopeCheck;
  readonly priorEvidence: readonly TasksOccurrenceRecoveryEvidence[];
  readonly nowMs?: number;
}

export interface ReconciledTaskOccurrenceEntry {
  readonly workflowId: WorkflowId;
  readonly nativeWorkflowKey: string;
  readonly workId?: WorkId;
  readonly occurrenceIndex?: number;
  readonly nativeOccurrenceKey?: string;
  readonly dedupeKey: string;
  readonly recoveryState: OccurrenceRecoveryState;
  readonly reconciledState: 'stale' | 'preserved_terminal' | 'unknown';
  readonly lastKnownState: WorkState;
  readonly lastOutcome?: WorkOutcome;
  readonly wakeActivityIds: readonly ActivityId[];
  readonly leaseJustified: boolean;
  readonly reasonCode: string;
}

export interface TasksRecoveryReconcileResult {
  readonly accepted: boolean;
  readonly reasonCode: string;
  readonly reconciledEntries: readonly ReconciledTaskOccurrenceEntry[];
  readonly deduplicatedCount: number;
  readonly leaseJustified: boolean;
}

/**
 * Frozen NP-12 <-> NP-15 restart & disconnect recovery evidence port.
 *
 * Guarantees:
 * - Cross-profile / cross-source / cross-workspace / cross-conversation rebinding is strictly rejected.
 * - Cross-generation occurrences are deduplicated by stable native key + occurrence identity.
 * - Terminal/expired occurrences remain `preserved_read_only`; non-terminal armed items become `stale`
 *   unless proven live on the attached connection.
 * - Retention leases are NEVER granted without verified active live evidence.
 */
export interface TasksRecoveryEvidencePort {
  readonly contractRevision: typeof TASKS_RECOVERY_PORT_REVISION;
  recordEvidence(entry: TasksOccurrenceRecoveryEvidence): void;
  listEvidenceForRuntime(runtimeId: string): readonly TasksOccurrenceRecoveryEvidence[];
  reconcile(request: TasksRecoveryReconcileRequest): TasksRecoveryReconcileResult;
}

function isTerminal(state: WorkState): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled';
}

export class FrozenTasksRecoveryEvidenceStub implements TasksRecoveryEvidencePort {
  readonly contractRevision = TASKS_RECOVERY_PORT_REVISION;
  private readonly recordsByRuntime = new Map<string, TasksOccurrenceRecoveryEvidence[]>();

  recordEvidence(entry: TasksOccurrenceRecoveryEvidence): void {
    const list = this.recordsByRuntime.get(entry.binding.runtimeId) ?? [];
    const dedupeKey = `${entry.nativeWorkflowKey}::${entry.nativeOccurrenceKey ?? entry.occurrenceIndex ?? entry.workId ?? 'wf'}`;
    const idx = list.findIndex(
      (item) =>
        `${item.nativeWorkflowKey}::${item.nativeOccurrenceKey ?? item.occurrenceIndex ?? item.workId ?? 'wf'}` ===
        dedupeKey,
    );
    if (idx >= 0) {
      list[idx] = entry;
    } else {
      list.push(entry);
    }
    this.recordsByRuntime.set(entry.binding.runtimeId, list);
  }

  listEvidenceForRuntime(runtimeId: string): readonly TasksOccurrenceRecoveryEvidence[] {
    return [...(this.recordsByRuntime.get(runtimeId) ?? [])];
  }

  reconcile(request: TasksRecoveryReconcileRequest): TasksRecoveryReconcileResult {
    const { scopeCheck, priorEvidence } = request;
    if (
      !scopeCheck.profileMatches ||
      !scopeCheck.sourceMatches ||
      !scopeCheck.workspaceMatches ||
      !scopeCheck.conversationIdMatches
    ) {
      return {
        accepted: false,
        reasonCode: 'cross_scope_rebind_blocked',
        reconciledEntries: [],
        deduplicatedCount: 0,
        leaseJustified: false,
      };
    }

    const byKey = new Map<string, TasksOccurrenceRecoveryEvidence>();
    let deduplicatedCount = 0;

    for (const item of priorEvidence) {
      const occIdentity =
        item.nativeOccurrenceKey ??
        (item.occurrenceIndex !== undefined ? `idx:${item.occurrenceIndex}` : item.workId ?? 'workflow');
      const dedupeKey = `${item.workflowKind}:${item.nativeWorkflowKey}:${occIdentity}`;
      const existing = byKey.get(dedupeKey);
      if (existing) {
        deduplicatedCount += 1;
        // Keep the record with higher observedAt or terminal status
        if (
          item.observedAt >= existing.observedAt ||
          (!isTerminal(existing.lastKnownState) && isTerminal(item.lastKnownState))
        ) {
          byKey.set(dedupeKey, {
            ...item,
            wakeActivityIds: [...new Set([...existing.wakeActivityIds, ...item.wakeActivityIds])],
          });
        }
      } else {
        byKey.set(dedupeKey, item);
      }
    }

    const reconciledEntries: ReconciledTaskOccurrenceEntry[] = [];
    let leaseJustified = false;

    for (const [dedupeKey, item] of byKey.entries()) {
      const terminal = isTerminal(item.lastKnownState);
      if (terminal) {
        reconciledEntries.push({
          workflowId: item.workflowId,
          nativeWorkflowKey: item.nativeWorkflowKey,
          ...(item.workId ? { workId: item.workId } : {}),
          ...(item.occurrenceIndex !== undefined ? { occurrenceIndex: item.occurrenceIndex } : {}),
          ...(item.nativeOccurrenceKey ? { nativeOccurrenceKey: item.nativeOccurrenceKey } : {}),
          dedupeKey,
          recoveryState: 'preserved_read_only',
          reconciledState: 'preserved_terminal',
          lastKnownState: item.lastKnownState,
          ...(item.lastOutcome ? { lastOutcome: item.lastOutcome } : {}),
          wakeActivityIds: [...item.wakeActivityIds],
          leaseJustified: false,
          reasonCode: 'terminal_history_preserved_read_only',
        });
        continue;
      }

      const recoveryState: OccurrenceRecoveryState = item.authoritativeAfterRestart
        ? 'reconciling'
        : 'stale_unconfirmed';
      const entryLease = false; // Never grant lease before fresh live confirmation on reattach
      reconciledEntries.push({
        workflowId: item.workflowId,
        nativeWorkflowKey: item.nativeWorkflowKey,
        ...(item.workId ? { workId: item.workId } : {}),
        ...(item.occurrenceIndex !== undefined ? { occurrenceIndex: item.occurrenceIndex } : {}),
        ...(item.nativeOccurrenceKey ? { nativeOccurrenceKey: item.nativeOccurrenceKey } : {}),
        dedupeKey,
        recoveryState,
        reconciledState: item.lastKnownState === 'unknown' ? 'unknown' : 'stale',
        lastKnownState: item.lastKnownState,
        ...(item.lastOutcome ? { lastOutcome: item.lastOutcome } : {}),
        wakeActivityIds: [...item.wakeActivityIds],
        leaseJustified: entryLease,
        reasonCode: item.authoritativeAfterRestart
          ? 'reconciling_after_restart'
          : 'unconfirmed_after_restart_stale',
      });
    }

    return {
      accepted: true,
      reasonCode: 'reconciled_with_scope_verification',
      reconciledEntries,
      deduplicatedCount,
      leaseJustified,
    };
  }
}
