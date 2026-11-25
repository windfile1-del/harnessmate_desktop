import type {
  ActivityId,
  AgentLineage,
  NativeAgentId,
  RuntimeBinding,
  WorkflowId,
  WorkflowKind,
} from '@harnessmate/protocol';
import type {
  NativeRequestTargetResolution,
  NativeRequestTargetResolver,
  NativeRequestTargetResolverInput,
} from './types.js';

export interface StubChildSessionEntry {
  readonly childNativeSessionId: string;
  readonly agentId: NativeAgentId;
  readonly agentLabel?: string;
  readonly activityId?: ActivityId;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
  readonly lineage: AgentLineage;
  readonly turnId?: string | null;
}

export interface StubWorkflowAttributionEntry {
  readonly workflowId: WorkflowId;
  readonly workflowKind: WorkflowKind;
  readonly workflowLabel?: string;
  readonly activityId?: ActivityId;
  readonly agentId?: NativeAgentId;
  readonly agentLabel?: string;
  readonly toolCallIds?: readonly string[];
  readonly turnId?: string | null;
}

export interface StubActivityAttribution {
  readonly activityId: ActivityId;
  readonly turnId: string | null;
  readonly isDetached: boolean;
  readonly agentId?: NativeAgentId;
  readonly agentLabel?: string;
  readonly workflowId?: WorkflowId;
  readonly workflowKind?: WorkflowKind;
  readonly workflowLabel?: string;
}

/**
 * Frozen NP-05 child / NP-04 detached-activity target resolver stub.
 *
 * Allows NP-07 to verify real attribution rules (in-turn root, detached post-turn activity,
 * confirmed child session, AGY 1.5.16 parent-forwarded child/workflow requests, unresolved child,
 * and conflicting lineage) in isolation during G2 parallel development before NP-04/NP-05 merge.
 */
export class StubNativeRequestTargetResolver implements NativeRequestTargetResolver {
  private readonly rootSessions = new Map<string, string>();
  private readonly activeRootActivity = new Map<string, StubActivityAttribution>();
  private readonly childBySessionKey = new Map<string, StubChildSessionEntry>();
  private readonly workflowById = new Map<string, StubWorkflowAttributionEntry>();
  private readonly workflowByToolCall = new Map<string, StubWorkflowAttributionEntry>();

  private bindingKey(binding: RuntimeBinding, connectionId?: string): string {
    return connectionId
      ? `${binding.runtimeId}::${binding.generation}::${connectionId}`
      : `${binding.runtimeId}::${binding.generation}`;
  }

  registerRootSession(binding: RuntimeBinding, connectionId: string, rootNativeSessionId: string): void {
    this.rootSessions.set(this.bindingKey(binding, connectionId), rootNativeSessionId);
    this.rootSessions.set(this.bindingKey(binding), rootNativeSessionId);
  }

  setRootActivity(binding: RuntimeBinding, activity: StubActivityAttribution | null): void {
    const key = this.bindingKey(binding);
    if (!activity) {
      this.activeRootActivity.delete(key);
      return;
    }
    this.activeRootActivity.set(key, activity);
  }

  registerChildSession(binding: RuntimeBinding, entry: StubChildSessionEntry): void {
    this.childBySessionKey.set(
      `${binding.runtimeId}::${binding.generation}::${entry.childNativeSessionId}`,
      entry,
    );
  }

  registerWorkflow(binding: RuntimeBinding, entry: StubWorkflowAttributionEntry): void {
    this.workflowById.set(`${binding.runtimeId}::${binding.generation}::${entry.workflowId}`, entry);
    for (const tcId of entry.toolCallIds ?? []) {
      this.workflowByToolCall.set(`${binding.runtimeId}::${binding.generation}::${tcId}`, entry);
    }
  }

  clearBinding(binding: RuntimeBinding): void {
    const prefix = `${binding.runtimeId}::${binding.generation}`;
    for (const key of [...this.rootSessions.keys()]) {
      if (key.startsWith(prefix)) this.rootSessions.delete(key);
    }
    this.activeRootActivity.delete(prefix);
    for (const key of [...this.childBySessionKey.keys()]) {
      if (key.startsWith(prefix)) this.childBySessionKey.delete(key);
    }
    for (const key of [...this.workflowById.keys()]) {
      if (key.startsWith(prefix)) this.workflowById.delete(key);
    }
    for (const key of [...this.workflowByToolCall.keys()]) {
      if (key.startsWith(prefix)) this.workflowByToolCall.delete(key);
    }
  }

  getRootNativeSessionId(binding: RuntimeBinding, connectionId: string): string | null | undefined {
    return (
      this.rootSessions.get(this.bindingKey(binding, connectionId)) ??
      this.rootSessions.get(this.bindingKey(binding))
    );
  }

