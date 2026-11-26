import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredCliSession } from '@harnessmate/protocol';

export const HISTORY_SOURCE_CONTRACT = 'history.source.v1';
export const HISTORY_SOURCE_VERSION = '1.0.0';

export type HistorySourceNamespace = 'codex' | 'claude' | 'agy_cli' | 'agy_desktop' | 'custom';

export type LegacyNativeHistorySource = NonNullable<DiscoveredCliSession['source']>;

export interface HistoryRef {
  sourceInstanceId: string;
  sourceId: string;
  nativeSessionId: string;
}

export interface HistoryWorkspaceHint {
  cwd?: string;
  label?: string;
}

export interface HistorySummary {
  ref: HistoryRef;
  title: string;
  harnessKind: string;
  updatedAt: number;
  workspaceHint?: HistoryWorkspaceHint;
  /** Optional legacy source tag (e.g. `codex_cli`, `codex_desktop`, `claude_cli`, `agy_cli`, `agy_desktop`, `custom`). */
  legacySource?: string;
  /** Optional list of legacy `native_history_imports.source` values that map to this default account namespace. */
  compatLegacySources?: string[];
  /** Optional absolute file path hint for diagnostics/compat (read-only). */
  sourcePath?: string;
}

export interface HistoryItem {
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

export type HistoryReadStatus = 'complete' | 'partial';

export type HistorySourceErrorCode =
  | 'invalid_request'
  | 'source_unreadable'
  | 'not_importable'
  | 'cancelled'
  | 'conflict';

export type HistorySourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: HistorySourceErrorCode; message: string } };

export interface HistoryDiscoverRequest {
  query?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  harnessKind?: string;
  source?: string;
  fromTs?: number;
  toTs?: number;
  cursor?: string | null;
  limit?: number;
  refresh?: boolean;
  operationId?: string;
}

export interface HistoryDiscoverValue {
  sessions: HistorySummary[];
  nextCursor: string | null;
}

export interface HistoryReadRequest {
  ref: HistoryRef;
  cursor?: string | null;
  limit?: number;
  operationId?: string;
}

export interface HistoryReadValue {
  ref: HistoryRef;
  items: HistoryItem[];
  nextCursor: string | null;
  readStatus: HistoryReadStatus;
  warnings: string[];
  fileLockedWarning?: boolean;
}

export interface HistoryCancelRequest {
  operationId?: string;
}

export interface HistoryCancelValue {
  cancelled: boolean;
  operationId?: string;
  abortedCount: number;
}

export interface HistorySourceConfig {
  rootDir?: string;
  homes?: string[];
  sourceId?: string;
  harnessKind?: string;
  origins?: Array<'codex_cli' | 'codex_desktop'>;
  maxScanFiles?: number;
  maxTranscriptBytes?: number;
  maxTranscriptLines?: number;
  maxAgyMessages?: number;
  maxAgyBytes?: number;
  maxAgyDbBytes?: number;
  pageMaxBytes?: number;
  records?: Array<{
    nativeSessionId: string;
    title: string;
    harnessKind?: string;
    updatedAt?: number;
    cwd?: string;
    workspaceLabel?: string;
    workspaceId?: string;
    items: Array<{ itemId?: string; role: 'user' | 'assistant'; text: string; timestamp?: number }>;
  }>;
}

export interface HistorySourceIdentity {
  namespace: HistorySourceNamespace;
  sourceId: string;
  isDefault: boolean;
  roots: string[];
  compatLegacySources: LegacyNativeHistorySource[];
}

export interface HistorySourceStatus {
  instanceId: string;
  pluginId: string;
  namespace: HistorySourceNamespace;
  sourceId: string;
  isDefault: boolean;
  roots: string[];
  compatLegacySources: LegacyNativeHistorySource[];
  active: boolean;
  inFlightOperations: number;
  cacheEntries: number;
  lastError: string | null;
}

export interface HistorySourceService {
  discover(req?: HistoryDiscoverRequest): Promise<HistorySourceResult<HistoryDiscoverValue>>;
  read(req: HistoryReadRequest): Promise<HistorySourceResult<HistoryReadValue>>;
  cancel(req?: HistoryCancelRequest): Promise<HistorySourceResult<HistoryCancelValue>>;
  getStatus?(): Promise<HistorySourceResult<HistorySourceStatus>>;
}

