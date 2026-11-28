import type {
  InstalledPluginInfo,
  PortableSessionBundleV2,
  SessionSearchHit,
} from '@harnessmate/protocol';

export const APPLICATION_VIEW_CONTRACT = 'application.view.v1';
export const APPLICATION_SHELL_SLOT = 'application.shell';
export const HISTORY_SOURCE_CONTRACT = 'history.source.v1';
export const HISTORY_IMPORT_CONTRACT = 'history.import.v1';
export const SESSION_SEARCH_CONTRACT = 'session.search.v1';
export const GIT_WORKSPACE_CONTRACT = 'git.workspace.v1';
export const GIT_CHECKPOINT_CONTRACT = 'git.checkpoint.v1';
export const TERMINAL_WORKSPACE_CONTRACT = 'terminal.workspace.v1';
export const TERMINAL_RUNNER_CONTRACT = 'terminal.runner.v1';
export const WORKSPACE_FILES_CONTRACT = 'workspace.files.v1';
export const SESSION_ATTACHMENTS_CONTRACT = 'session.attachments.v1';
export const WORKSPACE_RULES_CONTRACT = 'workspace.rules.v1';
export const AGY_RUNTIME_CONTRACT = 'agy.runtime.v1';
export const AGY_ACCOUNTS_CONTRACT = 'agy.accounts.v1';
export const AGY_WORKBENCH_CONTRACT = 'agy.workbench.v1';

export const HISTORY_IMPORT_PAGE_SLOT_ID = 'history-import';
export const SESSION_SEARCH_PAGE_SLOT_ID = 'session-search';
export const LEGACY_EXPLORER_PLUGIN_ID = 'hm.plugin.session-explorer';

export interface WorkspaceGitStatusLookupRequest {
  workspaceId: string;
  sessionId?: string;
  cwd?: string;
}

export interface NavigateToFileRequest {
  workspaceId?: string;
  sessionId?: string;
  path: string;
  line?: number;
  column?: number;
  openInspector?: boolean;
  preserveSession?: boolean;
}

export interface NavigateToFileResult {
  opened: boolean;
  sessionId: string | null;
  workspaceId?: string | null;
  path: string;
  line?: number;
  column?: number;
  errorCode?: string;
  message?: string;
}

export type SelectionSource =
  | 'explicit'
  | 'session'
  | 'workspace'
  | 'dependency'
  | 'composition'
  | 'single'
  | 'none';

export type ServiceResolutionStatus =
  | 'ready'
  | 'disabled'
  | 'unavailable'
  | 'incompatible'
  | 'unconfigured'
  | 'selection_required';

export interface ServiceCandidate {
  instanceId: string;
  pluginId: string;
  version: string;
}

export type ServiceResolutionV1 = {
  contract: string;
  versionRange: string;
  candidates: ServiceCandidate[];
} & (
  | { instanceId: string; source: Exclude<SelectionSource, 'none'>; status: 'ready' }
  | {
      instanceId: string;
      source: Exclude<SelectionSource, 'none' | 'single'>;
      status: 'disabled' | 'unavailable' | 'incompatible';
    }
  | { instanceId: null; source: 'none'; status: 'unconfigured' | 'selection_required' }
);

export interface ContractErrorPayload {
  code: string;
  message: string;
}

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorPayload };

export class ContractCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractCallError';
    this.code = code;
  }
}

export function isContractEnvelope<T>(raw: unknown): raw is ContractResult<T> {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      'ok' in raw &&
      typeof (raw as { ok?: unknown }).ok === 'boolean',
  );
}

export function unwrapContractResult<T>(raw: ContractResult<T> | T): T {
  if (isContractEnvelope<T>(raw)) {
    if (raw.ok) return raw.value;
    throw new ContractCallError(
      raw.error?.code ?? 'unknown_error',
      raw.error?.message ?? '插件调用失败',
    );
  }
  return raw;
}

