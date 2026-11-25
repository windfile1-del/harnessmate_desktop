import type {
  ActivityId,
  AgentLineage,
  Evidence,
  NativeAgentId,
  RuntimeBinding,
  WorkId,
} from '@harnessmate/protocol';

/**
 * Frozen shared contract revision for NP-05 <-> NP-07 child scope & route resolution.
 * Both NP-05 (Agent Registry & Child Session Router) and NP-07 (Native Permission Router)
 * validate against this signature so neither side maps `toolCallId` ad-hoc in the frontend.
 */
export const CHILD_SCOPE_CONTRACT_REVISION = 'agy-np05-child-scope-v1.0.0' as const;

export const CHILD_ID_NAMESPACES = ['tool_call', 'native_record', 'session'] as const;
export type ChildIdNamespace = (typeof CHILD_ID_NAMESPACES)[number];

/**
 * Capabilities observed for a specific native child agent.
 * Per NP-05 scope rules:
 * - `canCancel` is ONLY true when explicitly advertised/verified on `child.capabilities`.
 * - `canSteer` and `canLoadDirect` are ALWAYS false (no simulated child prompt/steer, no direct child load).
 */
export interface ChildAgentCapabilities {
  readonly canObserveLiveStream: boolean;
  readonly canCancel: boolean;
  readonly canReadSnapshot: boolean;
  readonly canSteer: false;
  readonly canLoadDirect: false;
  readonly cancelReasonCode?: string;
}

export const READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES: Readonly<ChildAgentCapabilities> = Object.freeze({
  canObserveLiveStream: false,
  canCancel: false,
  canReadSnapshot: false,
  canSteer: false,
  canLoadDirect: false,
  cancelReasonCode: 'child_cancel_not_advertised',
});

export interface ChildRouteLookupInput {
  readonly binding: RuntimeBinding;
  /** Real outer JSON-RPC `params.sessionId` (the actual wire sender/reply target). */
  readonly wireSessionId: string;
  /** Root native sessionId currently bound to this runtime connection. */
  readonly rootNativeSessionId: string;
  /** Optional toolCallId carried inside request params (never blindly equated to a child sessionId). */
  readonly toolCallId?: string;
  /** Optional explicit child/subagent session ID carried inside request metadata/params. */
  readonly wireChildSessionId?: string;
  /** Immutable profile reference bound to this session (enforces cross-profile rejection). */
  readonly profileRef: string;
  /** Optional data source reference (e.g. 'acp', 'desktop', 'cli'). */
  readonly sourceRef?: string;
  /** Active live connection ID (prevents stale/prior connection routing). */
  readonly connectionId?: string;
}

export type ChildScopeMatchKind =
  | 'root_session'
  | 'forwarded_parent_with_inferred_child'
  | 'confirmed_child'
  | 'unresolved_child'
  | 'conflicting_child'
  | 'rejected_scope';

/**
 * Shared route resolution result handed to NP-07 (Native Permission Router).
 *
 * Key safety invariants:
 * 1. `actualWireSessionId` ALWAYS equals the real outer wire sender (`wireSessionId`) so
 *    NP-07 replies on the true protocol target without ever spoofing parent/child.
 * 2. When AGY 1.5.16+ forwards a child permission request on the parent wire session,
 *    `forwardedViaParent` is `true`, `actualWireSessionId` stays the parent session,
 *    and `displayOwnerAgentId` carries the verified child attribution separately.
 * 3. Unresolved, conflicting, cross-profile, or stale-generation targets NEVER set
 *    `allowConfirmedChildAttribution: true`.
 */
export interface ChildScopeResolution {
  readonly contractRevision: typeof CHILD_SCOPE_CONTRACT_REVISION;
  readonly matchKind: ChildScopeMatchKind;
  readonly actualWireSessionId: string;
  readonly forwardedViaParent: boolean;
  readonly targetAgentId?: NativeAgentId;
  readonly displayOwnerAgentId?: NativeAgentId;
  readonly lineage: AgentLineage;
  readonly launchWorkId?: WorkId;
  readonly activityId?: ActivityId;
  readonly capabilities: ChildAgentCapabilities;
  readonly evidence?: Evidence;
  readonly reasonCode: string;
  readonly allowConfirmedChildAttribution: boolean;
  readonly rejectRequest: boolean;
}

export interface ChildCancelAuthorization {
  readonly allowed: boolean;
  readonly targetAgentId: NativeAgentId;
  readonly wireSessionId?: string;
  readonly reasonCode: string;
}

/**
 * Frozen port consumed by NP-07 (and integration harnesses) to resolve child scopes
 * and verify native child cancel authorization.
 */
export interface ChildScopeResolverPort {
  readonly contractRevision: typeof CHILD_SCOPE_CONTRACT_REVISION;
  resolveScope(input: ChildRouteLookupInput): ChildScopeResolution;
  authorizeChildCancel(binding: RuntimeBinding, agentId: NativeAgentId): ChildCancelAuthorization;
  getChildCapabilities(binding: RuntimeBinding, agentId: NativeAgentId): ChildAgentCapabilities;
}

