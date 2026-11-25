import {
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  type AgentIdentity,
  type NativeRequestSummaryDto,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import type { AgyTeamworkWorkflowObserver, TeamworkWorkspaceContext } from './observer.js';
import type { TeamworkRoleKind } from './schemas.js';

export interface TeamworkReplayStep {
  readonly kind:
    | 'ingress'
    | 'receipt'
    | 'confirmed_agent'
    | 'disconnect'
    | 'advance_generation'
    | 'reconnect';
  readonly envelope?: NativeIngress;
  readonly receipt?: {
    readonly request: NativeRequestSummaryDto;
    readonly stage: 'scoping' | 'prompt_artifact_approval';
    readonly promptSummary?: string;
    readonly dedupKey?: string;
    readonly selectedOptionId?: string;
    readonly selectedOptionLabel?: string;
    readonly decisionHint?: 'approve' | 'reject';
    readonly artifactId?: string;
  };
  readonly confirmedAgent?: {
    readonly agent: AgentIdentity;
    readonly roleKind: TeamworkRoleKind;
    readonly milestoneId?: string;
  };
  readonly connectionId?: string;
  readonly nextGeneration?: string;
  readonly reconnectMode?: 'resume' | 'load' | 'fresh';
}

export interface TeamworkReplayScenario {
  readonly scenarioId: string;
  readonly source: 'synthetic';
  readonly provenanceOrigin: string;
  readonly description: string;
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly rootNativeSessionId: string;
  readonly workspaceContext: TeamworkWorkspaceContext;
  readonly steps: readonly TeamworkReplayStep[];
}

export function createTeamworkTestBinding(
  suffix = 't12',
  generation = 'gen_1',
): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(`nrt_teamwork_${suffix}`),
    sessionId: `sess_teamwork_${suffix}`,
    instanceId: 'agy',
    generation: asBindingGeneration(generation),
  };
}

/**
 * T12 Scenario A (Synthetic):
 * `/teamwork` advertised -> scoping Q&A with duplicate question redelivery (idempotency check) ->
 * Prompt Artifact review -> formal rejection -> spurious post-rejection project/milestone frame blocked ->
 * zero project scope, zero roles, zero milestones created.
 */