export const DEFAULT_LEGACY_SOURCES: Readonly<Record<string, readonly LegacyNativeHistorySource[]>> = {
  'codex:default': ['codex_cli', 'codex_desktop'],
  'claude:default': ['claude_cli'],
  'agy_cli:default': ['agy_cli'],
  'agy_desktop:default': ['agy_desktop'],
  'custom:default': ['custom'],
};

const LEGACY_ENUM_SET = new Set<string>([
  'codex_cli',
  'codex_desktop',
  'claude_cli',
  'agy_cli',
  'agy_desktop',
  'pi_cli',
  'opencode_cli',
  'custom',
]);

export function canonicalizeRootPath(dirPath: string): string {
  const resolved = path.resolve(dirPath.trim());
  try {
    const real = fs.realpathSync(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

export function defaultRootsForNamespace(namespace: HistorySourceNamespace): string[] {
  const home = os.homedir();
  switch (namespace) {
    case 'codex': {
      const candidates = [process.env.CODEX_HOME, path.join(home, '.codex')].filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      const unique: string[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = canonicalizeRootPath(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(path.resolve(candidate));
      }
      return unique;
    }
    case 'claude':
      return [path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'))];
    case 'agy_cli':
      return [path.resolve(path.join(home, '.gemini', 'antigravity-cli'))];
    case 'agy_desktop':
      return [path.resolve(path.join(home, '.gemini', 'antigravity'))];
    case 'custom':
      return [];
  }
}

export function buildHistorySourceId(
  namespace: HistorySourceNamespace,
  roots: readonly string[],
  opts?: { explicitSourceId?: string; isDefault?: boolean },
): string {
  const explicit = opts?.explicitSourceId?.trim();
  if (explicit) return explicit;
  if (opts?.isDefault) return `${namespace}:default`;
  const canonical = [...roots].map(canonicalizeRootPath).sort();
  const digest = crypto.createHash('sha256').update(JSON.stringify([namespace, canonical])).digest('hex').slice(0, 12);
  return `${namespace}:acct:${digest}`;
}

export function legacySourcesForSourceId(sourceId: string): LegacyNativeHistorySource[] {
  const mapped = DEFAULT_LEGACY_SOURCES[sourceId];
  if (mapped) return [...mapped];
  if (LEGACY_ENUM_SET.has(sourceId)) return [sourceId as LegacyNativeHistorySource];
  return [];
}

export function resolveHistorySourceIdentity(
  namespace: HistorySourceNamespace,
  config: HistorySourceConfig = {},
  fallbackDefaultRoot?: string,
): HistorySourceIdentity {
  const configuredRoots: string[] = [];
  if (typeof config.rootDir === 'string' && config.rootDir.trim()) {
    configuredRoots.push(path.resolve(config.rootDir.trim()));
  }
  if (Array.isArray(config.homes)) {
    for (const h of config.homes) {
      if (typeof h === 'string' && h.trim()) configuredRoots.push(path.resolve(h.trim()));
    }
  }

  const osDefaults = defaultRootsForNamespace(namespace);
  const effectiveDefaults = osDefaults.length > 0
    ? osDefaults
    : (fallbackDefaultRoot ? [path.resolve(fallbackDefaultRoot)] : []);

  const roots = configuredRoots.length > 0 ? dedupePaths(configuredRoots) : effectiveDefaults;
  const canonicalRoots = [...roots].map(canonicalizeRootPath).sort();
  const canonicalDefaults = [...effectiveDefaults].map(canonicalizeRootPath).sort();

  const matchesDefaultRoot =
    configuredRoots.length === 0 ||
    (canonicalRoots.length === canonicalDefaults.length &&
      canonicalRoots.every((item, idx) => item === canonicalDefaults[idx]));

  const explicitSourceId = typeof config.sourceId === 'string' && config.sourceId.trim()
    ? config.sourceId.trim()
    : undefined;
  const isDefault = !explicitSourceId && matchesDefaultRoot;
  const sourceId = buildHistorySourceId(namespace, roots, { explicitSourceId, isDefault });

  return {
    namespace,
    sourceId,
    isDefault,
    roots,
    compatLegacySources: legacySourcesForSourceId(sourceId),
  };
}

function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const key = canonicalizeRootPath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