export interface AcpChildClientCapabilityDecision {
  readonly declareSubagentExtension: boolean;
  readonly protocolVersion: 1 | 2;
  readonly reasonCode: string;
  readonly clientCapabilitiesPatch: Record<string, unknown>;
}

/**
 * ACP subagent client capability gate.
 * Rule (06_Protocol_Evidence.md & NP-05): ONLY declare the optional ACP subagent client
 * extension when complete child routing (router + permission scope resolver + timeline buffer)
 * is wired and enabled for the negotiated protocol version.
 */
export function decideAcpChildClientCapabilities(opts: {
  readonly featureEnabled: boolean;
  readonly childRoutingWired: boolean;
  readonly permissionScopeResolverWired: boolean;
  readonly timelineBufferWired: boolean;
  readonly protocolVersion: 1 | 2;
  readonly acpV2PreviewEnabled?: boolean;
}): AcpChildClientCapabilityDecision {
  if (!opts.featureEnabled) {
    return {
      declareSubagentExtension: false,
      protocolVersion: opts.protocolVersion,
      reasonCode: 'child_feature_disabled',
      clientCapabilitiesPatch: {},
    };
  }
  if (!opts.childRoutingWired || !opts.permissionScopeResolverWired || !opts.timelineBufferWired) {
    return {
      declareSubagentExtension: false,
      protocolVersion: opts.protocolVersion,
      reasonCode: 'child_routing_incomplete',
      clientCapabilitiesPatch: {},
    };
  }
  if (opts.protocolVersion === 2 && opts.acpV2PreviewEnabled !== true) {
    return {
      declareSubagentExtension: false,
      protocolVersion: 2,
      reasonCode: 'acp_v2_preview_disabled',
      clientCapabilitiesPatch: {},
    };
  }

  return {
    declareSubagentExtension: true,
    protocolVersion: opts.protocolVersion,
    reasonCode: opts.protocolVersion === 2 ? 'full_child_routing_v2' : 'full_child_routing_v1',
    clientCapabilitiesPatch:
      opts.protocolVersion === 2
        ? { subagents: { sessionMessages: true, subagentUpdates: true } }
        : { experimental: { subagents: true } },
  };
}

/**
 * Deterministic frozen stub factory for NP-07 parallel testing against the shared
 * NP-05 child scope signature before full G2 wiring.
 */
