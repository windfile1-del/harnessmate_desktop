import type { ApprovalRequest, ResolveApprovalRequest, Session } from '@harnessmate/protocol';
import type { ReactNode } from 'react';
import type {
  ActivityId,
  CapabilityDescriptor,
  NativeAgentId,
  NativeCommandSubmitRequest,
  NativeControlRequest,
  NativeRuntimeProjection,
  NativeTimelinePageResponse,
  NativeWorkflowResourcePageResponse,
  WorkId,
  WorkflowId,
} from '../../../../lib/native-client';

/**
 * Frozen AGY Workbench Registry & Stable Props Contract (NP-03).
 *
 * Domain tasks (NP-04 Runtime Center, NP-05 Subagent Manager, NP-08 Swarm, NP-09 Boost,
 * NP-10 Teamwork, NP-11 Dynamic Workflow, NP-12 Goal/Schedule) register their views here
 * without modifying ChatStage or shared store internals.
 */
export const WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03' as const;

export type WorkbenchSurfaceId =
  | 'runtime'
  | 'subagents'
  | 'swarm'
  | 'boost'
  | 'teamwork'
  | 'dynamic'
  | 'tasks';

export type WorkbenchActiveSurface = 'chat' | WorkbenchSurfaceId;

export type WorkbenchLayoutMode = 'split' | 'full';

export interface WorkbenchRouteState {
  surface: WorkbenchActiveSurface;
  layout: WorkbenchLayoutMode;
  selectedActivityId?: ActivityId | null;
  selectedWorkId?: WorkId | null;
  selectedAgentId?: NativeAgentId | null;
  selectedWorkflowId?: WorkflowId | null;
}

export const DEFAULT_WORKBENCH_ROUTE: WorkbenchRouteState = {
  surface: 'chat',
  layout: 'split',
  selectedActivityId: null,
  selectedWorkId: null,
  selectedAgentId: null,
  selectedWorkflowId: null,
};

export interface NativeWorkbenchViewProps {
  session: Session;
  projection: NativeRuntimeProjection | null;
  capabilities: readonly CapabilityDescriptor[];
  pendingApprovals: readonly ApprovalRequest[];
  route: WorkbenchRouteState;
  isNarrowViewport: boolean;
  onNavigate: (patch: Partial<WorkbenchRouteState>) => void;
  onBackToChat: () => void;
  onRefresh: () => void;
  onResolveRequest: (
    approvalId: string,
    req: ResolveApprovalRequest,
  ) => Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
  onSubmitCommand?: (
    req: Omit<NativeCommandSubmitRequest, 'bindingGeneration' | 'catalogRevision' | 'idempotencyKey'>,
  ) => Promise<void>;
  onDispatchControl?: (
    req: Omit<NativeControlRequest, 'generation' | 'idempotencyKey'>,
  ) => Promise<void>;
  loadTimeline?: (
    scope: { kind: 'activity' | 'agent'; id: string },
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeTimelinePageResponse>;
  loadWorkflowResource?: (
    workflowId: WorkflowId,
    resource: string,
    pageToken?: string | null,
    signal?: AbortSignal,
  ) => Promise<NativeWorkflowResourcePageResponse>;
}

export interface WorkbenchViewRegistration {
  readonly id: WorkbenchSurfaceId;
  readonly owner: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly description: string;
  /** Capability IDs associated with this view (e.g., AGY-W04 for Swarm). */
  readonly capabilityIds: readonly string[];
  /** Lower order wins when overriding built-in degraded shells (domain studios use < 500; defaults use 900). */
  readonly order?: number;
  readonly preferredLayout?: WorkbenchLayoutMode;
  readonly badgeCount?: (
    projection: NativeRuntimeProjection | null,
    pendingApprovals: readonly ApprovalRequest[],
  ) => number;
  readonly render: (props: NativeWorkbenchViewProps) => ReactNode;
}

export interface RegisteredWorkbenchView extends WorkbenchViewRegistration {
  readonly registrationKey: string;
  readonly seq: number;
}

export const WORKBENCH_SURFACE_ORDER: readonly WorkbenchSurfaceId[] = [
  'runtime',
  'subagents',
  'swarm',
  'boost',
  'teamwork',
  'dynamic',
  'tasks',
];

const SURFACE_SET = new Set<string>(WORKBENCH_SURFACE_ORDER);

/**
 * Serializes a session-scoped Workbench route using ONLY opaque HM-scoped IDs.
 * Never embeds private native session IDs, host paths, or credentials in URLs.
 */
export function serializeWorkbenchRouteHash(sessionId: string, route: WorkbenchRouteState): string {
  const params = new URLSearchParams();
  params.set('session', sessionId);
  params.set('surface', route.surface);
  if (route.layout !== 'split') params.set('layout', route.layout);
  if (route.selectedActivityId) params.set('activity', route.selectedActivityId);
  if (route.selectedWorkId) params.set('work', route.selectedWorkId);
  if (route.selectedAgentId) params.set('agent', route.selectedAgentId);
  if (route.selectedWorkflowId) params.set('workflow', route.selectedWorkflowId);
  return `#agy-workbench?${params.toString()}`;
}

export function parseWorkbenchRouteHash(
  hash: string,
  expectedSessionId: string,
): WorkbenchRouteState | null {
  if (!hash.startsWith('#agy-workbench?')) return null;
  const params = new URLSearchParams(hash.slice('#agy-workbench?'.length));
  if (params.get('session') !== expectedSessionId) return null;
  const rawSurface = params.get('surface') ?? 'chat';
  const surface: WorkbenchActiveSurface =
    rawSurface === 'chat' || SURFACE_SET.has(rawSurface)
      ? (rawSurface as WorkbenchActiveSurface)
      : 'chat';
  const layout: WorkbenchLayoutMode = params.get('layout') === 'full' ? 'full' : 'split';
  return {
    surface,
    layout,
    selectedActivityId: (params.get('activity') as ActivityId | null) ?? null,
    selectedWorkId: (params.get('work') as WorkId | null) ?? null,
    selectedAgentId: (params.get('agent') as NativeAgentId | null) ?? null,
    selectedWorkflowId: (params.get('workflow') as WorkflowId | null) ?? null,
  };
}

export class AgyWorkbenchRegistry {
  private readonly entries = new Map<string, RegisteredWorkbenchView>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private version = 0;
  private cachedVersion = -1;
  private cachedViews: readonly RegisteredWorkbenchView[] = [];