export function createT12RejectedScenario(): TeamworkReplayScenario {
  const binding = createTeamworkTestBinding('t12_rejected');
  const connId = 'conn_t12_rej_1';
  const scopingAct = asActivityId('act_t12_rej_scoping');

  return {
    scenarioId: 'T12-rejected',
    source: 'synthetic',
    provenanceOrigin: 'np10_synthetic_fixture:t12-teamwork-rejected',
    description:
      'Synthetic T12 replay: scoping question idempotency + Prompt Artifact formal rejection guarantees zero project/role/milestone creation.',
    binding,
    connectionId: connId,
    rootNativeSessionId: 'native-sess-t12-rej',
    workspaceContext: {
      hmWorkspaceId: 'ws_hm_repo_1',
      hmWorkspaceLabel: 'harnessmate_desktop',
      hmWorkspaceRoot: 'D:\\HarnessMate\\workspace-a',
      authorizedRoots: ['D:\\HarnessMate\\workspace-a'],
    },
    steps: [
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 1,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-rej',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'plan' }, { name: 'teamwork' }],
              },
            },
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 2,
          channel: 'live',
          wire: {
            id: 4001,
            method: 'session/request_permission',
            params: {
              sessionId: 'native-sess-t12-rej',
              toolCall: {
                toolCallId: 'interaction_tw_q1',
                title: 'Target runtime platform?',
                rawInput: {
                  question: 'Which deployment target should Teamwork scope?',
                  teamwork: { stage: 'scoping', questionKey: 'tw-scope-target-platform' },
                },
              },
            },
          },
        },
      },
      // Duplicate redelivery of the exact same scoping question (must be deduplicated idempotently)
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 3,
          channel: 'live',
          wire: {
            id: 4001,
            method: 'session/request_permission',
            params: {
              sessionId: 'native-sess-t12-rej',
              toolCall: {
                toolCallId: 'interaction_tw_q1',
                title: 'Target runtime platform?',
                rawInput: {
                  question: 'Which deployment target should Teamwork scope?',
                  teamwork: { stage: 'scoping', questionKey: 'tw-scope-target-platform' },
                },
              },
            },
          },
        },
      },
      {
        kind: 'receipt',
        receipt: {
          stage: 'scoping',
          dedupKey: 'tw-scope-target-platform',
          selectedOptionId: 'opt_desktop',
          selectedOptionLabel: 'Windows Desktop',
          request: {
            approvalId: 'appr_tw_q1',
            runtimeId: binding.runtimeId,
            generation: binding.generation,
            activityId: scopingAct,
            targetLineage: 'confirmed',
            kind: 'question',
            allowedOptionIds: ['opt_desktop', 'opt_web'],
            receiptId: 'nrcpt_tw_q1',
            receiptState: 'response_written',
            updatedAt: 10_050,
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 4,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-rej',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'prompt_artifact',
                artifactId: 'art_tw_prompt_rej_1',
                title: 'Teamwork Project Prompt Spec',
                previewExcerpt: 'Scope: Windows Desktop service refactor with 2 milestones.',
                requiresApproval: true,
                approvalRequestId: 'appr_tw_prompt_rej',
              },
            },
          },
        },
      },
      {
        kind: 'receipt',
        receipt: {
          stage: 'prompt_artifact_approval',
          artifactId: 'art_tw_prompt_rej_1',
          selectedOptionId: 'reject_once',
          decisionHint: 'reject',
          request: {
            approvalId: 'appr_tw_prompt_rej',
            runtimeId: binding.runtimeId,
            generation: binding.generation,
            targetLineage: 'confirmed',
            kind: 'permission',
            allowedOptionIds: ['allow_once', 'reject_once'],
            receiptId: 'nrcpt_tw_prompt_rej',
            receiptState: 'response_written',
            updatedAt: 10_100,
          },
        },
      },
      // Spurious post-rejection project creation frame (MUST be blocked!)
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 5,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-rej',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'project_created',
                projectLabel: 'should-never-exist',
                projectPath: 'D:\\TeamworkProjects\\should-never-exist',
              },
            },
          },
        },
      },
    ],
  };
}

/**
 * T12 Scenario B (Synthetic):
 * `/teamwork` advertised -> scoping Q&A -> Prompt Artifact -> formal native protocol approval ->
 * distinct native project scope (separate from HM workspace) -> confirmed Sentinel & Project Orchestrator ->
 * Milestone 1 + Audit gate + deliverable artifact.
 */
