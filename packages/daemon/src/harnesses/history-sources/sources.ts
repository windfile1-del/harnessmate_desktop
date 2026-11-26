import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DiscoveredCliSession, HarnessKind } from '@harnessmate/protocol';
import {
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  DEFAULT_MAX_TRANSCRIPT_LINES,
  type DetailedHistoryReadResult,
  type HistoryMessage,
  type NativeSessionScanner,
  registerNativeScanner,
} from '../history-scanner.js';
import { readAgyHistoryWithDiagnostics } from './agy-reader.js';
import { decodeOffsetCursor, encodeOffsetCursor } from './cursor.js';
import {
  HistoryReadCancelledError,
  isZstdTranscript,
  readFirstJsonlRecord,
  readJsonlTranscriptAbortable,
  streamJsonLinesAbortable,
} from './jsonl-reader.js';
import {
  type HistoryCancelRequest,
  type HistoryCancelValue,
  type HistoryDiscoverRequest,
  type HistoryDiscoverValue,
  type HistoryItem,
  type HistoryReadRequest,
  type HistoryReadValue,
  type HistorySourceConfig,
  type HistorySourceIdentity,
  type HistorySourceNamespace,
  type HistorySourceResult,
  type HistorySourceService,
  type HistorySourceStatus,
  type HistorySummary,
  resolveHistorySourceIdentity,
} from './types.js';

const DEFAULT_PAGE_MAX_BYTES = 1_536 * 1024; // 1.5 MiB per RPC page (< 4 MiB MAX_RPC_LINE_BYTES)
const SCAN_CONCURRENCY = 6;

interface CachedSummaryEntry {
  mtimeMs: number;
  size: number;
  summary: HistorySummary | null;
  sourcePath: string;
}

interface InternalDiscoveredEntry {
  summary: HistorySummary;
  sourcePath?: string;
}

function fail<T>(code: 'invalid_request' | 'source_unreadable' | 'not_importable' | 'cancelled' | 'conflict', message: string): HistorySourceResult<T> {
  return { ok: false, error: { code, message } };
}

function ok<T>(value: T): HistorySourceResult<T> {
  return { ok: true, value };
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function collectFiles(
  dir: string,
  depth: number,
  nameMatches: (name: string) => boolean,
): Array<{ file: string; mtimeMs: number; size: number }> {
  const files: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const walk = (root: string, remaining: number) => {
    for (const ent of safeReaddir(root)) {
      const file = path.join(root, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory() && remaining > 0) {
        walk(file, remaining - 1);
      } else if (ent.isFile() && nameMatches(ent.name)) {
        try {
          const st = fs.statSync(file);
          files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // rotated or inaccessible
        }
      }
    }
  };
  walk(dir, depth);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) {
        throw new HistoryReadCancelledError(
          typeof signal.reason === 'string' && signal.reason ? signal.reason : '操作已取消',
        );
      }
      const idx = cursor++;
      results[idx] = await fn(items[idx]!, idx);
    }
  };
  const count = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

function isCodexRolloutName(name: string, id?: string): boolean {
  const isPlain = name.endsWith('.jsonl');
  const isZst = name.endsWith('.jsonl.zst');
  if (!isPlain && !isZst) return false;
  if (!id) return true;
  return (
    name.endsWith(`-${id}.jsonl`)
    || name.endsWith(`-${id}.jsonl.zst`)
    || name === `${id}.jsonl`
    || name === `${id}.jsonl.zst`
  );
}

function workspaceHintFromCwd(cwd: string | null | undefined): HistorySummary['workspaceHint'] {
  if (!cwd || !cwd.trim()) return undefined;
  const trimmed = cwd.trim();
  const base = path.basename(trimmed) || trimmed;
  return { cwd: trimmed, label: base };
}

function matchesWorkspaceFilter(
  summary: HistorySummary,
  workspaceId: string | undefined,
  workspaceCwd: string | undefined,
  recordWorkspaceId?: string,
): boolean {
  if (!workspaceId && !workspaceCwd) return true;
  const cwd = summary.workspaceHint?.cwd;
  const label = summary.workspaceHint?.label;
  if (workspaceCwd) {
    if (!cwd) return false;
    const normTarget = process.platform === 'win32' ? path.resolve(workspaceCwd).toLowerCase() : path.resolve(workspaceCwd);
    const normCwd = process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (normCwd !== normTarget && !normCwd.startsWith(normTarget + path.sep)) return false;
  }
  if (workspaceId) {
    if (recordWorkspaceId && recordWorkspaceId === workspaceId) return true;
    const looksLikePath = path.isAbsolute(workspaceId) || workspaceId.includes('/') || workspaceId.includes('\\');
    if (looksLikePath && cwd) {
      const normTarget = process.platform === 'win32' ? path.resolve(workspaceId).toLowerCase() : path.resolve(workspaceId);
      const normCwd = process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
      return normCwd === normTarget || normCwd.startsWith(normTarget + path.sep);
    }
    if (label && label.toLowerCase() === workspaceId.toLowerCase()) return true;
    if (cwd && path.basename(cwd).toLowerCase() === workspaceId.toLowerCase()) return true;
    return false;
  }
  return true;
}