  registerView(registration: WorkbenchViewRegistration): () => void {
    const registrationKey = `${registration.owner}:${registration.id}`;
    const record: RegisteredWorkbenchView = {
      ...registration,
      registrationKey,
      seq: ++this.seq,
    };
    this.entries.set(registrationKey, record);
    this.bump();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.entries.get(registrationKey) === record) {
        this.entries.delete(registrationKey);
        this.bump();
      }
    };
  }

  /**
   * Returns one winning view per `WorkbenchSurfaceId` (lowest `order` wins, allowing domain
   * modules NP-04..NP-12 to cleanly override default degraded shells without editing ChatStage).
   */
  getViews(): readonly RegisteredWorkbenchView[] {
    if (this.cachedVersion === this.version) return this.cachedViews;

    const bestBySurface = new Map<WorkbenchSurfaceId, RegisteredWorkbenchView>();
    for (const entry of this.entries.values()) {
      const current = bestBySurface.get(entry.id);
      if (!current) {
        bestBySurface.set(entry.id, entry);
        continue;
      }
      const curOrder = current.order ?? 500;
      const nextOrder = entry.order ?? 500;
      if (nextOrder < curOrder || (nextOrder === curOrder && entry.seq > current.seq)) {
        bestBySurface.set(entry.id, entry);
      }
    }

    const ordered: RegisteredWorkbenchView[] = [];
    for (const surfaceId of WORKBENCH_SURFACE_ORDER) {
      const found = bestBySurface.get(surfaceId);
      if (found) ordered.push(found);
    }

    this.cachedViews = ordered;
    this.cachedVersion = this.version;
    return ordered;
  }

  getView(id: WorkbenchSurfaceId): RegisteredWorkbenchView | undefined {
    return this.getViews().find((v) => v.id === id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly RegisteredWorkbenchView[] => this.getViews();

  reset(): void {
    this.entries.clear();
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // isolate subscriber errors
      }
    }
  }
}

export const agyWorkbenchRegistry = new AgyWorkbenchRegistry();