export function createT12ApprovedMilestone1Scenario(): TeamworkReplayScenario {
  const binding = createTeamworkTestBinding('t12_approved');
  const connId = 'conn_t12_app_1';
  const sentinelId = asNativeAgentId('agt_tw_sentinel_1');
  const orchestratorId = asNativeAgentId('agt_tw_orchestrator_1');
  const auditorId = asNativeAgentId('agt_tw_auditor_1');

  return {
    scenarioId: 'T12-approved-milestone-1',
    source: 'synthetic',
    provenanceOrigin: 'np10_synthetic_fixture:t12-teamwork-approved-m1',
    description:
      'Synthetic T12 replay: formal Prompt Artifact approval unlocks native project scope, confirmed Sentinel/Orchestrator/Auditor roles, Milestone 1, and Audit gate.',
    binding,
    connectionId: connId,
    rootNativeSessionId: 'native-sess-t12-app',
    workspaceContext: {
      hmWorkspaceId: 'ws_hm_repo_1',
      hmWorkspaceLabel: 'harnessmate_desktop',
      hmWorkspaceRoot: 'D:\\HarnessMate\\workspace-a',
      authorizedRoots: ['D:\\HarnessMate\\workspace-a'],
    },
    steps: [
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 1,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'teamwork' }, { name: 'plan' }],
              },
            },
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 2,
          channel: 'live',
          wire: {
            id: 'tw-q-str-1',
            method: 'elicitation/create',
            params: {
              sessionId: 'native-sess-t12-app',
              message: 'Confirm milestone cadence and audit strictness',
              _meta: {
                teamwork: {
                  stage: 'scoping',
                  questionKey: 'tw-cadence-q1',
                },
              },
            },
          },
        },
      },
      {
        kind: 'receipt',
        receipt: {
          stage: 'scoping',
          dedupKey: 'tw-cadence-q1',
          selectedOptionLabel: 'Strict milestone audit',
          request: {
            approvalId: 'appr_tw_app_q1',
            runtimeId: binding.runtimeId,
            generation: binding.generation,
            targetLineage: 'confirmed',
            kind: 'elicitation',
            allowedOptionIds: ['decline'],
            receiptId: 'nrcpt_tw_app_q1',
            receiptState: 'response_written',
            updatedAt: 20_020,
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 3,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'prompt_artifact',
                artifactId: 'art_tw_prompt_app_1',
                title: 'Payments Migration Prompt Artifact',
                previewExcerpt: 'Milestone 1: Ledger abstraction + Audit Gate.',
                requiresApproval: true,
                approvalRequestId: 'appr_tw_prompt_app',
              },
            },
          },
        },
      },
      {
        kind: 'receipt',
        receipt: {
          stage: 'prompt_artifact_approval',
          artifactId: 'art_tw_prompt_app_1',
          selectedOptionId: 'allow_once',
          decisionHint: 'approve',
          request: {
            approvalId: 'appr_tw_prompt_app',
            runtimeId: binding.runtimeId,
            generation: binding.generation,
            targetLineage: 'confirmed',
            kind: 'permission',
            allowedOptionIds: ['allow_once', 'reject_once'],
            receiptId: 'nrcpt_tw_prompt_app',
            receiptState: 'response_written',
            updatedAt: 20_060,
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 4,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'project_created',
                projectLabel: 'payments-migration-v2',
                projectPath: 'D:\\AntigravityProjects\\payments-migration-v2',
              },
            },
          },
        },
      },
      {
        kind: 'confirmed_agent',
        confirmedAgent: {
          roleKind: 'sentinel',
          agent: {
            id: sentinelId,
            role: {
              kind: 'known',
              value: 'Sentinel',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 5,
                wireVariant: 'subagent_update',
                observedAt: 20_090,
              },
            },
            label: {
              kind: 'known',
              value: 'Sentinel · Scope Guard',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 5,
                wireVariant: 'subagent_update',
                observedAt: 20_090,
              },
            },
            foreground: {
              kind: 'known',
              value: 'running',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 5,
                wireVariant: 'subagent_update',
                observedAt: 20_090,
              },
            },
            launchWorkIds: [],
            lineage: 'confirmed',
            revision: 1,
          },
        },
      },
      {
        kind: 'confirmed_agent',
        confirmedAgent: {
          roleKind: 'project_orchestrator',
          milestoneId: 'ms_1',
          agent: {
            id: orchestratorId,
            role: {
              kind: 'known',
              value: 'Project Orchestrator',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 6,
                wireVariant: 'subagent_update',
                observedAt: 20_100,
              },
            },
            label: {
              kind: 'known',
              value: 'Project Orchestrator',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 6,
                wireVariant: 'subagent_update',
                observedAt: 20_100,
              },
            },
            foreground: {
              kind: 'known',
              value: 'running',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 6,
                wireVariant: 'subagent_update',
                observedAt: 20_100,
              },
            },
            launchWorkIds: [],
            lineage: 'confirmed',
            revision: 1,
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 7,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'milestone_updated',
                milestoneId: 'ms_1',
                label: 'Milestone 1 · Ledger Schema & Adapter',
                state: 'running',
                summary: 'Implementing core schema migration and verification suite.',
              },
            },
          },
        },
      },
      {
        kind: 'confirmed_agent',
        confirmedAgent: {
          roleKind: 'auditor',
          milestoneId: 'ms_1',
          agent: {
            id: auditorId,
            role: {
              kind: 'known',
              value: 'Auditor',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 8,
                wireVariant: 'subagent_update',
                observedAt: 20_130,
              },
            },
            label: {
              kind: 'known',
              value: 'Milestone 1 Auditor',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 8,
                wireVariant: 'subagent_update',
                observedAt: 20_130,
              },
            },
            foreground: {
              kind: 'known',
              value: 'idle',
              evidence: {
                kind: 'live_protocol',
                connectionId: connId,
                ingressOrdinal: 8,
                wireVariant: 'subagent_update',
                observedAt: 20_130,
              },
            },
            launchWorkIds: [],
            lineage: 'confirmed',
            revision: 1,
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 9,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'audit_updated',
                auditId: 'aud_ms1_1',
                milestoneId: 'ms_1',
                label: 'Milestone 1 Security & Spec Audit',
                verdict: 'passed',
                artifactId: 'art_ms1_audit_report',
                summary: 'All schema invariants and boundary tests verified.',
              },
            },
          },
        },
      },
      {
        kind: 'ingress',
        envelope: {
          binding,
          connectionId: connId,
          ingressOrdinal: 10,
          channel: 'live',
          wire: {
            method: 'session/update',
            params: {
              sessionId: 'native-sess-t12-app',
              update: {
                sessionUpdate: 'teamwork_update',
                event: 'artifact_recorded',
                artifactId: 'art_ms1_audit_report',
                title: 'Milestone 1 Audit Report',
                category: 'audit_report',
                artifactKind: 'markdown',
                milestoneId: 'ms_1',
                revision: 1,
              },
            },
          },
        },
      },
    ],
  };
}

