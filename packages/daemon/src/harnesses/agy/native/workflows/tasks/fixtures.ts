import fs from 'node:fs';
import type { ActivityId, RuntimeBinding, WorkflowId } from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import type { GoalScheduleTasksObserver } from './observer.js';
import type { TasksRecoveryReconcileRequest, TasksRecoveryReconcileResult } from './ports.js';
import type { ScheduleKind, TasksIngestResult } from './types.js';

export type TasksNdjsonStep =
  | {
      readonly kind: 'scenario_meta';
      readonly scenarioId: string;
      readonly source: 'synthetic' | 'replay_with_provenance';
      readonly applicableCliVersions: readonly string[];
      readonly provenanceOrigin: string;
      readonly notes?: string;
    }
  | {
      readonly kind: 'launch_goal';
      readonly connectionId: string;
      readonly originActivityId: ActivityId;
      readonly turnId?: string | null;
      readonly objective: string;
      readonly nativeGoalId?: string;
      readonly workflowId?: WorkflowId;
      readonly ingressOrdinal?: number;
      readonly nowMs: number;
    }
  | {
      readonly kind: 'launch_schedule';
      readonly connectionId: string;
      readonly originActivityId: ActivityId;
      readonly turnId?: string | null;
      readonly scheduleKind?: ScheduleKind;
      readonly scheduleLabel?: string;
      readonly cronExpression?: string;
      readonly durationSeconds?: number;
      readonly nextAt?: number;
      readonly timezone?: string;
      readonly nativeScheduleId?: string;
      readonly workflowId?: WorkflowId;
      readonly ingressOrdinal?: number;
      readonly nowMs: number;
    }
  | {
      readonly kind: 'turn_ended';
      readonly turnId: string;
      readonly nowMs: number;
    }
  | {
      readonly kind: 'wire_frame';
      readonly connectionId: string;
      readonly ingressOrdinal: number;
      readonly channel: 'live' | 'history_replay';
      readonly originSession: string;
      readonly originActivityId?: ActivityId;
      readonly turnId?: string | null;
      readonly activeTurnEnded?: boolean;
      readonly nowMs: number;
      readonly frame: unknown;
    }
  | {
      readonly kind: 'stop_goal';
      readonly workflowId: WorkflowId;
      readonly nowMs: number;
    }
  | {
      readonly kind: 'transport_close';
      readonly connectionId: string;
      readonly reason?: string;
      readonly nowMs: number;
    }
  | {
      readonly kind: 'reconcile_recovery';
      readonly request: Omit<TasksRecoveryReconcileRequest, 'priorEvidence'>;
      readonly nowMs: number;
    };

export function loadTasksNdjsonFixture(filePath: string): TasksNdjsonStep[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => JSON.parse(line) as TasksNdjsonStep);
}

export function replayTasksNdjson(
  observer: GoalScheduleTasksObserver,
  binding: RuntimeBinding,
  steps: readonly TasksNdjsonStep[],
  opts: {
    readonly rootNativeSessionId: string;
    readonly connectionId: string;
  },
): {
  readonly scenarioMeta: Extract<TasksNdjsonStep, { kind: 'scenario_meta' }> | null;
  readonly results: readonly TasksIngestResult[];
  readonly recoveryResults: readonly TasksRecoveryReconcileResult[];
} {
  observer.registerBinding({
    binding,
    connectionId: opts.connectionId,
    rootNativeSessionId: opts.rootNativeSessionId,
  });

  let scenarioMeta: Extract<TasksNdjsonStep, { kind: 'scenario_meta' }> | null = null;
  const results: TasksIngestResult[] = [];
  const recoveryResults: TasksRecoveryReconcileResult[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case 'scenario_meta':
        scenarioMeta = step;
        break;
      case 'launch_goal':
        results.push(
          observer.recordConfirmedGoalLaunch({
            binding,
            connectionId: step.connectionId,
            originActivityId: step.originActivityId,
            turnId: step.turnId ?? null,
            objective: step.objective,
            nativeGoalId: step.nativeGoalId,
            workflowId: step.workflowId,
            ingressOrdinal: step.ingressOrdinal,
            observedAt: step.nowMs,
          }),
        );
        break;
      case 'launch_schedule':
        results.push(
          observer.recordConfirmedScheduleLaunch({
            binding,
            connectionId: step.connectionId,
            originActivityId: step.originActivityId,
            turnId: step.turnId ?? null,
            scheduleKind: step.scheduleKind,
            scheduleLabel: step.scheduleLabel,
            cronExpression: step.cronExpression,
            durationSeconds: step.durationSeconds,
            nextAt: step.nextAt,
            timezone: step.timezone,
            nativeScheduleId: step.nativeScheduleId,
            workflowId: step.workflowId,
            ingressOrdinal: step.ingressOrdinal,
            observedAt: step.nowMs,
          }),
        );
        break;
      case 'turn_ended':
        observer.onUserTurnEnded(binding, step.turnId);
        break;
      case 'wire_frame': {
        const envelope: NativeIngress = {
          binding,
          connectionId: step.connectionId,
          ingressOrdinal: step.ingressOrdinal,
          channel: step.channel,
          originSession: step.originSession,
          wire: step.frame,
        };
        results.push(
          observer.acceptFrame(envelope, {
            activeTurnId: step.turnId ?? null,
            activeTurnEnded: step.activeTurnEnded,
            originActivityId: step.originActivityId,
            observedAt: step.nowMs,
          }),
        );
        break;
      }
      case 'stop_goal':
        results.push(observer.recordGoalStopRequested(binding, step.workflowId, step.nowMs));
        break;
      case 'transport_close':
        observer.handleTransportClosed(binding, step.connectionId, step.reason);
        break;
      case 'reconcile_recovery': {
        const priorEvidence = observer
          .getRecoveryPort()
          .listEvidenceForRuntime(binding.runtimeId);
        recoveryResults.push(
          observer.reconcileRecovery({
            ...step.request,
            priorEvidence,
            nowMs: step.nowMs,
          }),
        );
        break;
      }
    }
  }

  return { scenarioMeta, results, recoveryResults };
}
