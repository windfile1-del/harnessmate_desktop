import { sanitizeAgentIdentityForPublic, sanitizeNativeWorkForPublic, type RuntimeBinding, type Session,
  type UpdateSessionRequest } from '@harnessmate/protocol';
import { HarnessCommandTools } from '../../../../core/harness-commands.js';
import type { SessionManager } from '../../../../core/session-manager.js';
import type { AcpSessionHandle } from '../../../acp/strict-acp-adapter.js';
import type { HarnessRegistry } from '../../../registry.js';
import { AgyAdapter } from '../../agy-driver.js';
import { ChildSessionRouter } from '../child/child-session-router.js';
import { AgyNativeCommandCatalogService } from '../commands/catalog.js';
import { AgyNativeCommandRouter, NativeCommandRouterError, type NativeConfigApplyInput } from '../commands/router.js';
import type { ObservedRuntimeSignals } from '../commands/descriptors.js';
import { NativePermissionRouter } from '../requests/native-permission-router.js';
import type { NativeRequestTargetResolution } from '../requests/types.js';
import { AgyReactiveRuntimeController } from '../runtime/controller.js';
import type { AgyNativeRuntimeRegistry } from './registry.js';
import { registerSwarmCapabilityDescriptors } from '../workflows/swarm/descriptors.js';
import { createBoostCapabilityContribution } from '../workflows/boost/resolver.js';
import { TEAMWORK_CAPABILITY_CONTRIBUTION } from '../workflows/teamwork/ports.js';
import { DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION } from '../workflows/dynamic/ports.js';
import { AgySwarmObserver } from '../workflows/swarm/swarm-observer.js';
import { BoostWorkflowObserver } from '../workflows/boost/observer.js';
import { AgyTeamworkWorkflowObserver } from '../workflows/teamwork/observer.js';
import { DynamicWorkflowObserver } from '../workflows/dynamic/observer.js';
import type { NativeConnectionPort, NativeWorkflowResourceReaderPort } from './types.js';

interface AttachedConnection {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly rootNativeSessionId: string;
  readonly handle: AcpSessionHandle;
  readonly profileRef: string;
  readonly sourceRef: string;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return a.runtimeId === b.runtimeId && a.generation === b.generation &&
    a.sessionId === b.sessionId && a.instanceId === b.instanceId;
}

