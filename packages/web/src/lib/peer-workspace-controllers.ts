import type { InstalledPluginInfo, SessionSearchHit } from '@harnessmate/protocol';
import { daemonApi } from '../api/client';
import {
  LEGACY_EXPLORER_PLUGIN_ID,
  getPluginInstanceId,
  isPluginInstanceReady,
  type HistoryImportCommitValue,
  type HistoryImportPreviewValue,
  type HistorySummary,
  type ImportInput,
  type SearchInstanceStatus,
  type SearchReindexJob,
} from '../api/peer-contracts';
import {
  ImportRequestIdTracker,
  defaultPeerWorkspaceTransport,
  isAbortError,
  type PeerWorkspaceTransport,
} from '../api/peer-workspace-client';

type Listener = () => void;

export interface SearchInstanceSlice {
  hits: SessionSearchHit[];
  nextOffset: number | null;
  offset: number;
  fallbackUsed: boolean;
  tookMs: number | null;
  searching: boolean;
  hasSearched: boolean;
  queryError: string | null;
  status: SearchInstanceStatus | null;
  statusError: string | null;
  reindexing: boolean;
  reindexError: string | null;
}

export function createEmptySearchSlice(): SearchInstanceSlice {
  return {
    hits: [],
    nextOffset: null,
    offset: 0,
    fallbackUsed: false,
    tookMs: null,
    searching: false,
    hasSearched: false,
    queryError: null,
    status: null,
    statusError: null,
    reindexing: false,
    reindexError: null,
  };
}

export interface SearchControllerState {
  activeInstanceId: string | null;
  slices: Record<string, SearchInstanceSlice>;
}