// ── history.source.v1 ───────────────────────────────────────────────────

export interface HistoryRef {
  sourceInstanceId: string;
  sourceId: string;
  nativeSessionId: string;
}

export interface HistorySummary {
  ref: HistoryRef;
  title: string;
  harnessKind: string;
  updatedAt: number;
  workspaceHint?: {
    cwd?: string;
    label?: string;
  };
  fileSizeBytes?: number;
  compressed?: boolean;
  alreadyImportedSessionId?: string | null;
  partial?: boolean;
  compatLegacySources?: string[];
}

export interface HistoryItem {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

export interface HistorySourceDiscoverRequest {
  query?: string;
  workspaceId?: string;
  fromTs?: number;
  toTs?: number;
  cursor?: string | null;
  limit?: number;
  refresh?: boolean;
  operationId?: string;
}

export interface HistorySourceDiscoverValue {
  sessions: HistorySummary[];
  nextCursor: string | null;
}

export interface HistorySourceReadRequest {
  ref: HistoryRef;
  cursor?: string | null;
  limit?: number;
  operationId?: string;
}

export interface HistorySourceReadValue {
  ref: HistoryRef;
  items: HistoryItem[];
  nextCursor: string | null;
  readStatus: 'complete' | 'partial';
  warnings: string[];
}

export interface HistorySourceStatusValue {
  instanceId: string;
  pluginId: string;
  sourceNamespace?: string;
  defaultSourceId?: string;
  harnessKind?: string;
  ready: boolean;
  error?: string | null;
}

// ── history.import.v1 ───────────────────────────────────────────────────

export type ImportInput =
  | { kind: 'native'; ref: HistoryRef; mode: 'attach' | 'mirror' }
  | { kind: 'bundle'; bundle: PortableSessionBundleV2; titleOverride?: string };

export interface HistoryImportPreviewRequest {
  input: ImportInput;
  workspaceId?: string;
  operationId?: string;
}

export interface HistoryImportPreviewValue {
  input: ImportInput;
  existingSessionId: string | null;
  targetWorkspaceId: string | null;
  importable: boolean;
  items: HistoryItem[];
  readStatus: 'complete' | 'partial';
  warnings: string[];
}

export interface HistoryImportCommitRequest {
  input: ImportInput;
  workspaceId?: string;
  requestId: string;
  operationId?: string;
}

export interface HistoryImportCommitValue {
  sessionId: string;
  disposition: 'created' | 'reused';
  partial: boolean;
  warnings: string[];
}

// ── session.search.v1 ───────────────────────────────────────────────────

export interface SearchQueryRequest {
  q: string;
  workspaceId?: string;
  driverId?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
  offset?: number;
}

export interface SearchQueryValue {
  hits: SessionSearchHit[];
  nextOffset: number | null;
  fallbackUsed: boolean;
  tookMs: number;
}

export interface SearchReindexRequest {
  mode?: 'full' | 'incremental' | 'resume';
  jobId?: string;
  workspaceId?: string;
}

export interface SearchReindexJob {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  indexedCount: number;
  totalCount?: number;
  cursorSeq: number;
  snapshotWatermark?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface SearchInstanceStatus {
  instanceId: string;
  engineKind: string;
  state: string;
  cursorSeq: number;
  latestSourceSeq?: number;
  indexedItems: number;
  indexedSessions: number;
  activeJob: SearchReindexJob | null;
  lastJob: SearchReindexJob | null;
  lastError?: string | null;
}

export interface SearchCancelRequest {
  jobId?: string;
}

export interface SearchResumeRequest {
  jobId?: string;
}

// ── Plugin / Slot / Semver Helpers ──────────────────────────────────────

export function getPluginInstanceId(plugin: Pick<InstalledPluginInfo, 'id' | 'instanceId'>): string {
  return plugin.instanceId ?? plugin.id;
}

export function pluginProvidesContract(
  plugin: Pick<InstalledPluginInfo, 'provides' | 'providedContracts'>,
  contract: string,
): boolean {
  if (plugin.providedContracts?.some((entry) => entry.contract === contract)) return true;
  if (plugin.provides?.includes(contract)) return true;
  return false;
}

export function getProvidedContractVersion(
  plugin: Pick<InstalledPluginInfo, 'version' | 'providedContracts'>,
  contract: string,
): string {
  const entry = plugin.providedContracts?.find((item) => item.contract === contract);
  return entry?.version ?? plugin.version ?? '1.0.0';
}

export function isPluginInstanceReady(
  plugin: Pick<InstalledPluginInfo, 'enabled' | 'runtimeState'>,
): boolean {
  return plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
}

export function makeWorkspacePageKey(instanceId: string, slotId: string): string {
  return `${instanceId}:${slotId}`;
}

export function parseWorkspacePageKey(
  pageKey: string | null | undefined,
): { instanceId: string; slotId: string } | null {
  if (!pageKey) return null;
  const idx = pageKey.lastIndexOf(':');
  if (idx <= 0 || idx === pageKey.length - 1) return null;
  return {
    instanceId: pageKey.slice(0, idx),
    slotId: pageKey.slice(idx + 1),
  };
}

function parseSemver(version: string): [number, number, number] | null {
  const clean = version.trim().replace(/^v/i, '').split('-')[0] ?? '';
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(clean);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export function satisfiesSemverRange(version: string, versionRange: string): boolean {
  const trimmed = versionRange.trim();
  if (!trimmed || trimmed === '*') return true;
  const parsed = parseSemver(version);
  if (!parsed) return false;

  if (trimmed.startsWith('^')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    if (compareSemver(parsed, base) < 0) return false;
    if (base[0] > 0) return parsed[0] === base[0];
    if (base[1] > 0) return parsed[0] === 0 && parsed[1] === base[1];
    return parsed[0] === 0 && parsed[1] === 0 && parsed[2] === base[2];
  }

  if (trimmed.startsWith('~')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    return compareSemver(parsed, base) >= 0 && parsed[0] === base[0] && parsed[1] === base[1];
  }

  if (trimmed.startsWith('>=')) {
    const base = parseSemver(trimmed.slice(2));
    return base ? compareSemver(parsed, base) >= 0 : false;
  }

  const exact = parseSemver(trimmed);
  return exact ? compareSemver(parsed, exact) === 0 : false;
}

export interface ClientResolveServiceOptions {
  contract: string;
  versionRange?: string;
  plugins: InstalledPluginInfo[];
  explicitInstanceId?: string | null;
  sessionBindings?: Record<string, string | null>;
  workspaceBindings?: Record<string, string | null>;
  callerBindings?: Record<string, string | null>;
  compositionBindings?: Record<string, string | null>;
  compositionEntries?: Array<{ id: string; name?: string; disabled?: boolean }>;
  allowSingleCandidate?: boolean;
}

export function resolveServiceSelectionClientSide(
  opts: ClientResolveServiceOptions,
): ServiceResolutionV1 {
  const versionRange = opts.versionRange ?? '^1.0.0';
  const allowSingleCandidate = opts.allowSingleCandidate ?? true;
  const matchingPlugins = opts.plugins.filter((plugin) =>
    pluginProvidesContract(plugin, opts.contract),
  );

  const candidates: ServiceCandidate[] = matchingPlugins
    .filter((plugin) => {
      if (!isPluginInstanceReady(plugin)) return false;
      const version = getProvidedContractVersion(plugin, opts.contract);
      return satisfiesSemverRange(version, versionRange);
    })
    .map((plugin) => ({
      instanceId: getPluginInstanceId(plugin),
      pluginId: plugin.id,
      version: getProvidedContractVersion(plugin, opts.contract),
    }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  const selections: Array<{
    source: Exclude<SelectionSource, 'none' | 'single'>;
    instanceId: string | null | undefined;
  }> = [
    { source: 'explicit', instanceId: opts.explicitInstanceId },
    { source: 'session', instanceId: opts.sessionBindings?.[opts.contract] },
    { source: 'workspace', instanceId: opts.workspaceBindings?.[opts.contract] },
    { source: 'dependency', instanceId: opts.callerBindings?.[opts.contract] },
    { source: 'composition', instanceId: opts.compositionBindings?.[opts.contract] },
  ];

  const chosen = selections.find(
    (item): item is { source: Exclude<SelectionSource, 'none' | 'single'>; instanceId: string } =>
      typeof item.instanceId === 'string' && item.instanceId.trim().length > 0,
  );

  if (chosen) {
    const readyCandidate = candidates.find((c) => c.instanceId === chosen.instanceId);
    if (readyCandidate) {
      return {
        contract: opts.contract,
        versionRange,
        candidates,
        instanceId: chosen.instanceId,
        source: chosen.source,
        status: 'ready',
      };
    }

    const knownPlugin = opts.plugins.find(
      (plugin) => getPluginInstanceId(plugin) === chosen.instanceId || plugin.id === chosen.instanceId,
    );
    const knownEntry = opts.compositionEntries?.find((entry) => entry.id === chosen.instanceId);

    if (
      knownEntry?.disabled === true ||
      (knownPlugin &&
        (!knownPlugin.enabled ||
          knownPlugin.runtimeState === 'DISPOSED' ||
          knownPlugin.runtimeState === 'UNLOADING'))
    ) {
      return {
        contract: opts.contract,
        versionRange,
        candidates,
        instanceId: chosen.instanceId,
        source: chosen.source,
        status: 'disabled',
      };
    }

    if (
      knownPlugin &&
      isPluginInstanceReady(knownPlugin) &&
      pluginProvidesContract(knownPlugin, opts.contract) &&
      !satisfiesSemverRange(getProvidedContractVersion(knownPlugin, opts.contract), versionRange)
    ) {
      return {
        contract: opts.contract,
        versionRange,
        candidates,
        instanceId: chosen.instanceId,
        source: chosen.source,
        status: 'incompatible',
      };
    }

    return {
      contract: opts.contract,
      versionRange,
      candidates,
      instanceId: chosen.instanceId,
      source: chosen.source,
      status: 'unavailable',
    };
  }

  if (candidates.length === 0) {
    return {
      contract: opts.contract,
      versionRange,
      candidates: [],
      instanceId: null,
      source: 'none',
      status: 'unconfigured',
    };
  }

  if (candidates.length === 1 && allowSingleCandidate) {
    return {
      contract: opts.contract,
      versionRange,
      candidates,
      instanceId: candidates[0]!.instanceId,
      source: 'single',
      status: 'ready',
    };
  }

  return {
    contract: opts.contract,
    versionRange,
    candidates,
    instanceId: null,
    source: 'none',
    status: 'selection_required',
  };
}

export interface ClientContractAvailabilityOptions extends ClientResolveServiceOptions {
  legacyPluginId?: string;
  optionalDefaultOff?: boolean;
}

export function isContractAvailableClientSide(
  opts: ClientContractAvailabilityOptions,
): boolean {
  const hasContractProvider = opts.plugins.some((plugin) =>
    pluginProvidesContract(plugin, opts.contract),
  );
  if (hasContractProvider) {
    return resolveServiceSelectionClientSide(opts).status === 'ready';
  }
  if (!opts.legacyPluginId) {
    return !opts.optionalDefaultOff && opts.plugins.length === 0;
  }
  const legacyPlugin = opts.plugins.find(
    (plugin) => getPluginInstanceId(plugin) === opts.legacyPluginId || plugin.id === opts.legacyPluginId,
  );
  if (!legacyPlugin) {
    return !opts.optionalDefaultOff;
  }
  return isPluginInstanceReady(legacyPlugin);
}