/**
 * Replays a deterministic Teamwork scenario through `AgyTeamworkWorkflowObserver`.
 */
export function replayTeamworkScenario(
  observer: AgyTeamworkWorkflowObserver,
  scenario: TeamworkReplayScenario,
): RuntimeBinding {
  let activeBinding = scenario.binding;
  let connectionId = scenario.connectionId;
  observer.handleReconnect(activeBinding, connectionId, 'fresh', scenario.rootNativeSessionId);
  observer.setWorkspaceContext(activeBinding, scenario.workspaceContext);

  for (const step of scenario.steps) {
    switch (step.kind) {
      case 'ingress':
        if (step.envelope) {
          observer.acceptIngressFrame(step.envelope);
        }
        break;
      case 'receipt':
        if (step.receipt) {
          observer.acceptRequestReceipt({
            binding: activeBinding,
            connectionId,
            ...step.receipt,
          });
        }
        break;
      case 'confirmed_agent':
        if (step.confirmedAgent) {
          observer.acceptAgentAttribution({
            binding: activeBinding,
            agent: step.confirmedAgent.agent,
            roleKind: step.confirmedAgent.roleKind,
            milestoneId: step.confirmedAgent.milestoneId,
            evidence: {
              kind: 'replay',
              captureId: scenario.provenanceOrigin,
              ordinal: 0,
              observedAt: Date.now(),
            },
          });
        }
        break;
      case 'disconnect':
        observer.handleTransportClosed(activeBinding, step.connectionId ?? 'conn_unknown');
        break;
      case 'advance_generation':
        if (step.nextGeneration) {
          const nextBinding: RuntimeBinding = {
            ...activeBinding,
            generation: asBindingGeneration(step.nextGeneration),
          };
          observer.handleGenerationChanged(activeBinding, nextBinding);
          activeBinding = nextBinding;
        }
        break;
      case 'reconnect':
        connectionId = step.connectionId ?? 'conn_reconnected';
        observer.handleReconnect(
          activeBinding, connectionId, step.reconnectMode ?? 'resume', scenario.rootNativeSessionId,
        );
        break;
    }
  }

  return activeBinding;
}