export class SessionSearchController {
  private state: SearchControllerState = {
    activeInstanceId: null,
    slices: {},
  };
  private readonly listeners = new Set<Listener>();
  private epoch = 0;
  private queryAbort: AbortController | null = null;
  private statusAbort: AbortController | null = null;
  private reindexAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly transport: PeerWorkspaceTransport = defaultPeerWorkspaceTransport) {}

  getSnapshot = (): SearchControllerState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private updateSlice(
    targetId: string,
    updater: (prev: SearchInstanceSlice) => SearchInstanceSlice,
  ): void {
    this.state = {
      ...this.state,
      slices: {
        ...this.state.slices,
        [targetId]: updater(this.state.slices[targetId] ?? createEmptySearchSlice()),
      },
    };
    this.emit();
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stopSubscriptionsAndRequests(): void {
    this.epoch += 1;
    this.clearPoll();
    this.queryAbort?.abort();
    this.queryAbort = null;
    this.statusAbort?.abort();
    this.statusAbort = null;
    this.reindexAbort?.abort();
    this.reindexAbort = null;

    // Reset transient loading flags without wiping existing results of previous instances
    const nextSlices = { ...this.state.slices };
    let changed = false;
    for (const [id, slice] of Object.entries(nextSlices)) {
      if (slice.searching || slice.reindexing) {
        nextSlices[id] = { ...slice, searching: false, reindexing: false };
        changed = true;
      }
    }
    if (changed) {
      this.state = { ...this.state, slices: nextSlices };
      this.emit();
    }
  }

  setActiveInstance(nextInstanceId: string | null): void {
    if (this.state.activeInstanceId === nextInstanceId) return;
    if (this.state.activeInstanceId !== null || nextInstanceId === null) {
      this.stopSubscriptionsAndRequests();
    }
    this.state = { ...this.state, activeInstanceId: nextInstanceId };
    this.emit();
    if (nextInstanceId && nextInstanceId !== LEGACY_EXPLORER_PLUGIN_ID) {
      void this.fetchStatus(nextInstanceId);
    }
  }

  async fetchStatus(targetId: string): Promise<void> {
    if (this.disposed || !targetId || targetId === LEGACY_EXPLORER_PLUGIN_ID) return;
    this.statusAbort?.abort();
    const controller = new AbortController();
    this.statusAbort = controller;
    const runEpoch = this.epoch;
    this.clearPoll();

    try {
      const status = await this.transport.getSearchStatus(targetId, controller.signal);
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId
      ) {
        return;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        status,
        statusError: null,
      }));
      if (
        status.activeJob &&
        (status.activeJob.status === 'queued' || status.activeJob.status === 'running')
      ) {
        this.pollTimer = setTimeout(() => {
          void this.fetchStatus(targetId);
        }, 1200);
      }
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId ||
        isAbortError(err)
      ) {
        return;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        statusError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (this.statusAbort === controller) {
        this.statusAbort = null;
      }
    }
  }

  async runSearch(
    targetId: string,
    params: {
      q: string;
      workspaceId?: string;
      driverId?: string;
      fromTs?: number;
      toTs?: number;
      limit?: number;
      offset?: number;
    },
  ): Promise<void> {
    if (this.disposed || !targetId || this.state.activeInstanceId !== targetId) return;
    const trimmed = params.q.trim();
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 20;

    this.queryAbort?.abort();
    if (!trimmed) {
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        hits: [],
        nextOffset: null,
        offset: 0,
        tookMs: null,
        searching: false,
        hasSearched: false,
        queryError: null,
      }));
      return;
    }

    const controller = new AbortController();
    this.queryAbort = controller;
    const runEpoch = this.epoch;

    this.updateSlice(targetId, (prev) => ({
      ...prev,
      searching: true,
      queryError: null,
      offset,
    }));

    try {
      if (targetId === LEGACY_EXPLORER_PLUGIN_ID) {
        const res = await daemonApi.searchSessions({
          q: trimmed,
          workspaceId: params.workspaceId,
          driverId: params.driverId,
          fromTs: params.fromTs,
          toTs: params.toTs,
          limit,
          offset,
        });
        if (
          this.disposed ||
          controller.signal.aborted ||
          runEpoch !== this.epoch ||
          this.state.activeInstanceId !== targetId
        ) {
          return;
        }
        this.updateSlice(targetId, (prev) => ({
          ...prev,
          hits: res.hits,
          nextOffset: res.hits.length >= limit ? offset + res.hits.length : null,
          fallbackUsed: res.fallbackUsed,
          tookMs: res.tookMs,
          searching: false,
          hasSearched: true,
          queryError: null,
        }));
        return;
      }

      const res = await this.transport.querySearch(
        targetId,
        {
          q: trimmed,
          workspaceId: params.workspaceId,
          driverId: params.driverId,
          fromTs: params.fromTs,
          toTs: params.toTs,
          limit,
          offset,
        },
        controller.signal,
      );
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId
      ) {
        return;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        hits: res.hits,
        nextOffset: res.nextOffset,
        fallbackUsed: res.fallbackUsed,
        tookMs: res.tookMs,
        searching: false,
        hasSearched: true,
        queryError: null,
      }));
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId ||
        isAbortError(err)
      ) {
        return;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        searching: false,
        hasSearched: true,
        queryError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (this.queryAbort === controller) {
        this.queryAbort = null;
      }
    }
  }

  async reindex(
    targetId: string,
    mode: 'full' | 'incremental',
    workspaceId?: string,
  ): Promise<SearchReindexJob | null> {
    if (this.disposed || !targetId || this.state.activeInstanceId !== targetId) return null;
    this.reindexAbort?.abort();
    const controller = new AbortController();
    this.reindexAbort = controller;
    const runEpoch = this.epoch;

    this.updateSlice(targetId, (prev) => ({
      ...prev,
      reindexing: true,
      reindexError: null,
    }));

    try {
      if (targetId === LEGACY_EXPLORER_PLUGIN_ID) {
        await daemonApi.rebuildSearchIndex();
        if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return null;
        this.updateSlice(targetId, (prev) => ({ ...prev, reindexing: false }));
        return null;
      }

      const job = await this.transport.reindexSearch(
        targetId,
        { mode, workspaceId },
        controller.signal,
      );
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId
      ) {
        return null;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        reindexing: false,
        reindexError: null,
        status: prev.status
          ? {
              ...prev.status,
              activeJob:
                job.status === 'queued' || job.status === 'running' ? job : null,
              lastJob: job,
            }
          : prev.status,
      }));
      void this.fetchStatus(targetId);
      return job;
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        this.state.activeInstanceId !== targetId ||
        isAbortError(err)
      ) {
        return null;
      }
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        reindexing: false,
        reindexError: err instanceof Error ? err.message : String(err),
      }));
      return null;
    } finally {
      if (this.reindexAbort === controller) {
        this.reindexAbort = null;
      }
    }
  }

  async cancelReindex(targetId: string, jobId?: string): Promise<void> {
    if (this.disposed || !targetId || targetId === LEGACY_EXPLORER_PLUGIN_ID) return;
    try {
      const job = await this.transport.cancelSearchReindex(targetId, { jobId });
      if (this.disposed || this.state.activeInstanceId !== targetId) return;
      this.clearPoll();
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        status: prev.status ? { ...prev.status, activeJob: null, lastJob: job } : prev.status,
      }));
      void this.fetchStatus(targetId);
    } catch (err) {
      if (this.disposed || this.state.activeInstanceId !== targetId) return;
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        reindexError: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async resumeReindex(targetId: string, jobId?: string): Promise<void> {
    if (this.disposed || !targetId || targetId === LEGACY_EXPLORER_PLUGIN_ID) return;
    try {
      const job = await this.transport.resumeSearchReindex(targetId, { jobId });
      if (this.disposed || this.state.activeInstanceId !== targetId) return;
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        reindexError: null,
        status: prev.status ? { ...prev.status, activeJob: job, lastJob: job } : prev.status,
      }));
      void this.fetchStatus(targetId);
    } catch (err) {
      if (this.disposed || this.state.activeInstanceId !== targetId) return;
      this.updateSlice(targetId, (prev) => ({
        ...prev,
        reindexError: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopSubscriptionsAndRequests();
    this.listeners.clear();
  }
}

export interface SourceDiscoverySlice {
  instanceId: string;
  name: string;
  enabled: boolean;
  ready: boolean;
  statusText: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  sessions: HistorySummary[];
  nextCursor: string | null;
  lastRefreshedAt: number | null;
}

export interface HistoryImportControllerState {
  activeImportInstanceId: string | null;
  sourcesMap: Record<string, SourceDiscoverySlice>;
  selectedSummary: HistorySummary | null;
  previewLoading: boolean;
  previewError: string | null;
  previewData: HistoryImportPreviewValue | null;
  importing: boolean;
  importError: string | null;
  importStatusNote: string | null;
  commitResult: HistoryImportCommitValue | null;
}

export class HistoryImportController {
  private state: HistoryImportControllerState = {
    activeImportInstanceId: null,
    sourcesMap: {},
    selectedSummary: null,
    previewLoading: false,
    previewError: null,
    previewData: null,
    importing: false,
    importError: null,
    importStatusNote: null,
    commitResult: null,
  };
  private readonly listeners = new Set<Listener>();
  private epoch = 0;
  private readonly sourceAborts = new Map<string, AbortController>();
  private previewAbort: AbortController | null = null;
  private importAbort: AbortController | null = null;
  private pendingOp: {
    instanceId: string;
    requestId?: string;
    operationId?: string;
    sourceInstanceId?: string;
    sourceOperationId?: string;
  } | null = null;
  readonly requestIdTracker = new ImportRequestIdTracker();
  private disposed = false;

  constructor(private readonly transport: PeerWorkspaceTransport = defaultPeerWorkspaceTransport) {}

  getSnapshot = (): HistoryImportControllerState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(patch: Partial<HistoryImportControllerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  cancelInFlight(notifyBackend = true): void {
    this.epoch += 1;
    for (const ctrl of this.sourceAborts.values()) {
      ctrl.abort();
    }
    this.sourceAborts.clear();
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.importAbort?.abort();
    this.importAbort = null;

    const pending = this.pendingOp;
    this.pendingOp = null;
    if (notifyBackend && pending) {
      if (pending.instanceId !== LEGACY_EXPLORER_PLUGIN_ID) {
        void this.transport
          .cancelImport(pending.instanceId, {
            requestId: pending.requestId,
            operationId: pending.operationId,
          })
          .catch(() => {});
      }
      if (pending.sourceInstanceId && pending.sourceOperationId) {
        void this.transport
          .cancelSource(pending.sourceInstanceId, pending.sourceOperationId)
          .catch(() => {});
      }
    }
  }

  setActiveImportInstance(nextInstanceId: string | null): void {
    const prev = this.state.activeImportInstanceId;
    if (prev === nextInstanceId) return;
    if (prev !== null) {
      this.cancelInFlight(true);
      this.setState({
        activeImportInstanceId: nextInstanceId,
        previewLoading: false,
        importing: false,
        previewData: null,
        previewError: null,
        commitResult: null,
      });
    } else {
      this.setState({ activeImportInstanceId: nextInstanceId });
    }
  }

  syncSources(
    sourcePlugins: InstalledPluginInfo[],
    hasLegacyExplorerFallback: boolean,
    discoverOpts?: { query?: string; workspaceId?: string },
  ): void {
    const nextIds = new Set<string>();
    const newlyReady: string[] = [];
    const nextMap: Record<string, SourceDiscoverySlice> = {};

    if (hasLegacyExplorerFallback) {
      nextIds.add(LEGACY_EXPLORER_PLUGIN_ID);
      const existing = this.state.sourcesMap[LEGACY_EXPLORER_PLUGIN_ID];
      nextMap[LEGACY_EXPLORER_PLUGIN_ID] = existing ?? {
        instanceId: LEGACY_EXPLORER_PLUGIN_ID,
        name: '内置本机历史扫描（兼容入口）',
        enabled: true,
        ready: true,
        statusText: '就绪',
        loading: false,
        loadingMore: false,
        error: null,
        sessions: [],
        nextCursor: null,
        lastRefreshedAt: null,
      };
      if (!existing) newlyReady.push(LEGACY_EXPLORER_PLUGIN_ID);
    } else {
      for (const plugin of sourcePlugins) {
        const id = getPluginInstanceId(plugin);
        nextIds.add(id);
        const ready = isPluginInstanceReady(plugin);
        const existing = this.state.sourcesMap[id];
        const wasReady = existing?.ready ?? false;
        if (!ready && existing && this.sourceAborts.has(id)) {
          this.sourceAborts.get(id)?.abort();
          this.sourceAborts.delete(id);
        }
        nextMap[id] = {
          instanceId: id,
          name: plugin.name,
          enabled: plugin.enabled,
          ready,
          statusText: ready
            ? '就绪'
            : !plugin.enabled
              ? '已停用'
              : plugin.loadError
                ? '加载失败'
                : '不可用',
          loading: ready ? (existing?.loading ?? false) : false,
          loadingMore: false,
          error: ready ? (existing?.error ?? null) : null,
          sessions: ready ? (existing?.sessions ?? []) : [],
          nextCursor: ready ? (existing?.nextCursor ?? null) : null,
          lastRefreshedAt: existing?.lastRefreshedAt ?? null,
        };
        if (ready && (!existing || !wasReady)) {
          newlyReady.push(id);
        }
      }
    }

    for (const [id, ctrl] of this.sourceAborts) {
      if (!nextIds.has(id)) {
        ctrl.abort();
        this.sourceAborts.delete(id);
      }
    }

    this.setState({ sourcesMap: nextMap });
    for (const id of newlyReady) {
      void this.discoverSource(id, {
        refresh: false,
        query: discoverOpts?.query,
        workspaceId: discoverOpts?.workspaceId,
      });
    }
  }

  async discoverSource(
    sourceInstanceId: string,
    opts?: {
      query?: string;
      workspaceId?: string;
      cursor?: string | null;
      append?: boolean;
      refresh?: boolean;
    },
  ): Promise<void> {
    if (this.disposed) return;
    const currentSlice = this.state.sourcesMap[sourceInstanceId];
    if (!currentSlice || !currentSlice.ready) return;

    this.sourceAborts.get(sourceInstanceId)?.abort();
    const controller = new AbortController();
    this.sourceAborts.set(sourceInstanceId, controller);
    const runEpoch = this.epoch;

    this.setState({
      sourcesMap: {
        ...this.state.sourcesMap,
        [sourceInstanceId]: {
          ...currentSlice,
          loading: !opts?.append,
          loadingMore: Boolean(opts?.append),
          error: null,
        },
      },
    });

    try {
      if (sourceInstanceId === LEGACY_EXPLORER_PLUGIN_ID) {
        const res = await daemonApi.discoverLocalCliSessions(40, Boolean(opts?.refresh));
        if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return;
        const mapped: HistorySummary[] = res.sessions.map((item) => ({
          ref: {
            sourceInstanceId: LEGACY_EXPLORER_PLUGIN_ID,
            sourceId: item.source ?? item.scannerId ?? item.harnessKind,
            nativeSessionId: item.nativeSessionId,
          },
          title: item.title,
          harnessKind: item.harnessKind,
          updatedAt: item.updatedAt,
          workspaceHint: item.cwd ? { cwd: item.cwd } : undefined,
          fileSizeBytes: item.fileSizeBytes,
          compressed: item.compressed,
          alreadyImportedSessionId: item.alreadyImportedSessionId,
          partial: item.partial,
        }));
        const latest = this.state.sourcesMap[sourceInstanceId];
        if (!latest) return;
        this.setState({
          sourcesMap: {
            ...this.state.sourcesMap,
            [sourceInstanceId]: {
              ...latest,
              loading: false,
              loadingMore: false,
              error: null,
              sessions: mapped,
              nextCursor: null,
              lastRefreshedAt: Date.now(),
            },
          },
        });
        return;
      }

      const res = await this.transport.discoverSource(
        sourceInstanceId,
        {
          query: opts?.query?.trim() || undefined,
          workspaceId: opts?.workspaceId || undefined,
          cursor: opts?.cursor ?? undefined,
          limit: 25,
          refresh: opts?.refresh ?? false,
        },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return;
      const latest = this.state.sourcesMap[sourceInstanceId];
      if (!latest) return;
      this.setState({
        sourcesMap: {
          ...this.state.sourcesMap,
          [sourceInstanceId]: {
            ...latest,
            loading: false,
            loadingMore: false,
            error: null,
            sessions: opts?.append ? [...latest.sessions, ...res.sessions] : res.sessions,
            nextCursor: res.nextCursor,
            lastRefreshedAt: Date.now(),
          },
        },
      });
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        isAbortError(err)
      ) {
        return;
      }
      const latest = this.state.sourcesMap[sourceInstanceId];
      if (!latest) return;
      this.setState({
        sourcesMap: {
          ...this.state.sourcesMap,
          [sourceInstanceId]: {
            ...latest,
            loading: false,
            loadingMore: false,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
    } finally {
      if (this.sourceAborts.get(sourceInstanceId) === controller) {
        this.sourceAborts.delete(sourceInstanceId);
      }
    }
  }

  async preview(
    summary: HistorySummary,
    mode: 'mirror' | 'attach',
    workspaceId: string,
    hasLegacyExplorerFallback: boolean,
  ): Promise<HistoryImportPreviewValue | null> {
    if (this.disposed) return null;
    this.previewAbort?.abort();
    const controller = new AbortController();
    this.previewAbort = controller;
    const runEpoch = this.epoch;

    this.setState({
      selectedSummary: summary,
      previewLoading: true,
      previewError: null,
      previewData: null,
      importError: null,
      importStatusNote: null,
      commitResult: null,
    });

    const input: ImportInput = { kind: 'native', ref: summary.ref, mode };
    const operationId = `preview-${Date.now()}`;
    const importInstanceId = this.state.activeImportInstanceId;

    try {
      if (!importInstanceId) {
        const sourceReady = this.state.sourcesMap[summary.ref.sourceInstanceId]?.ready;
        if (sourceReady && summary.ref.sourceInstanceId !== LEGACY_EXPLORER_PLUGIN_ID) {
          this.pendingOp = {
            instanceId: LEGACY_EXPLORER_PLUGIN_ID,
            sourceInstanceId: summary.ref.sourceInstanceId,
            sourceOperationId: operationId,
          };
          const readRes = await this.transport.readSource(
            summary.ref.sourceInstanceId,
            { ref: summary.ref, limit: 30, operationId },
            controller.signal,
          );
          if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return null;
          this.pendingOp = null;
          const fallbackPreview: HistoryImportPreviewValue = {
            input,
            existingSessionId: summary.alreadyImportedSessionId ?? null,
            targetWorkspaceId: workspaceId || null,
            importable: false,
            items: readRes.items,
            readStatus: readRes.readStatus,
            warnings: [
              ...readRes.warnings,
              '当前未就绪 history.import.v1 实例，仅提供来源只读预览。',
            ],
          };
          this.setState({ previewData: fallbackPreview, previewLoading: false });
          return fallbackPreview;
        }
        if (hasLegacyExplorerFallback) {
          const legacyPreview: HistoryImportPreviewValue = {
            input,
            existingSessionId: summary.alreadyImportedSessionId ?? null,
            targetWorkspaceId: workspaceId || null,
            importable: true,
            items: [],
            readStatus: summary.partial ? 'partial' : 'complete',
            warnings: summary.partial ? ['检测到源历史可能存在截断。'] : [],
          };
          this.setState({ previewData: legacyPreview, previewLoading: false });
          return legacyPreview;
        }
        throw new Error('没有可用的 history.import.v1 导入实例');
      }

      this.pendingOp = {
        instanceId: importInstanceId,
        operationId,
        sourceInstanceId: summary.ref.sourceInstanceId,
        sourceOperationId: operationId,
      };
      const preview = await this.transport.previewImport(
        importInstanceId,
        { input, workspaceId: workspaceId || undefined, operationId },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return null;
      this.pendingOp = null;
      this.setState({ previewData: preview, previewLoading: false });
      return preview;
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        isAbortError(err)
      ) {
        return null;
      }
      this.pendingOp = null;
      this.setState({
        previewLoading: false,
        previewError: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      if (this.previewAbort === controller) {
        this.previewAbort = null;
      }
    }
  }

  async commit(
    mode: 'mirror' | 'attach',
    workspaceId: string,
    hasLegacyExplorerFallback: boolean,
  ): Promise<HistoryImportCommitValue | null> {
    const summary = this.state.selectedSummary;
    if (this.disposed || !summary) return null;

    this.importAbort?.abort();
    const controller = new AbortController();
    this.importAbort = controller;
    const runEpoch = this.epoch;

    const input: ImportInput = { kind: 'native', ref: summary.ref, mode };
    const effectiveWorkspaceId = workspaceId || this.state.previewData?.targetWorkspaceId || undefined;
    const requestId = this.requestIdTracker.getOrCreate(input, effectiveWorkspaceId);
    const importInstanceId = this.state.activeImportInstanceId;

    this.setState({
      importing: true,
      importError: null,
      importStatusNote: null,
      commitResult: null,
    });

    try {
      if (!importInstanceId) {
        if (!hasLegacyExplorerFallback) {
          throw new Error('当前没有就绪的 history.import.v1 实例');
        }
        const session = await daemonApi.importNativeSession({
          source: (summary.ref.sourceId as 'custom') ?? 'custom',
          scannerId: summary.ref.sourceId,
          nativeSessionId: summary.ref.nativeSessionId,
          workspaceId: effectiveWorkspaceId,
          mode,
        });
        if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return null;
        const res: HistoryImportCommitValue = {
          sessionId: session.session.id,
          disposition: 'created',
          partial: Boolean(session.partial),
          warnings: session.lockWarning ? [session.lockWarning] : [],
        };
        this.requestIdTracker.clear();
        this.setState({ importing: false, commitResult: res });
        return res;
      }

      this.pendingOp = {
        instanceId: importInstanceId,
        requestId,
        operationId: requestId,
        sourceInstanceId: summary.ref.sourceInstanceId,
      };
      const result = await this.transport.commitImport(
        importInstanceId,
        { input, workspaceId: effectiveWorkspaceId, requestId, operationId: requestId },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted || runEpoch !== this.epoch) return null;
      this.pendingOp = null;
      this.requestIdTracker.clear();
      this.setState({ importing: false, commitResult: result });
      return result;
    } catch (err) {
      if (
        this.disposed ||
        controller.signal.aborted ||
        runEpoch !== this.epoch ||
        isAbortError(err)
      ) {
        return null;
      }
      this.pendingOp = null;
      this.setState({
        importing: false,
        importError: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      if (this.importAbort === controller) {
        this.importAbort = null;
      }
    }
  }

  cancelActiveOp(): void {
    const pending = this.pendingOp;
    this.pendingOp = null;
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.importAbort?.abort();
    this.importAbort = null;
    this.epoch += 1;
    this.setState({
      previewLoading: false,
      importing: false,
      importStatusNote: '已取消当前操作，未写入新会话。',
    });

    if (pending) {
      if (pending.instanceId !== LEGACY_EXPLORER_PLUGIN_ID) {
        void this.transport
          .cancelImport(pending.instanceId, {
            requestId: pending.requestId,
            operationId: pending.operationId,
          })
          .catch(() => {});
      }
      if (pending.sourceInstanceId && pending.sourceOperationId) {
        void this.transport
          .cancelSource(pending.sourceInstanceId, pending.sourceOperationId)
          .catch(() => {});
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelInFlight(true);
    this.listeners.clear();
  }
}