export function wireAgyNativeRuntime(
  registry: AgyNativeRuntimeRegistry,
  sessions: SessionManager,
  adapters: HarnessRegistry,
  binaryOverrides: Record<string, string>,
): () => void {
  const lifecycle = new AgyReactiveRuntimeController({ publisher: registry });
  const child = new ChildSessionRouter();
  const swarm = new AgySwarmObserver({ gates: { swarmEnabled: true, boardFeedEnabled: false } });
  const boost = new BoostWorkflowObserver();
  const teamwork = new AgyTeamworkWorkflowObserver({ featureGates: { teamworkEnabled: true } });
  const dynamic = new DynamicWorkflowObserver({ strictMode: true });
  const workflowReaders = {
    swarm, boost, teamwork: teamwork.createResourceReader(), dynamic,
  };
  const catalog = new AgyNativeCommandCatalogService(undefined, (action) =>
    action.lane !== 'live_workflow' || (action.key === 'cancel' && registry.getFeatureFlags().nativeLifecycle));
  const tools = new HarnessCommandTools(() => undefined, binaryOverrides, adapters);
  const connections = new Map<string, AttachedConnection>();

  function getConnection(binding: RuntimeBinding): AttachedConnection | undefined {
    const scope = connections.get(binding.sessionId);
    return scope && sameBinding(scope.binding, binding) ? scope : undefined;
  }

  function hasCurrentBinding(binding: RuntimeBinding): boolean {
    const active = registry.getActiveBinding(binding.sessionId, binding.instanceId);
    return Boolean(active && sameBinding(active, binding));
  }

  function requireConnection(binding: RuntimeBinding): AttachedConnection {
    const scope = getConnection(binding);
    const active = registry.getActiveBinding(binding.sessionId, binding.instanceId);
    if (!scope || !active || !sameBinding(active, binding) ||
        scope.handle.nativeSessionId !== scope.rootNativeSessionId) {
      throw new NativeCommandRouterError('STALE_BINDING', 409, 'The AGY connection has changed');
    }
    return scope;
  }

  function requireSession(binding: RuntimeBinding): Session {
    const session = sessions.getSession(binding.sessionId);
    if (!session || session.harnessKind !== 'agy' || session.harnessId !== binding.instanceId) {
      throw new NativeCommandRouterError('STALE_BINDING', 409, 'The AGY profile has changed');
    }
    return session;
  }

  function updateCatalog(binding: RuntimeBinding, patch: Partial<ObservedRuntimeSignals>): void {
    if (!registry.getFeatureFlags().nativeCommands) return;
    const { snapshot, changedDescriptorIds } = catalog.updateBindingSignals(binding, patch);
    const persisted = registry.persistence.getBinding(binding.runtimeId);
    if (persisted?.generation !== binding.generation ||
        persisted.capabilitiesRevision === snapshot.capabilitiesRevision) return;
    registry.commitAndPublish(binding, {
      capabilitiesRevision: snapshot.capabilitiesRevision,
      capabilityDescriptors: snapshot.descriptors,
    }, {
      type: 'native.capabilities.changed',
      turnId: null,
      payload: { capabilitiesRevision: snapshot.capabilitiesRevision, changedDescriptorIds },
    });
  }

  let removeWorkflowDescriptors: (() => void) | undefined;

  function refresh(binding: RuntimeBinding, handle: AcpSessionHandle): void {
    const scope = getConnection(binding);
    if (!scope || scope.handle !== handle) return;
    const adapter = adapters.get(binding.instanceId);
    const profile = adapter instanceof AgyAdapter ? adapter.getProfile() : null;
    const signals = handle.getNativeSessionSignals();
    if (registry.getFeatureFlags().nativeWorkflowObservation) {
      if (!removeWorkflowDescriptors) {
        const dispose = [
          registerSwarmCapabilityDescriptors(catalog, swarm.getGates()),
          catalog.registerWorkflowDescriptor(createBoostCapabilityContribution()),
          catalog.registerWorkflowDescriptor(TEAMWORK_CAPABILITY_CONTRIBUTION),
          catalog.registerWorkflowDescriptor(DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION),
        ];
        removeWorkflowDescriptors = () => dispose.forEach((unregister) => unregister());
      }
    } else if (removeWorkflowDescriptors) {
      removeWorkflowDescriptors();
      removeWorkflowDescriptors = undefined;
    }
    updateCatalog(binding, {
      ...signals,
      effectivePermissionMode: signals.effectiveEnforcement === 'native'
        ? signals.effectivePermissionMode : undefined,
      profileRef: scope.profileRef,
      source: scope.sourceRef,
      profileVerified: Boolean(profile?.identity),
      authMethod: profile?.authMethod,
      protocolVersion: 1,
      hasLiveConnection: true,
      supportsActiveSteering: adapter?.capabilitiesV2?.supportsActiveSteering,
    });
  }

  const workflowBindings = new Map<string, RuntimeBinding>();

  const connection: NativeConnectionPort = {
    attach(binding, handle) {
      const rootNativeSessionId = handle.nativeSessionId;
      const connectionId = handle.getConnectionId();
      const stored = registry.persistence.getBinding(binding.runtimeId);
      if (!rootNativeSessionId || !connectionId || !stored || !sameBinding(stored, binding) ||
          !hasCurrentBinding(binding)) return;
      const scope = {
        binding, connectionId, rootNativeSessionId, handle,
        profileRef: stored.profileRef, sourceRef: stored.sourceRef,
      };
      const previous = connections.get(binding.sessionId);
      if (previous?.handle === handle && sameBinding(previous.binding, binding)) return;
      if (previous) registry.handleTransportClosed(previous.binding, previous.connectionId, 'connection_replaced');
      connections.set(binding.sessionId, scope);
      if (registry.getFeatureFlags().nativeWorkflowObservation) {
        swarm.registerBinding(scope);
        boost.registerBinding(scope);
        const priorWorkflowBinding = workflowBindings.get(binding.sessionId);
        if (priorWorkflowBinding && !sameBinding(priorWorkflowBinding, binding)) {
          teamwork.handleGenerationChanged(priorWorkflowBinding, binding);
        }
        workflowBindings.set(binding.sessionId, binding);
        teamwork.handleReconnect(binding, connectionId, previous ? 'resume' : 'fresh', rootNativeSessionId);
        dynamic.registerRootSession(binding, rootNativeSessionId, connectionId);
      }
      if (registry.getFeatureFlags().nativeLifecycle || registry.getFeatureFlags().nativePermissions) {
        const { rootAgentId } = child.registerBinding(scope);
        const root = child.getStateSnapshot(binding)?.agents.find((agent) => agent.id === rootAgentId);
        if (root) registry.commitAndPublish(binding, { agents: [root] }, {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(root, Date.now()) },
          mutationKey: `root_agent:${root.id}`,
        });
      }
      refresh(binding, handle);
    },
    refresh,
    ingest(envelope) {
      const scope = getConnection(envelope.binding);
      if (envelope.channel !== 'live') return false;
      if ((scope && scope.connectionId !== envelope.connectionId) || !registry.isActiveBinding(envelope.binding)) return true;
      if (!scope) return false;
      const flags = registry.getFeatureFlags();
      const method = (envelope.wire as { method?: unknown } | null)?.method;
      if (method !== 'session/update') return false;
      if (flags.nativeWorkflowObservation) {
        const swarmResult = swarm.acceptFrame(envelope, scope);
        swarm.commitToRegistry(registry, scope.binding, swarmResult.commits);
        boost.commitToRegistry(registry, scope.binding, boost.acceptFrame(envelope).commits);
        if (teamwork.acceptIngressFrame(envelope).accepted &&
            teamwork.getWorkflowEntity(scope.binding)?.state.kind !== 'unknown') {
          teamwork.commitToRegistry(registry, scope.binding);
        }
        dynamic.commitToRegistry(registry, scope.binding, dynamic.acceptFrame(envelope).commits);
      }
      if (!flags.nativeLifecycle) return false;
      const result = child.acceptFrame(envelope, scope);
      child.commitToRegistry(registry, scope.binding, result.commits);
      return result.accepted || result.buffered ||
        Boolean(envelope.originSession && envelope.originSession !== scope.rootNativeSessionId);
    },
    close(binding, connectionId) {
      const scope = connections.get(binding.sessionId);
      if (!scope) return true;
      if (!sameBinding(scope.binding, binding) || scope.connectionId !== connectionId) return false;
      connections.delete(binding.sessionId);
      const swarmClosed = swarm.handleTransportClosed(binding, connectionId);
      const boostClosed = boost.handleTransportClosed(binding, connectionId);
      const teamworkRevision = teamwork.getWorkflowEntity(binding)?.revision;
      teamwork.handleTransportClosed(binding, connectionId);
      const dynamicClosed = dynamic.handleTransportClosed(binding, connectionId);
      if (!hasCurrentBinding(binding)) {
        child.handleTransportClosed(binding, connectionId);
        return true;
      }
      swarm.commitToRegistry(registry, binding, swarmClosed);
      boost.commitToRegistry(registry, binding, boostClosed);
      const teamworkClosed = teamwork.getWorkflowEntity(binding);
      if (teamworkClosed && teamworkClosed.state.kind !== 'unknown' &&
          teamworkClosed.revision !== teamworkRevision) teamwork.commitToRegistry(registry, binding);
      for (const batch of dynamicClosed) dynamic.commitToRegistry(registry, binding, batch);
      const before = child.getStateSnapshot(binding);
      child.handleTransportClosed(binding, connectionId);
      const after = child.getStateSnapshot(binding);
      const now = Date.now();
      const oldAgentRevisions = new Map(before?.agents.map((agent) => [agent.id, agent.revision]));
      for (const agent of after?.agents ?? []) {
        if (agent.revision === oldAgentRevisions.get(agent.id)) continue;
        registry.commitAndPublish(binding, { agents: [agent] }, {
          type: 'native.agent.changed',
          turnId: null,
          payload: { agent: sanitizeAgentIdentityForPublic(agent, now) },
        });
      }
      const oldWorkRevisions = new Map(before?.work.map((work) => [work.id, work.revision]));
      for (const work of after?.work ?? []) {
        if (work.revision === oldWorkRevisions.get(work.id)) continue;
        registry.commitAndPublish(binding, { work: [work] }, {
          type: 'native.work.changed',
          turnId: null,
          payload: { work: sanitizeNativeWorkForPublic(work, now) },
        });
      }
      updateCatalog(binding, { hasLiveConnection: false, profileVerified: false, advertisedCommands: [] });
      return true;
    },
  };

  const permissions = new NativePermissionRouter(registry, {
    unknownChildPolicy: 'reject_immediately',
    onRequestSettled: (binding, rpcId, state, connectionId) => {
      lifecycle.resolveWirePendingRequest(binding, rpcId, state, connectionId);
    },
    targetResolver: {
      getRootNativeSessionId(binding, connectionId) {
        const scope = getConnection(binding);
        return scope?.connectionId === connectionId ? scope.rootNativeSessionId : null;
      },
      resolveTarget(input): NativeRequestTargetResolution {
        const scope = getConnection(input.binding);
        const activity = lifecycle.getWireRequestActivity(input.binding, input.connectionId, input.wireRequestId);
        const base = { turnId: activity?.turnId ?? null, isDetached: !activity?.turnId };
        if (!scope || scope.connectionId !== input.connectionId) {
          return { ...base, scope: 'unknown_child', targetLineage: 'unresolved',
            forwardedToParentSession: false, provenanceReason: 'connection_not_attached' };
        }
        const match = child.resolveScope({
          ...scope,
          wireSessionId: input.actualNativeSessionId,
          toolCallId: input.toolCallId,
          wireChildSessionId: input.childSessionHint,
        });
        const verifiedChild = !match.rejectRequest && match.allowConfirmedChildAttribution;
        const root = !match.rejectRequest && match.matchKind === 'root_session';
        return {
          ...base,
          scope: verifiedChild ? 'confirmed_child' : root ? 'root' : 'unknown_child',
          targetLineage: match.lineage,
          ...(verifiedChild && match.displayOwnerAgentId ? { agentId: match.displayOwnerAgentId } : {}),
          activityId: match.activityId ?? activity?.id,
          forwardedToParentSession: match.forwardedViaParent,
          provenanceReason: match.reasonCode,
        };
      },
    },
    approvalCenterBridge: {
      evaluateLocalAnnotations: (ctx) => sessions.getApprovalCenter().evaluateLocalRules(ctx),
      getSessionContext: (id) => sessions.getSession(id),
      mirrorPendingApproval: (approval) => sessions.mirrorNativeApproval(approval),
      syncResolvedApproval: (resolution) => sessions.syncNativeApproval(resolution),
    },
  });

  async function applySessionConfig(input: NativeConfigApplyInput) {
    const { binding, kind, value } = input;
    const { handle } = requireConnection(binding);
    return sessions.withIdleNativeHandle(binding, handle, async () => {
      requireConnection(binding);
      if (value === null) {
        const current = handle.getNativeSessionSignals();
        const effectiveValue = kind === 'model' ? current.effectiveModel
          : kind === 'effort' ? current.effectiveEffort : current.appliedModeId ?? null;
        return { applied: false, effectiveScope: 'read_only' as const, effectiveValue,
          note: 'The live ACP session has no verified reset for this setting' };
      }
      const patch: UpdateSessionRequest = kind === 'model' ? { model: value }
        : kind === 'effort' ? { reasoningEffort: value as Session['reasoningEffort'] }
          : { permissionMode: value as Session['permissionMode'] };
      let note: string | undefined;
      try {
        await handle.updateConfig(patch);
      } catch {
        note = 'ACP rejected the requested configuration';
      }
      requireConnection(binding);
      const current = handle.getNativeSessionSignals();
      const modeId = current.appliedModeId === 'default' ? 'manual'
        : current.appliedModeId === 'accept-edits' ? 'accept_edits' : current.appliedModeId;
      const effectiveValue = kind === 'model' ? current.effectiveModel
        : kind === 'effort' ? current.effectiveEffort : modeId ?? null;
      const enforcement = kind === 'permission_mode' ? current.effectiveEnforcement : undefined;
      const applied = !note && effectiveValue === value && enforcement !== 'client_guard';
      if (applied) await sessions.updateSession(binding.sessionId, patch, true);
      return { applied, effectiveValue, effectiveScope: 'immediate' as const, enforcement, note };
    });
  }

  const commandRouter = new AgyNativeCommandRouter({
    catalog,
    resolveTargetDescriptor: (binding) => {
      const adapter = adapters.get(binding.instanceId);
      return {
        instanceId: binding.instanceId,
        driverId: 'agy',
        profile: adapter instanceof AgyAdapter ? adapter.getProfile() : null,
      };
    },
    queryUsage: async (binding) => ({ output: await tools.getUsage(requireSession(binding)) }),
    querySkills: async (binding) => ({ skills: await tools.listAgySkillsForSession(requireSession(binding)) }),
    applySessionConfig,
    // Additional workflow modes need their own evidence and adapters.
    isNativeWorkflowRoutingEnabled: () => false,
    dispatchLiveWorkflow: async (input) => {
      const { handle } = requireConnection(input.binding);
      function verifyPlanDispatch() {
        const scope = requireConnection(input.binding);
        const signals = scope.handle.getNativeSessionSignals();
        if (scope.handle !== handle || input.actionKey !== 'set_plan_mode' ||
            signals.appliedModeId !== 'plan' || signals.effectiveEnforcement !== 'native') {
          throw new NativeCommandRouterError('UNSUPPORTED_ACTION', 422, 'The live ACP plan state changed');
        }
      }
      verifyPlanDispatch();
      if (input.attachmentIds.length !== (input.attachments?.length ?? 0)) {
        throw new NativeCommandRouterError('INVALID_REQUEST', 400, 'Workflow attachments could not be resolved');
      }
      const result = await sessions.sendTurn(input.binding.sessionId, input.promptText, [...(input.attachments ?? [])],
        { expectedNativeHandle: handle, verifyNativeDispatch: verifyPlanDispatch,
          literalText: true, omitHandoff: true, dispatchProvenance: input.provenance });
      const activity = lifecycle.getRuntimeSnapshot(input.binding)?.activities.find((item) => item.turnId === result.turnId);
      return { ...result, activityId: activity?.id };
    },
    dispatchNativeCancel: async ({ binding, target }) => {
      const { handle } = requireConnection(binding);
      if (!registry.getFeatureFlags().nativeLifecycle ||
          target.type !== 'runtime' || target.id !== binding.runtimeId) {
        throw new NativeCommandRouterError('UNSUPPORTED_ACTION', 422, 'Only the root ACP session can be stopped');
      }
      const accepted = handle.requestNativeSessionCancel();
      if (accepted) registry.notifyCancelRequested(binding, target);
      return { accepted, state: accepted ? 'requested' : 'unknown',
        revision: registry.persistence.getBinding(binding.runtimeId)?.asOfSeq ?? 0 };
    },
  });

  const workflowResourceReader: NativeWorkflowResourceReaderPort = {
    readWorkflowResource(input) {
      const projection = registry.getProjectionForSession(input.binding.sessionId, input.binding.instanceId);
      const workflow = sameBinding(projection.binding, input.binding)
        ? projection.workflows.find((item) => item.id === input.workflowId)
        : undefined;
      const kind = workflow?.detail.kind;
      if (kind === 'swarm' || kind === 'boost' || kind === 'teamwork' || kind === 'dynamic') {
        return workflowReaders[kind].readWorkflowResource(input);
      }
      return { revision: projection.asOfSeq, available: false, items: [], nextPageToken: null,
        hasMore: false, sourceUnavailableReason: 'workflow_resource_not_available' };
    },
  };

  registry.registerModules({
    connection, lifecycle, permissions, commandRouter, workflowResourceReader,
    timelineReader: { readTimeline: (input) => input.scopeKind === 'agent'
      ? child.readTimeline(input) : lifecycle.readTimeline(input) },
  });

  return () => {
    permissions.dispose();
    lifecycle.dispose();
    removeWorkflowDescriptors?.();
    connections.clear();
    workflowBindings.clear();
  };
}