export function createFrozenChildScopeResolverStub(config?: {
  readonly expectedBinding?: RuntimeBinding;
  readonly expectedProfileRef?: string;
  readonly confirmedChildrenByWireSessionId?: ReadonlyMap<
    string,
    {
      readonly agentId: NativeAgentId;
      readonly launchWorkId?: WorkId;
      readonly activityId?: ActivityId;
      readonly capabilities?: Partial<ChildAgentCapabilities>;
      readonly evidence?: Evidence;
    }
  >;
  readonly forwardedChildrenByToolCallId?: ReadonlyMap<
    string,
    {
      readonly agentId: NativeAgentId;
      readonly launchWorkId?: WorkId;
      readonly activityId?: ActivityId;
      readonly capabilities?: Partial<ChildAgentCapabilities>;
      readonly evidence?: Evidence;
    }
  >;
  readonly rootAgentId?: NativeAgentId;
}): ChildScopeResolverPort {
  const toCaps = (partial?: Partial<ChildAgentCapabilities>): ChildAgentCapabilities => ({
    canObserveLiveStream: Boolean(partial?.canObserveLiveStream),
    canCancel: Boolean(partial?.canCancel),
    canReadSnapshot: Boolean(partial?.canReadSnapshot),
    canSteer: false,
    canLoadDirect: false,
    ...(partial?.cancelReasonCode ? { cancelReasonCode: partial.cancelReasonCode } : {}),
  });

  return {
    contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
    resolveScope(input: ChildRouteLookupInput): ChildScopeResolution {
      if (config?.expectedBinding) {
        const exp = config.expectedBinding;
        if (
          input.binding.runtimeId !== exp.runtimeId ||
          input.binding.sessionId !== exp.sessionId ||
          input.binding.instanceId !== exp.instanceId ||
          input.binding.generation !== exp.generation
        ) {
          return {
            contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
            matchKind: 'rejected_scope',
            actualWireSessionId: input.wireSessionId,
            forwardedViaParent: false,
            lineage: 'unresolved',
            capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
            reasonCode: 'stale_binding_or_generation',
            allowConfirmedChildAttribution: false,
            rejectRequest: true,
          };
        }
      }

      if (config?.expectedProfileRef && input.profileRef !== config.expectedProfileRef) {
        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'rejected_scope',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: false,
          lineage: 'unresolved',
          capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
          reasonCode: 'cross_profile_scope_mismatch',
          allowConfirmedChildAttribution: false,
          rejectRequest: true,
        };
      }

      const wireIsRoot = input.wireSessionId === input.rootNativeSessionId;
      if (wireIsRoot) {
        const forwardedByChildHint = input.wireChildSessionId
          ? config?.confirmedChildrenByWireSessionId?.get(input.wireChildSessionId)
          : undefined;
        const forwardedByTool =
          !forwardedByChildHint && input.toolCallId
            ? config?.forwardedChildrenByToolCallId?.get(input.toolCallId)
            : undefined;
        const forwarded = forwardedByChildHint ?? forwardedByTool;

        if (forwarded) {
          return {
            contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
            matchKind: 'forwarded_parent_with_inferred_child',
            actualWireSessionId: input.wireSessionId,
            forwardedViaParent: true,
            ...(config?.rootAgentId ? { targetAgentId: config.rootAgentId } : {}),
            displayOwnerAgentId: forwarded.agentId,
            lineage: 'confirmed',
            ...(forwarded.launchWorkId ? { launchWorkId: forwarded.launchWorkId } : {}),
            ...(forwarded.activityId ? { activityId: forwarded.activityId } : {}),
            capabilities: toCaps(forwarded.capabilities),
            ...(forwarded.evidence ? { evidence: forwarded.evidence } : {}),
            reasonCode: 'forwarded_via_parent_verified_child',
            allowConfirmedChildAttribution: true,
            rejectRequest: false,
          };
        }

        if (input.wireChildSessionId && input.wireChildSessionId !== input.rootNativeSessionId) {
          return {
            contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
            matchKind: 'unresolved_child',
            actualWireSessionId: input.wireSessionId,
            forwardedViaParent: true,
            ...(config?.rootAgentId ? { targetAgentId: config.rootAgentId } : {}),
            lineage: 'unresolved',
            capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
            reasonCode: 'forwarded_child_identity_unverified',
            allowConfirmedChildAttribution: false,
            rejectRequest: false,
          };
        }

        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'root_session',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: false,
          ...(config?.rootAgentId ? { targetAgentId: config.rootAgentId } : {}),
          lineage: 'confirmed',
          capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
          reasonCode: 'root_wire_session',
          allowConfirmedChildAttribution: false,
          rejectRequest: false,
        };
      }

      const direct = config?.confirmedChildrenByWireSessionId?.get(input.wireSessionId);
      if (direct) {
        return {
          contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
          matchKind: 'confirmed_child',
          actualWireSessionId: input.wireSessionId,
          forwardedViaParent: false,
          targetAgentId: direct.agentId,
          displayOwnerAgentId: direct.agentId,
          lineage: 'confirmed',
          ...(direct.launchWorkId ? { launchWorkId: direct.launchWorkId } : {}),
          ...(direct.activityId ? { activityId: direct.activityId } : {}),
          capabilities: toCaps(direct.capabilities),
          ...(direct.evidence ? { evidence: direct.evidence } : {}),
          reasonCode: 'confirmed_child_wire_session',
          allowConfirmedChildAttribution: true,
          rejectRequest: false,
        };
      }

      return {
        contractRevision: CHILD_SCOPE_CONTRACT_REVISION,
        matchKind: 'unresolved_child',
        actualWireSessionId: input.wireSessionId,
        forwardedViaParent: false,
        lineage: 'unresolved',
        capabilities: READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES,
        reasonCode: 'unknown_non_root_wire_session',
        allowConfirmedChildAttribution: false,
        rejectRequest: false,
      };
    },

    authorizeChildCancel(binding: RuntimeBinding, agentId: NativeAgentId): ChildCancelAuthorization {
      if (
        config?.expectedBinding &&
        (binding.runtimeId !== config.expectedBinding.runtimeId ||
          binding.generation !== config.expectedBinding.generation)
      ) {
        return {
          allowed: false,
          targetAgentId: agentId,
          reasonCode: 'stale_binding_or_generation',
        };
      }
      for (const [wireSessionId, entry] of config?.confirmedChildrenByWireSessionId ?? []) {
        if (entry.agentId === agentId) {
          if (entry.capabilities?.canCancel === true) {
            return {
              allowed: true,
              targetAgentId: agentId,
              wireSessionId,
              reasonCode: 'child_cancel_capability_verified',
            };
          }
          return {
            allowed: false,
            targetAgentId: agentId,
            reasonCode: entry.capabilities?.cancelReasonCode ?? 'child_cancel_not_advertised',
          };
        }
      }
      return {
        allowed: false,
        targetAgentId: agentId,
        reasonCode: 'child_agent_not_confirmed',
      };
    },

    getChildCapabilities(binding: RuntimeBinding, agentId: NativeAgentId): ChildAgentCapabilities {
      if (
        config?.expectedBinding &&
        (binding.runtimeId !== config.expectedBinding.runtimeId ||
          binding.generation !== config.expectedBinding.generation)
      ) {
        return READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES;
      }
      for (const entry of config?.confirmedChildrenByWireSessionId?.values() ?? []) {
        if (entry.agentId === agentId) {
          return toCaps(entry.capabilities);
        }
      }
      return READ_ONLY_UNVERIFIED_CHILD_CAPABILITIES;
    },
  };
}