  resolveTarget(input: NativeRequestTargetResolverInput): NativeRequestTargetResolution {
    const rootSessionId =
      input.rootNativeSessionId ?? this.getRootNativeSessionId(input.binding, input.connectionId) ?? null;
    const rootAct = this.activeRootActivity.get(this.bindingKey(input.binding));
    const genPrefix = `${input.binding.runtimeId}::${input.binding.generation}`;

    // 1. Direct match against a known child native session ID
    const directChild = this.childBySessionKey.get(`${genPrefix}::${input.actualNativeSessionId}`);
    if (directChild) {
      const turnId = directChild.turnId ?? null;
      if (directChild.lineage === 'confirmed') {
        return {
          scope: 'confirmed_child',
          targetLineage: 'confirmed',
          agentId: directChild.agentId,
          ...(directChild.agentLabel ? { agentLabel: directChild.agentLabel } : {}),
          ...(directChild.activityId ? { activityId: directChild.activityId } : {}),
          ...(directChild.workflowId ? { workflowId: directChild.workflowId } : {}),
          ...(directChild.workflowKind ? { workflowKind: directChild.workflowKind } : {}),
          ...(directChild.workflowLabel ? { workflowLabel: directChild.workflowLabel } : {}),
          turnId,
          isDetached: turnId === null,
          forwardedToParentSession: false,
          provenanceReason: 'protocol_confirmed_child',
        };
      }
      return {
        scope: 'unknown_child',
        targetLineage: directChild.lineage,
        agentId: directChild.agentId,
        ...(directChild.agentLabel ? { agentLabel: directChild.agentLabel } : {}),
        ...(directChild.activityId ? { activityId: directChild.activityId } : {}),
        turnId,
        isDetached: turnId === null,
        forwardedToParentSession: false,
        provenanceReason:
          directChild.lineage === 'conflicting' ? 'conflicting_child_lineage' : 'unresolved_child_lineage',
      };
    }

    // 2. Request arrived on the root native session (including AGY 1.5.16 parent-forwarded child/workflow requests)
    if (rootSessionId && input.actualNativeSessionId === rootSessionId) {
      // 2a. Check explicit child hint on forwarded parent request
      if (input.childSessionHint) {
        const hintedChild = this.childBySessionKey.get(`${genPrefix}::${input.childSessionHint}`);
        if (hintedChild && hintedChild.lineage === 'confirmed') {
          const turnId = hintedChild.turnId ?? rootAct?.turnId ?? null;
          return {
            scope: 'confirmed_child',
            targetLineage: 'confirmed',
            agentId: hintedChild.agentId,
            ...(hintedChild.agentLabel ? { agentLabel: hintedChild.agentLabel } : {}),
            ...(hintedChild.activityId ?? rootAct?.activityId
              ? { activityId: hintedChild.activityId ?? rootAct?.activityId }
              : {}),
            ...(hintedChild.workflowId ? { workflowId: hintedChild.workflowId } : {}),
            ...(hintedChild.workflowKind ? { workflowKind: hintedChild.workflowKind } : {}),
            ...(hintedChild.workflowLabel ? { workflowLabel: hintedChild.workflowLabel } : {}),
            turnId,
            isDetached: turnId === null || Boolean(rootAct?.isDetached),
            forwardedToParentSession: true,
            provenanceReason: 'forwarded_confirmed_child_via_parent',
          };
        }
        return {
          scope: 'root',
          targetLineage: hintedChild?.lineage === 'conflicting' ? 'conflicting' : 'unresolved',
          ...(hintedChild?.agentId ? { agentId: hintedChild.agentId } : {}),
          ...(rootAct?.activityId ? { activityId: rootAct.activityId } : {}),
          turnId: rootAct?.turnId ?? null,
          isDetached: rootAct ? rootAct.isDetached : true,
          forwardedToParentSession: true,
          provenanceReason:
            hintedChild?.lineage === 'conflicting'
              ? 'forwarded_conflicting_child_hint'
              : 'forwarded_unconfirmed_child_hint',
        };
      }

      // 2b. Check confirmed workflow attribution (by workflowIdHint or toolCallId)
      const matchedWorkflow =
        (input.workflowIdHint ? this.workflowById.get(`${genPrefix}::${input.workflowIdHint}`) : undefined) ??
        (input.toolCallId ? this.workflowByToolCall.get(`${genPrefix}::${input.toolCallId}`) : undefined);
      if (matchedWorkflow) {
        const turnId = matchedWorkflow.turnId ?? rootAct?.turnId ?? null;
        return {
          scope: 'confirmed_workflow',
          targetLineage: 'confirmed',
          ...(matchedWorkflow.agentId ? { agentId: matchedWorkflow.agentId } : {}),
          ...(matchedWorkflow.agentLabel ? { agentLabel: matchedWorkflow.agentLabel } : {}),
          ...(matchedWorkflow.activityId ?? rootAct?.activityId
            ? { activityId: matchedWorkflow.activityId ?? rootAct?.activityId }
            : {}),
          workflowId: matchedWorkflow.workflowId,
          workflowKind: matchedWorkflow.workflowKind,
          ...(matchedWorkflow.workflowLabel ? { workflowLabel: matchedWorkflow.workflowLabel } : {}),
          turnId,
          isDetached: turnId === null || Boolean(rootAct?.isDetached),
          forwardedToParentSession: true,
          provenanceReason: 'forwarded_confirmed_workflow_via_parent',
        };
      }

      // 2c. Standard root session request (in-turn or detached background/continuation activity)
      return {
        scope: 'root',
        targetLineage: 'confirmed',
        ...(rootAct?.agentId ? { agentId: rootAct.agentId } : {}),
        ...(rootAct?.agentLabel ? { agentLabel: rootAct.agentLabel } : {}),
        ...(rootAct?.activityId ? { activityId: rootAct.activityId } : {}),
        ...(rootAct?.workflowId ? { workflowId: rootAct.workflowId } : {}),
        ...(rootAct?.workflowKind ? { workflowKind: rootAct.workflowKind } : {}),
        ...(rootAct?.workflowLabel ? { workflowLabel: rootAct.workflowLabel } : {}),
        turnId: rootAct?.turnId ?? null,
        isDetached: rootAct ? rootAct.isDetached : true,
        forwardedToParentSession: false,
        provenanceReason: rootAct?.isDetached ? 'root_detached_activity' : 'root_session_match',
      };
    }

    // 3. Unknown foreign session (neither root session nor confirmed child)
    return {
      scope: 'unknown_child',
      targetLineage: 'unresolved',
      turnId: null,
      isDetached: true,
      forwardedToParentSession: false,
      provenanceReason: rootSessionId ? 'unknown_foreign_session' : 'unverified_root_session_binding',
    };
  }
}
