import type { InstalledPluginInfo } from '@harnessmate/protocol';
import { ApiHttpError, daemonApi } from './client';
import {
  ContractCallError,
  resolveServiceSelectionClientSide,
  type HistoryImportCommitRequest,
  type HistoryImportCommitValue,
  type HistoryImportPreviewRequest,
  type HistoryImportPreviewValue,
  type HistorySourceDiscoverRequest,
  type HistorySourceDiscoverValue,
  type HistorySourceReadRequest,
  type HistorySourceReadValue,
  type ImportInput,
  type SearchCancelRequest,
  type SearchInstanceStatus,
  type SearchQueryRequest,
  type SearchQueryValue,
  type SearchReindexJob,
  type SearchReindexRequest,
  type SearchResumeRequest,
  type SelectionSource,
  type ServiceResolutionV1,
} from './peer-contracts';

export interface PeerWorkspaceTransport {
  resolveServiceSelection(
    contract: string,
    opts: {
      versionRange?: string;
      sessionId?: string;
      workspaceId?: string;
      callerInstanceId?: string;
      explicitInstanceId?: string;
      allowSingleCandidate?: boolean;
      plugins: InstalledPluginInfo[];
      sessionBindings?: Record<string, string | null>;
      workspaceBindings?: Record<string, string | null>;
      compositionBindings?: Record<string, string | null>;
      compositionEntries?: Array<{ id: string; name?: string; disabled?: boolean }>;
      signal?: AbortSignal;
    },
  ): Promise<ServiceResolutionV1>;

  discoverSource(
    instanceId: string,
    req: HistorySourceDiscoverRequest,
    signal?: AbortSignal,
  ): Promise<HistorySourceDiscoverValue>;
  readSource(
    instanceId: string,
    req: HistorySourceReadRequest,
    signal?: AbortSignal,
  ): Promise<HistorySourceReadValue>;
  cancelSource(instanceId: string, operationId: string): Promise<{ cancelled: boolean }>;

  previewImport(
    instanceId: string,
    req: HistoryImportPreviewRequest,
    signal?: AbortSignal,
  ): Promise<HistoryImportPreviewValue>;
  commitImport(
    instanceId: string,
    req: HistoryImportCommitRequest,
    signal?: AbortSignal,
  ): Promise<HistoryImportCommitValue>;
  cancelImport(
    instanceId: string,
    payload: { requestId?: string; operationId?: string },
  ): Promise<{ cancelled: boolean }>;

  querySearch(
    instanceId: string,
    req: SearchQueryRequest,
    signal?: AbortSignal,
  ): Promise<SearchQueryValue>;
  getSearchStatus(instanceId: string, signal?: AbortSignal): Promise<SearchInstanceStatus>;
  reindexSearch(
    instanceId: string,
    req: SearchReindexRequest,
    signal?: AbortSignal,
  ): Promise<SearchReindexJob>;
  cancelSearchReindex(
    instanceId: string,
    req: SearchCancelRequest,
    signal?: AbortSignal,
  ): Promise<SearchReindexJob>;
  resumeSearchReindex(
    instanceId: string,
    req: SearchResumeRequest,
    signal?: AbortSignal,
  ): Promise<SearchReindexJob>;
}