function matchesDiscoverFilters(
  entry: InternalDiscoveredEntry,
  req: HistoryDiscoverRequest,
  recordWorkspaceId?: string,
): boolean {
  const { summary } = entry;
  if (req.harnessKind && summary.harnessKind !== req.harnessKind) return false;
  if (req.source && summary.legacySource !== req.source && summary.ref.sourceId !== req.source) return false;
  if (typeof req.fromTs === 'number' && summary.updatedAt < req.fromTs) return false;
  if (typeof req.toTs === 'number' && summary.updatedAt > req.toTs) return false;
  if (!matchesWorkspaceFilter(summary, req.workspaceId, req.workspaceCwd, recordWorkspaceId)) return false;
  if (req.query && req.query.trim()) {
    const q = req.query.trim().toLowerCase();
    const haystack = [
      summary.title,
      summary.ref.nativeSessionId,
      summary.ref.sourceId,
      summary.workspaceHint?.cwd ?? '',
      summary.workspaceHint?.label ?? '',
      summary.harnessKind,
    ].join('\n').toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function buildWarningsFromDetailed(detailed: DetailedHistoryReadResult): string[] {
  const warnings: string[] = [];
  if (detailed.truncatedReason === 'max_bytes') {
    warnings.push(`读取达到字节上限 (${detailed.bytesRead} B)，长历史已截断`);
  } else if (detailed.truncatedReason === 'max_lines') {
    warnings.push(`读取达到行数上限 (${detailed.linesRead} 行)，长历史已截断`);
  } else if (detailed.truncatedReason === 'corrupted_trailing_line') {
    warnings.push('检测到损坏行或半截尾行，已容错跳过并保留已解析消息');
  }
  if (detailed.fileLockedWarning) {
    warnings.push('检测到该原生会话文件最近 5 秒内有写入活动，可能存在外部 CLI 并发锁');
  }
  return warnings;
}

function paginateItems(
  allMessages: readonly HistoryMessage[],
  offset: number,
  limit: number,
  pageMaxBytes: number,
): { items: HistoryItem[]; nextCursor: string | null } {
  const items: HistoryItem[] = [];
  let pageBytes = 0;
  let nextIndex = offset;

  while (nextIndex < allMessages.length && items.length < limit) {
    const msg = allMessages[nextIndex]!;
    const item: HistoryItem = {
      itemId: `message-${nextIndex + 1}`,
      role: msg.role,
      text: msg.text,
      ...(typeof msg.timestamp === 'number' ? { timestamp: msg.timestamp } : {}),
    };
    const itemBytes = Buffer.byteLength(item.text, 'utf8') + 128;
    if (items.length > 0 && pageBytes + itemBytes > pageMaxBytes) {
      break;
    }
    items.push(item);
    pageBytes += itemBytes;
    nextIndex += 1;
  }

  const nextCursor = nextIndex < allMessages.length ? encodeOffsetCursor(nextIndex) : null;
  return { items, nextCursor };
}

function verifyExistingRoot(root: string): { ok: true; realRoot: string } | { ok: false; reason: 'missing' | 'not_dir' } {
  try {
    const realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) return { ok: false, reason: 'not_dir' };
    return { ok: true, realRoot };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

function isWithinCanonicalRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(
    process.platform === 'win32' ? rootReal.toLowerCase() : rootReal,
    process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal,
  );
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function verifyExplicitRoots(roots: readonly string[], config: HistorySourceConfig): void {
  const hasExplicitRoot = Boolean(
    (typeof config.rootDir === 'string' && config.rootDir.trim())
    || (Array.isArray(config.homes) && config.homes.some((h) => typeof h === 'string' && h.trim())),
  );
  if (!hasExplicitRoot) return;
  const anyAccessible = roots.some((root) => verifyExistingRoot(root).ok);
  if (!anyAccessible) {
    throw new Error(`配置的来源根目录不存在或不可访问: ${roots.join(', ')}`);
  }
}

export interface HistorySourceInstanceOptions {
  instanceId: string;
  pluginId?: string;
  namespace: HistorySourceNamespace;
  config?: HistorySourceConfig;
  packageRoot?: string;
}

export class HistorySourceInstance implements HistorySourceService {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly namespace: HistorySourceNamespace;
  readonly config: HistorySourceConfig;
  readonly identity: HistorySourceIdentity;

  private readonly scanCache = new Map<string, CachedSummaryEntry>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly instanceController = new AbortController();
  private disposed = false;
  private opCounter = 0;
  private lastError: string | null = null;

  constructor(opts: HistorySourceInstanceOptions) {
    this.instanceId = opts.instanceId;
    this.pluginId = opts.pluginId ?? opts.instanceId;
    this.namespace = opts.namespace;
    this.config = opts.config ?? {};
    const fallbackCustomRoot =
      opts.namespace === 'custom' && opts.packageRoot ? path.join(opts.packageRoot, 'samples') : undefined;
    this.identity = resolveHistorySourceIdentity(this.namespace, this.config, fallbackCustomRoot);
  }

  dispose(): number {
    this.disposed = true;
    const pending = [...this.inFlight.entries()];
    this.inFlight.clear();
    let abortedCount = 0;
    for (const [, controller] of pending) {
      if (!controller.signal.aborted) {
        abortedCount += 1;
        controller.abort('来源实例已停用');
      }
    }
    if (!this.instanceController.signal.aborted) {
      this.instanceController.abort('来源实例已停用');
    }
    this.scanCache.clear();
    return abortedCount;
  }

  clearCache(): void {
    this.scanCache.clear();
  }

  async getStatus(): Promise<HistorySourceResult<HistorySourceStatus>> {
    return ok({
      instanceId: this.instanceId,
      pluginId: this.pluginId,
      namespace: this.namespace,
      sourceId: this.identity.sourceId,
      isDefault: this.identity.isDefault,
      roots: [...this.identity.roots],
      compatLegacySources: [...this.identity.compatLegacySources],
      active: !this.disposed,
      inFlightOperations: this.inFlight.size,
      cacheEntries: this.scanCache.size,
      lastError: this.lastError,
    });
  }

  async cancel(req: HistoryCancelRequest = {}): Promise<HistorySourceResult<HistoryCancelValue>> {
    const rawId = typeof req.operationId === 'string' && req.operationId.trim()
      ? req.operationId.trim()
      : (typeof (req as { requestId?: unknown }).requestId === 'string'
          ? String((req as { requestId: string }).requestId).trim()
          : undefined);
    if (rawId) {
      const controller = this.inFlight.get(rawId);
      if (!controller) {
        return ok({ cancelled: false, operationId: rawId, abortedCount: 0 });
      }
      controller.abort('用户或上级任务取消');
      this.inFlight.delete(rawId);
      return ok({ cancelled: true, operationId: rawId, abortedCount: 1 });
    }

    let abortedCount = 0;
    for (const [opId, controller] of [...this.inFlight.entries()]) {
      controller.abort('来源操作已批量取消');
      this.inFlight.delete(opId);
      abortedCount += 1;
    }
    return ok({ cancelled: abortedCount > 0, abortedCount });
  }

  private registerOperation(operationId?: string): { opId: string; signal: AbortSignal; cleanup: () => void } {
    const opId = operationId?.trim() || `op_${++this.opCounter}`;
    const controller = new AbortController();
    const onInstanceAbort = () => {
      controller.abort(this.instanceController.signal.reason ?? '来源实例已停用');
    };
    if (this.instanceController.signal.aborted) {
      onInstanceAbort();
    } else {
      this.instanceController.signal.addEventListener('abort', onInstanceAbort, { once: true });
    }
    this.inFlight.set(opId, controller);
    return {
      opId,
      signal: controller.signal,
      cleanup: () => {
        this.instanceController.signal.removeEventListener('abort', onInstanceAbort);
        if (this.inFlight.get(opId) === controller) {
          this.inFlight.delete(opId);
        }
      },
    };
  }

  async discover(req: HistoryDiscoverRequest = {}): Promise<HistorySourceResult<HistoryDiscoverValue>> {
    if (this.disposed) {
      return fail('cancelled', '来源实例已停用');
    }
    if (req !== null && typeof req !== 'object') {
      return fail('invalid_request', 'discover 请求参数无效');
    }

    const cursorRes = decodeOffsetCursor(req.cursor);
    if (!cursorRes.ok) {
      return fail('invalid_request', cursorRes.message);
    }
    const offset = cursorRes.offset;
    const rawLimit = req.limit ?? 20;
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
      return fail('invalid_request', 'discover limit 必须为正整数');
    }
    const limit = Math.min(1000, Math.floor(rawLimit));

    if (typeof req.fromTs === 'number' && !Number.isFinite(req.fromTs)) {
      return fail('invalid_request', 'fromTs 必须为有效时间戳');
    }
    if (typeof req.toTs === 'number' && !Number.isFinite(req.toTs)) {
      return fail('invalid_request', 'toTs 必须为有效时间戳');
    }

    if (req.refresh) {
      this.scanCache.clear();
    }

    const op = this.registerOperation(req.operationId);
    try {
      const hasFilters = Boolean(
        req.query?.trim()
        || req.workspaceId
        || req.workspaceCwd
        || req.harnessKind
        || req.source
        || typeof req.fromTs === 'number'
        || typeof req.toTs === 'number',
      );
      const scanBudget = this.config.maxScanFiles ?? Math.max((offset + limit) * 4, hasFilters ? 400 : 120);
      const entries = await this.scanEntries(scanBudget, op.signal);
      if (op.signal.aborted) {
        return fail('cancelled', 'discover 操作已取消');
      }
      const filtered = entries
        .filter((entry) => matchesDiscoverFilters(entry, req, (entry as { workspaceId?: string }).workspaceId))
        .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.summary.ref.nativeSessionId.localeCompare(b.summary.ref.nativeSessionId));

      const page = filtered.slice(offset, offset + limit).map((e) => e.summary);
      const nextCursor = offset + page.length < filtered.length ? encodeOffsetCursor(offset + page.length) : null;
      this.lastError = null;
      return ok({ sessions: page, nextCursor });
    } catch (err) {
      if (err instanceof HistoryReadCancelledError || op.signal.aborted || this.disposed) {
        return fail('cancelled', err instanceof Error ? err.message : 'discover 操作已取消');
      }
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return fail('source_unreadable', message);
    } finally {
      op.cleanup();
    }
  }

  async read(req: HistoryReadRequest): Promise<HistorySourceResult<HistoryReadValue>> {
    if (this.disposed) {
      return fail('cancelled', '来源实例已停用');
    }
    if (!req || typeof req !== 'object' || !req.ref || typeof req.ref !== 'object') {
      return fail('invalid_request', '缺少有效的 ref 参数');
    }
    const { ref } = req;
    if (ref.sourceInstanceId !== this.instanceId) {
      return fail('invalid_request', `ref.sourceInstanceId (${ref.sourceInstanceId}) 与当前实例 (${this.instanceId}) 不匹配`);
    }
    if (ref.sourceId !== this.identity.sourceId) {
      return fail('invalid_request', `ref.sourceId (${ref.sourceId}) 与当前来源 (${this.identity.sourceId}) 不匹配`);
    }
    if (typeof ref.nativeSessionId !== 'string' || !ref.nativeSessionId.trim()) {
      return fail('invalid_request', 'ref.nativeSessionId 不能为空');
    }

    const cursorRes = decodeOffsetCursor(req.cursor);
    if (!cursorRes.ok) {
      return fail('invalid_request', cursorRes.message);
    }
    const offset = cursorRes.offset;
    const rawLimit = req.limit ?? 100;
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
      return fail('invalid_request', 'read limit 必须为正整数');
    }
    const limit = Math.min(500, Math.floor(rawLimit));
    const pageMaxBytes = Math.max(4096, this.config.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES);

    const op = this.registerOperation(req.operationId);
    try {
      const readOutcome = await this.readFullTranscript(ref.nativeSessionId.trim(), op.signal);
      if (op.signal.aborted || this.disposed) {
        return fail('cancelled', 'read 操作已取消');
      }
      if (!readOutcome.ok) {
        this.lastError = readOutcome.message;
        return fail(readOutcome.code, readOutcome.message);
      }

      const { messages, partial, warnings, fileLockedWarning } = readOutcome;
      const { items, nextCursor } = paginateItems(messages, offset, limit, pageMaxBytes);
      this.lastError = null;
      return ok({
        ref: {
          sourceInstanceId: this.instanceId,
          sourceId: this.identity.sourceId,
          nativeSessionId: ref.nativeSessionId.trim(),
        },
        items,
        nextCursor,
        readStatus: partial ? 'partial' : 'complete',
        warnings,
        ...(fileLockedWarning ? { fileLockedWarning: true } : {}),
      });
    } catch (err) {
      if (err instanceof HistoryReadCancelledError || op.signal.aborted || this.disposed) {
        return fail('cancelled', err instanceof Error ? err.message : 'read 操作已取消');
      }
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return fail('source_unreadable', message);
    } finally {
      op.cleanup();
    }
  }

  private toSummary(params: {
    nativeSessionId: string;
    title: string;
    harnessKind: string;
    updatedAt: number;
    cwd?: string | null;
    workspaceLabel?: string;
    legacySource?: string;
    sourcePath?: string;
  }): HistorySummary {
    const workspaceHint = params.cwd
      ? workspaceHintFromCwd(params.cwd)
      : (params.workspaceLabel ? { label: params.workspaceLabel } : undefined);
    return {
      ref: {
        sourceInstanceId: this.instanceId,
        sourceId: this.identity.sourceId,
        nativeSessionId: params.nativeSessionId,
      },
      title: params.title,
      harnessKind: params.harnessKind,
      updatedAt: params.updatedAt,
      ...(workspaceHint ? { workspaceHint } : {}),
      ...(params.legacySource ? { legacySource: params.legacySource } : {}),
      ...(this.identity.compatLegacySources.length > 0
        ? { compatLegacySources: [...this.identity.compatLegacySources] }
        : {}),
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
    };
  }

  private async scanEntries(maxFiles: number, signal: AbortSignal): Promise<Array<InternalDiscoveredEntry & { workspaceId?: string }>> {
    if (!Array.isArray(this.config.records)) {
      verifyExplicitRoots(this.identity.roots, this.config);
    }
    switch (this.namespace) {
      case 'codex':
        return this.scanCodex(maxFiles, signal);
      case 'claude':
        return this.scanClaude(maxFiles, signal);
      case 'agy_cli':
      case 'agy_desktop':
        return this.scanAgy(maxFiles, signal);
      case 'custom':
        return this.scanCustom(signal);
    }
  }

  private async scanCodex(maxFiles: number, signal: AbortSignal): Promise<InternalDiscoveredEntry[]> {
    const names = new Map<string, string>();
    const files: Array<{ file: string; mtimeMs: number; size: number }> = [];

    for (const root of this.identity.roots) {
      if (signal.aborted) throw new HistoryReadCancelledError();
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;

      try {
        const indexFile = path.join(verified.realRoot, 'session_index.jsonl');
        if (fs.existsSync(indexFile)) {
          for await (const row of streamJsonLinesAbortable(indexFile, { signal })) {
            if (typeof row.id === 'string' && typeof row.thread_name === 'string') {
              names.set(row.id, row.thread_name);
            }
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
        // optional title index
      }

      for (const sub of ['sessions', 'archived_sessions']) {
        files.push(...collectFiles(path.join(verified.realRoot, sub), 3, (name) => isCodexRolloutName(name)));
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidateWindow = files.slice(0, maxFiles);
    const originSet = this.config.origins?.length ? new Set(this.config.origins) : undefined;

    const parsed = await mapWithConcurrency(candidateWindow, SCAN_CONCURRENCY, signal, async ({ file, mtimeMs, size }) => {
      const cached = this.scanCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.summary ? { summary: cached.summary, sourcePath: cached.sourcePath } : null;
      }
      try {
        const meta = await readFirstJsonlRecord(file, signal);
        const payload = (meta?.type === 'session_meta' && meta.payload && typeof meta.payload === 'object'
          ? meta.payload
          : undefined) as Record<string, unknown> | undefined;
        const nativeSessionId = payload?.id ?? meta?.id;
        if (typeof nativeSessionId !== 'string' || !nativeSessionId) {
          this.scanCache.set(file, { mtimeMs, size, summary: null, sourcePath: file });
          return null;
        }
        const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
        const origin = String(payload?.originator ?? '').toLowerCase();
        const desktop = origin.startsWith('codex desktop')
          || origin === 'codex app'
          || origin === 'codex_vscode'
          || payload?.source === 'vscode';
        const legacySource: 'codex_desktop' | 'codex_cli' = desktop ? 'codex_desktop' : 'codex_cli';
        const summary = this.toSummary({
          nativeSessionId,
          title: names.get(nativeSessionId) || `Codex · ${path.basename(cwd || nativeSessionId)}`,
          harnessKind: this.config.harnessKind ?? 'codex',
          updatedAt: Math.floor(mtimeMs),
          cwd,
          legacySource,
          sourcePath: file,
        });
        this.scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
        return { summary, sourcePath: file };
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
        return null;
      }
    });

    const deduped = new Map<string, InternalDiscoveredEntry>();
    for (const item of parsed) {
      if (!item) continue;
      if (originSet && item.summary.legacySource && !originSet.has(item.summary.legacySource as 'codex_cli' | 'codex_desktop')) {
        continue;
      }
      const id = item.summary.ref.nativeSessionId;
      if (deduped.has(id)) continue;
      const latestTitle = names.get(id);
      const summary = latestTitle ? { ...item.summary, title: latestTitle } : item.summary;
      deduped.set(id, { summary, sourcePath: item.sourcePath });
    }
    return [...deduped.values()];
  }

  private async scanClaude(maxFiles: number, signal: AbortSignal): Promise<InternalDiscoveredEntry[]> {
    const index = new Map<string, Record<string, unknown>>();
    const files: Array<{ file: string; mtimeMs: number; size: number }> = [];

    for (const root of this.identity.roots) {
      if (signal.aborted) throw new HistoryReadCancelledError();
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;

      try {
        const historyFile = path.join(verified.realRoot, 'history.jsonl');
        if (fs.existsSync(historyFile)) {
          for await (const row of streamJsonLinesAbortable(historyFile, { signal })) {
            if (typeof row.sessionId === 'string') {
              index.set(row.sessionId, row);
            }
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
        // optional prompt index
      }

      files.push(
        ...collectFiles(path.join(verified.realRoot, 'projects'), 1, (name) => /^[\da-f-]{36}\.jsonl$/i.test(name)),
      );
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const window = files.slice(0, maxFiles);
    const parsed = await mapWithConcurrency(window, SCAN_CONCURRENCY, signal, async ({ file, mtimeMs, size }) => {
      const cached = this.scanCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.summary) {
        return { summary: cached.summary, sourcePath: cached.sourcePath };
      }
      const nativeSessionId = path.basename(file, '.jsonl');
      const row = index.get(nativeSessionId);
      let cwd = typeof row?.project === 'string' ? row.project : null;
      if (!cwd) {
        try {
          for await (const item of streamJsonLinesAbortable(file, { maxBytes: 512 * 1024, maxLines: 50, signal })) {
            if (typeof item.cwd === 'string') {
              cwd = item.cwd;
              break;
            }
          }
        } catch (err) {
          if (err instanceof HistoryReadCancelledError) throw err;
          return null;
        }
      }
      const summary = this.toSummary({
        nativeSessionId,
        title: (String(row?.display || '') || `Claude · ${path.basename(cwd || nativeSessionId)}`).slice(0, 100),
        harnessKind: this.config.harnessKind ?? 'claude',
        updatedAt: Math.floor(mtimeMs),
        cwd,
        legacySource: 'claude_cli',
        sourcePath: file,
      });
      this.scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
      return { summary, sourcePath: file };
    });

    const deduped = new Map<string, InternalDiscoveredEntry>();
    for (const item of parsed) {
      if (!item) continue;
      if (!deduped.has(item.summary.ref.nativeSessionId)) {
        deduped.set(item.summary.ref.nativeSessionId, item);
      }
    }
    return [...deduped.values()];
  }

  private scanAgy(maxFiles: number, signal: AbortSignal): InternalDiscoveredEntry[] {
    const legacySource = this.namespace === 'agy_desktop' ? 'agy_desktop' : 'agy_cli';
    const found = new Map<string, InternalDiscoveredEntry>();

    for (const root of this.identity.roots) {
      if (signal.aborted) throw new HistoryReadCancelledError();
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;

      const dbPath = path.join(verified.realRoot, 'conversation_summaries.db');
      let dbReadFailed = false;
      try {
        const dbLstat = fs.lstatSync(dbPath);
        if (!dbLstat.isSymbolicLink() && dbLstat.isFile()) {
          const realDb = fs.realpathSync(dbPath);
          if (!isWithinCanonicalRoot(verified.realRoot, realDb)) {
            throw new Error('拦截到越界或符号链接 AGY 摘要数据库');
          }
          const hasWal = fs.existsSync(`${realDb}-wal`);
          const hasShm = fs.existsSync(`${realDb}-shm`);
          const target = hasWal && hasShm ? realDb : `${pathToFileURL(realDb).href}?immutable=1`;
          const db = new DatabaseSync(target, { readOnly: true });
          try {
            const rows = db
              .prepare(
                `SELECT conversation_id, title, workspace_uris, last_modified_time
                 FROM conversation_summaries
                 ORDER BY last_modified_time DESC LIMIT ?`,
              )
              .all(maxFiles) as Array<Record<string, unknown>>;
            for (const row of rows) {
              if (signal.aborted) throw new HistoryReadCancelledError();
              if (typeof row.conversation_id !== 'string' || !/^[\da-f-]{36}$/i.test(row.conversation_id)) continue;
              const nativeSessionId = row.conversation_id;
              let cwd: string | null = null;
              try {
                const uris: unknown = JSON.parse(String(row.workspace_uris));
                if (Array.isArray(uris)) {
                  for (const uri of uris) {
                    if (typeof uri === 'string' && uri.startsWith('file:')) {
                      cwd = fileURLToPath(uri);
                      break;
                    }
                  }
                }
              } catch {
                // optional workspace uri
              }
              found.set(nativeSessionId, {
                summary: this.toSummary({
                  nativeSessionId,
                  title: String(row.title || `AGY · ${nativeSessionId.slice(0, 12)}`),
                  harnessKind: this.config.harnessKind ?? 'agy',
                  updatedAt: Date.parse(String(row.last_modified_time)) || 0,
                  cwd,
                  legacySource,
                }),
              });
            }
          } finally {
            db.close();
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
        if (fs.existsSync(dbPath)) {
          dbReadFailed = true;
          throw new Error(`无法只读打开 AGY 摘要数据库 (${path.basename(dbPath)}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const convDir = path.join(verified.realRoot, 'conversations');
      try {
        const convStat = fs.lstatSync(convDir);
        const realConvDir = fs.realpathSync(convDir);
        if (!convStat.isSymbolicLink() && convStat.isDirectory() && isWithinCanonicalRoot(verified.realRoot, realConvDir) && !dbReadFailed) {
          for (const { file, mtimeMs } of collectFiles(convDir, 0, (name) => /^[\da-f-]{36}\.(db|pb)$/i.test(name))) {
            if (signal.aborted) throw new HistoryReadCancelledError();
            if (found.size >= maxFiles) break;
            const nativeSessionId = path.basename(file, path.extname(file));
            if (found.has(nativeSessionId)) continue;
            found.set(nativeSessionId, {
              summary: this.toSummary({
                nativeSessionId,
                title: `AGY · ${nativeSessionId.slice(0, 12)}`,
                harnessKind: this.config.harnessKind ?? 'agy',
                updatedAt: Math.floor(mtimeMs),
                cwd: null,
                legacySource,
                sourcePath: file,
              }),
              sourcePath: file,
            });
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
      }
    }

    return [...found.values()];
  }

  private async scanCustom(signal: AbortSignal): Promise<Array<InternalDiscoveredEntry & { workspaceId?: string }>> {
    const out: Array<InternalDiscoveredEntry & { workspaceId?: string }> = [];
    if (Array.isArray(this.config.records)) {
      for (const rec of this.config.records) {
        if (signal.aborted) throw new HistoryReadCancelledError();
        if (!rec || typeof rec.nativeSessionId !== 'string' || !rec.nativeSessionId.trim()) continue;
        out.push({
          workspaceId: rec.workspaceId,
          summary: this.toSummary({
            nativeSessionId: rec.nativeSessionId.trim(),
            title: rec.title || `Custom · ${rec.nativeSessionId.slice(0, 12)}`,
            harnessKind: rec.harnessKind ?? this.config.harnessKind ?? 'custom',
            updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
            cwd: rec.cwd,
            workspaceLabel: rec.workspaceLabel,
            legacySource: 'custom',
          }),
        });
      }
      return out;
    }

    for (const root of this.identity.roots) {
      if (signal.aborted) throw new HistoryReadCancelledError();
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;

      const files = collectFiles(verified.realRoot, 2, (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'));
      for (const { file, mtimeMs, size } of files) {
        if (signal.aborted) throw new HistoryReadCancelledError();
        const cached = this.scanCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.summary) {
          out.push({ summary: cached.summary, sourcePath: file });
          continue;
        }
        try {
          const meta = await readFirstJsonlRecord(file, signal);
          const payload = (meta?.type === 'session_meta' && meta.payload && typeof meta.payload === 'object'
            ? meta.payload
            : meta) as Record<string, unknown> | undefined;
          const nativeSessionId = typeof payload?.nativeSessionId === 'string'
            ? payload.nativeSessionId
            : typeof payload?.id === 'string'
              ? payload.id
              : path.basename(file).replace(/\.jsonl(?:\.zst)?$/i, '');
          const title = typeof payload?.title === 'string' && payload.title.trim()
            ? payload.title.trim()
            : `Custom · ${nativeSessionId}`;
          const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
          const workspaceLabel = typeof payload?.workspaceLabel === 'string' ? payload.workspaceLabel : undefined;
          const updatedAt = typeof payload?.updatedAt === 'number' ? payload.updatedAt : Math.floor(mtimeMs);
          const harnessKind = typeof payload?.harnessKind === 'string'
            ? payload.harnessKind
            : (this.config.harnessKind ?? 'custom');
          const summary = this.toSummary({
            nativeSessionId,
            title,
            harnessKind,
            updatedAt,
            cwd,
            workspaceLabel,
            legacySource: 'custom',
            sourcePath: file,
          });
          this.scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
          out.push({
            summary,
            sourcePath: file,
            workspaceId: typeof payload?.workspaceId === 'string' ? payload.workspaceId : undefined,
          });
        } catch (err) {
          if (err instanceof HistoryReadCancelledError) throw err;
        }
      }
    }

    return out;
  }

  private findFileForSession(nativeSessionId: string): string | undefined {
    for (const entry of this.scanCache.values()) {
      if (entry.summary?.ref.nativeSessionId === nativeSessionId && entry.sourcePath) {
        return entry.sourcePath;
      }
    }

    for (const root of this.identity.roots) {
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;

      if (this.namespace === 'codex') {
        for (const sub of ['sessions', 'archived_sessions']) {
          const matches = collectFiles(
            path.join(verified.realRoot, sub),
            3,
            (name) => isCodexRolloutName(name, nativeSessionId),
          );
          if (matches[0]) return matches[0].file;
        }
      } else if (this.namespace === 'claude') {
        const matches = collectFiles(
          path.join(verified.realRoot, 'projects'),
          1,
          (name) => name === `${nativeSessionId}.jsonl`,
        );
        if (matches[0]) return matches[0].file;
      } else if (this.namespace === 'custom') {
        const matches = collectFiles(
          verified.realRoot,
          2,
          (name) => name === `${nativeSessionId}.jsonl` || name === `${nativeSessionId}.jsonl.zst`,
        );
        if (matches[0]) return matches[0].file;
      }
    }
    return undefined;
  }

  private async readFullTranscript(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; messages: HistoryMessage[]; partial: boolean; warnings: string[]; fileLockedWarning?: boolean }
    | { ok: false; code: 'invalid_request' | 'source_unreadable'; message: string }
  > {
    if (this.namespace === 'agy_cli' || this.namespace === 'agy_desktop') {
      if (this.identity.roots.length === 0) {
        return { ok: false, code: 'source_unreadable', message: '未配置 AGY 来源根目录' };
      }
      let lastFailure: { code: 'invalid_request' | 'source_unreadable'; message: string } = {
        ok: false,
        code: 'source_unreadable',
        message: '找不到对应的 AGY 原生会话记录',
      } as unknown as { code: 'invalid_request' | 'source_unreadable'; message: string };

      for (const root of this.identity.roots) {
        if (signal.aborted) throw new HistoryReadCancelledError();
        const { detailed, presence } = readAgyHistoryWithDiagnostics(root, nativeSessionId, {
          maxMessages: this.config.maxAgyMessages,
          maxTotalBytes: this.config.maxAgyBytes,
          maxDbBytes: this.config.maxAgyDbBytes,
        });
        if (detailed.skippedReason === 'invalid_session_id') {
          return { ok: false, code: 'invalid_request', message: `非法的 AGY 会话 ID: ${nativeSessionId}` };
        }
        if (detailed.skippedReason) {
          lastFailure = {
            code: 'source_unreadable',
            message: `AGY 会话不可读 (${detailed.skippedReason})`,
          };
          continue;
        }
        if (detailed.messages.length === 0) {
          if (presence.summaryExists || presence.pbExists) {
            return {
              ok: false,
              code: 'source_unreadable',
              message: '已发现 AGY 会话标题或 .pb 文件，但 conversation_summaries.db (conversations_fts) 缺少正文索引，只读来源无法解析正文',
            };
          }
          continue;
        }
        const warnings: string[] = [];
        if (detailed.partial) {
          warnings.push(
            detailed.truncatedReason === 'max_messages'
              ? 'AGY 索引历史达到消息条数上限，已截断返回'
              : 'AGY 索引历史达到字节上限，已截断返回',
          );
        }
        return { ok: true, messages: detailed.messages, partial: detailed.partial, warnings };
      }
      return { ok: false, ...lastFailure };
    }

    if (this.namespace === 'custom' && Array.isArray(this.config.records)) {
      const rec = this.config.records.find((r) => r.nativeSessionId === nativeSessionId);
      if (!rec) {
        return { ok: false, code: 'source_unreadable', message: `找不到自定义会话记录: ${nativeSessionId}` };
      }
      const messages: HistoryMessage[] = rec.items.map((item) => ({
        role: item.role,
        text: item.text,
        ...(typeof item.timestamp === 'number' ? { timestamp: item.timestamp } : {}),
      }));
      return { ok: true, messages, partial: false, warnings: [] };
    }

    let sourcePath = this.findFileForSession(nativeSessionId);
    if (!sourcePath && this.namespace === 'custom') {
      const entries = await this.scanCustom(signal);
      sourcePath = entries.find((e) => e.summary.ref.nativeSessionId === nativeSessionId)?.sourcePath;
    }
    if (!sourcePath) {
      return { ok: false, code: 'source_unreadable', message: `找不到原生会话文件: ${nativeSessionId}` };
    }

    try {
      const lst = fs.lstatSync(sourcePath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        return { ok: false, code: 'source_unreadable', message: '原生会话路径不是普通文件（已拦截符号链接）' };
      }
    } catch {
      return { ok: false, code: 'source_unreadable', message: `原生会话文件已移动或不可读: ${nativeSessionId}` };
    }

    const detailed = await readJsonlTranscriptAbortable(
      sourcePath,
      this.namespace === 'codex' ? 'codex' : this.namespace === 'claude' ? 'claude' : 'custom',
      {
        maxBytes: this.config.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
        maxLines: this.config.maxTranscriptLines ?? DEFAULT_MAX_TRANSCRIPT_LINES,
        signal,
      },
    );

    if (detailed.messages.length === 0) {
      return {
        ok: false,
        code: 'source_unreadable',
        message: detailed.partial
          ? '会话文件损坏或仅包含不可解析行，未读取到有效消息正文'
          : '会话记录存在但未包含可解析的用户/助手文本消息',
      };
    }

    return {
      ok: true,
      messages: detailed.messages,
      partial: detailed.partial,
      warnings: buildWarningsFromDetailed(detailed),
      fileLockedWarning: detailed.fileLockedWarning,
    };
  }
}

export function createCodexHistorySource(
  instanceId = 'hm.plugin.history-source-codex',
  config?: HistorySourceConfig,
): HistorySourceInstance {
  return new HistorySourceInstance({
    instanceId,
    pluginId: 'hm.plugin.history-source-codex',
    namespace: 'codex',
    config,
  });
}

export function createClaudeHistorySource(
  instanceId = 'hm.plugin.history-source-claude',
  config?: HistorySourceConfig,
): HistorySourceInstance {
  return new HistorySourceInstance({
    instanceId,
    pluginId: 'hm.plugin.history-source-claude',
    namespace: 'claude',
    config,
  });
}

export function createAgyCliHistorySource(
  instanceId = 'hm.plugin.history-source-agy-cli',
  config?: HistorySourceConfig,
): HistorySourceInstance {
  return new HistorySourceInstance({
    instanceId,
    pluginId: 'hm.plugin.history-source-agy-cli',
    namespace: 'agy_cli',
    config,
  });
}

export function createAgyDesktopHistorySource(
  instanceId = 'hm.plugin.history-source-agy-desktop',
  config?: HistorySourceConfig,
): HistorySourceInstance {
  return new HistorySourceInstance({
    instanceId,
    pluginId: 'hm.plugin.history-source-agy-desktop',
    namespace: 'agy_desktop',
    config,
  });
}

export function createCustomHistorySource(
  instanceId = 'user.history-source-custom',
  config?: HistorySourceConfig,
  packageRoot?: string,
): HistorySourceInstance {
  return new HistorySourceInstance({
    instanceId,
    pluginId: 'user.history-source-custom',
    namespace: 'custom',
    config,
    packageRoot,
  });
}

/**
 * Compatibility bridge: adapts any `HistorySourceInstance` into a legacy `NativeSessionScanner`
 * so `history-scanner.ts` callers can continue discovering & reading without breakage.
 */
export function registerHistorySourceScannerBridge(instance: HistorySourceInstance): () => void {
  const harnessKind: HarnessKind =
    instance.namespace === 'codex'
      ? 'codex'
      : instance.namespace === 'claude'
        ? 'claude'
        : instance.namespace === 'agy_cli' || instance.namespace === 'agy_desktop'
          ? 'agy'
          : 'acp';

  const scanner: NativeSessionScanner = {
    id: instance.instanceId,
    harnessKind,
    source: instance.identity.compatLegacySources[0] ?? 'custom',
    async scan(limit, id) {
      const res = await instance.discover({ limit: id ? 200 : limit, query: id });
      if (!res.ok) return [];
      const sessions = id
        ? res.value.sessions.filter((s) => s.ref.nativeSessionId === id)
        : res.value.sessions.slice(0, limit);
      return sessions.map((s): DiscoveredCliSession => ({
        harnessKind: (s.harnessKind === 'codex' || s.harnessKind === 'claude' || s.harnessKind === 'agy' || s.harnessKind === 'acp')
          ? s.harnessKind
          : 'acp',
        source: (s.legacySource as DiscoveredCliSession['source']) ?? scanner.source,
        scannerId: instance.instanceId,
        nativeSessionId: s.ref.nativeSessionId,
        title: s.title,
        cwd: s.workspaceHint?.cwd ?? null,
        updatedAt: s.updatedAt,
        ...(s.sourcePath ? { sourcePath: s.sourcePath, compressed: isZstdTranscript(s.sourcePath) } : {}),
      }));
    },
    async readHistory(session) {
      const messages: HistoryMessage[] = [];
      let cursor: string | null = null;
      let partial = false;
      let fileLockedWarning = false;
      do {
        const page = await instance.read({
          ref: {
            sourceInstanceId: instance.instanceId,
            sourceId: instance.identity.sourceId,
            nativeSessionId: session.nativeSessionId,
          },
          cursor,
          limit: 200,
        });
        if (!page.ok) {
          throw new Error(page.error.message);
        }
        for (const item of page.value.items) {
          messages.push({
            role: item.role,
            text: item.text,
            ...(typeof item.timestamp === 'number' ? { timestamp: item.timestamp } : {}),
          });
        }
        if (page.value.readStatus === 'partial') partial = true;
        if (page.value.fileLockedWarning) fileLockedWarning = true;
        cursor = page.value.nextCursor;
      } while (cursor);

      return {
        messages,
        partial,
        bytesRead: messages.reduce((sum, m) => sum + Buffer.byteLength(m.text, 'utf8'), 0),
        linesRead: messages.length,
        ...(fileLockedWarning ? { fileLockedWarning } : {}),
      };
    },
  };

  return registerNativeScanner(scanner);
}