export const defaultPeerWorkspaceTransport: PeerWorkspaceTransport = {
  async resolveServiceSelection(contract, opts) {
    if (typeof daemonApi.resolveServiceSelection === 'function') {
      try {
        return await daemonApi.resolveServiceSelection(contract, {
          versionRange: opts.versionRange,
          sessionId: opts.sessionId,
          workspaceId: opts.workspaceId,
          callerInstanceId: opts.callerInstanceId,
          explicitInstanceId: opts.explicitInstanceId,
          allowSingleCandidate: opts.allowSingleCandidate,
          signal: opts.signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Fallback cleanly to client-side resolution if backend route is not mounted yet (404 / 501 / offline)
        if (!(err instanceof ApiHttpError) || (err.status !== 404 && err.status !== 501 && err.status !== 405)) {
          // If backend returned a structured resolution in error payload, return it
          if (
            err instanceof ApiHttpError &&
            err.payload &&
            'resolution' in err.payload &&
            err.payload.resolution &&
            typeof err.payload.resolution === 'object'
          ) {
            return err.payload.resolution as ServiceResolutionV1;
          }
        }
      }
    }
    return resolveServiceSelectionClientSide({
      contract,
      versionRange: opts.versionRange,
      plugins: opts.plugins,
      explicitInstanceId: opts.explicitInstanceId,
      sessionBindings: opts.sessionBindings,
      workspaceBindings: opts.workspaceBindings,
      compositionBindings: opts.compositionBindings,
      compositionEntries: opts.compositionEntries,
      allowSingleCandidate: opts.allowSingleCandidate,
    });
  },

  discoverSource: (instanceId, req, signal) =>
    daemonApi.discoverHistoryFromInstance(instanceId, req, signal),
  readSource: (instanceId, req, signal) =>
    daemonApi.readHistoryFromInstance(instanceId, req, signal),
  cancelSource: (instanceId, operationId) =>
    daemonApi.cancelHistorySource(instanceId, operationId),

  previewImport: (instanceId, req, signal) =>
    daemonApi.previewHistoryImport(instanceId, req, signal),
  commitImport: (instanceId, req, signal) =>
    daemonApi.commitHistoryImport(instanceId, req, signal),
  cancelImport: (instanceId, payload) =>
    daemonApi.cancelHistoryImport(instanceId, payload),

  querySearch: (instanceId, req, signal) =>
    daemonApi.querySessionSearchInstance(instanceId, req, signal),
  getSearchStatus: (instanceId, signal) =>
    daemonApi.getSessionSearchStatus(instanceId, signal),
  reindexSearch: (instanceId, req, signal) =>
    daemonApi.reindexSessionSearchInstance(instanceId, req, signal),
  cancelSearchReindex: (instanceId, req, signal) =>
    daemonApi.cancelSessionSearchReindex(instanceId, req, signal),
  resumeSearchReindex: (instanceId, req, signal) =>
    daemonApi.resumeSessionSearchReindex(instanceId, req, signal),
};

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('name' in err && (err as { name?: string }).name === 'AbortError') return true;
  if (err instanceof ContractCallError && err.code === 'cancelled') return true;
  return false;
}

const SELECTION_SOURCE_LABELS: Record<SelectionSource, string> = {
  explicit: '显式实例',
  session: '会话绑定',
  workspace: '工作区绑定',
  dependency: '依赖绑定',
  composition: '组合默认',
  single: '唯一候选',
  none: '未指定',
};

export function formatSelectionSource(source: SelectionSource): string {
  return SELECTION_SOURCE_LABELS[source] ?? source;
}

export function formatResolutionSummary(resolution: ServiceResolutionV1): {
  label: string;
  tone: 'ready' | 'warning' | 'error' | 'muted';
  detail: string;
} {
  const sourceLabel = formatSelectionSource(resolution.source);
  switch (resolution.status) {
    case 'ready':
      return {
        label: '就绪',
        tone: 'ready',
        detail: `${resolution.instanceId}（${sourceLabel}）`,
      };
    case 'disabled':
      return {
        label: '已停用',
        tone: 'warning',
        detail: `已选实例 ${resolution.instanceId}（${sourceLabel}）当前已停用，保留绑定，启用后自动恢复。`,
      };
    case 'incompatible':
      return {
        label: '版本不兼容',
        tone: 'error',
        detail: `已选实例 ${resolution.instanceId}（${sourceLabel}）不满足契约版本 ${resolution.versionRange}。`,
      };
    case 'unavailable':
      return {
        label: '不可用',
        tone: 'error',
        detail: `已选实例 ${resolution.instanceId}（${sourceLabel}）当前未运行或未注册服务。`,
      };
    case 'selection_required':
      return {
        label: '待选择实例',
        tone: 'warning',
        detail: `检测到 ${resolution.candidates.length} 个兼容候选，请选择要使用的实例。`,
      };
    case 'unconfigured':
      return {
        label: '未配置',
        tone: 'muted',
        detail: `当前组合中没有就绪的 ${resolution.contract} 实例。`,
      };
  }
}

export function buildImportIntentSignature(input: ImportInput, workspaceId?: string): string {
  if (input.kind === 'native') {
    return [
      'native',
      input.ref.sourceInstanceId,
      input.ref.sourceId,
      input.ref.nativeSessionId,
      input.mode,
      workspaceId ?? '',
    ].join('|');
  }
  return [
    'bundle',
    input.bundle.session.originalId,
    input.bundle.exportedAt,
    input.titleOverride ?? '',
    workspaceId ?? '',
  ].join('|');
}

export class ImportRequestIdTracker {
  private lastSignature: string | null = null;
  private lastRequestId: string | null = null;
  private counter = 0;

  getOrCreate(input: ImportInput, workspaceId?: string): string {
    const signature = buildImportIntentSignature(input, workspaceId);
    if (this.lastSignature === signature && this.lastRequestId) {
      return this.lastRequestId;
    }
    const nextId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `import-${crypto.randomUUID()}`
        : `import-${Date.now()}-${++this.counter}`;
    this.lastSignature = signature;
    this.lastRequestId = nextId;
    return nextId;
  }

  clear(): void {
    this.lastSignature = null;
    this.lastRequestId = null;
  }
}
