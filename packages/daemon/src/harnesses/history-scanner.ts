import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';
import type { DiscoveredCliSession, HarnessKind } from '@harnessmate/protocol';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

export interface JsonlReadOptions {
  /** Hard cap on decoded bytes to prevent OOM on giant transcripts (default: 200 MiB). */
  maxBytes?: number;
  /** Hard cap on JSONL lines kept in sliding window (default: 10,000). */
  maxLines?: number;
}

export interface DetailedHistoryReadResult {
  messages: HistoryMessage[];
  partial: boolean;
  bytesRead: number;
  linesRead: number;
  truncatedReason?: 'max_bytes' | 'max_lines' | 'corrupted_trailing_line';
  /** True when source file was modified within the last 5 seconds (possible active external CLI lock). */
  fileLockedWarning?: boolean;
}

export interface NativeSessionScanner {
  readonly id: string;
  readonly harnessKind: HarnessKind;
  readonly source?: DiscoveredCliSession['source'];
  scan(limit: number, id?: string): Promise<DiscoveredCliSession[]>;
  readHistory(session: DiscoveredCliSession, opts?: JsonlReadOptions): Promise<DetailedHistoryReadResult>;
}

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024; // 200 MiB
export const DEFAULT_MAX_TRANSCRIPT_LINES = 10_000;
const SCAN_CONCURRENCY = 4;

const customScanners = new Map<string, NativeSessionScanner>();

interface ScanCacheEntry {
  mtimeMs: number;
  size: number;
  session: DiscoveredCliSession | null;
}
const scanFileCache = new Map<string, ScanCacheEntry>();

export function registerNativeScanner(scanner: NativeSessionScanner): () => void {
  customScanners.set(scanner.id, scanner);
  return () => {
    if (customScanners.get(scanner.id) === scanner) {
      customScanners.delete(scanner.id);
    }
  };
}

export function unregisterNativeScanner(scannerId: string): boolean {
  return customScanners.delete(scannerId);
}

export function listNativeScanners(): NativeSessionScanner[] {
  return [...customScanners.values()];
}

export function clearScannerCache(): void {
  scanFileCache.clear();
}

const agySources = { agy_desktop: 'antigravity', agy_cli: 'antigravity-cli' } as const;

export function agyDataDirectory(source: DiscoveredCliSession['source']): string | undefined {
  return source === 'agy_desktop' ? agySources.agy_desktop : undefined;
}

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function openReadOnlySqliteWithBackoff<T>(
  dbPath: string,
  reader: (db: DatabaseSync) => T,
  fallback: T,
): T {
  if (!fs.existsSync(dbPath)) return fallback;
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 300;');
      } catch {
        // read-only pragma may be ignored on some builds
      }
      return reader(db);
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < maxAttempts - 1) {
        // Brief non-blocking backoff in sync path (bounded to <30ms)
        const waitUntil = Date.now() + 10 * (attempt + 1);
        while (Date.now() < waitUntil) {
          /* short spin for locked external SQLite */
        }
        continue;
      }
      return fallback;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close error
      }
    }
  }
  return fallback;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]!, idx);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function readAgyIndexedHistory(session: DiscoveredCliSession): HistoryMessage[] {
  if (session.source !== 'agy_desktop' && session.source !== 'agy_cli') return [];
  const dbPath = path.join(os.homedir(), '.gemini', agySources[session.source], 'conversation_summaries.db');
  return openReadOnlySqliteWithBackoff(
    dbPath,
    (db) => {
      const messages = new Map<string, HistoryMessage & { index: number }>();
      const rows = db.prepare(`SELECT user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets
        FROM conversations_fts WHERE conversation_id = ? AND chunk_index >= 0 ORDER BY chunk_index`)
        .iterate(session.nativeSessionId);
      for (const row of rows) {
        for (const [role, body, offsets] of [
          ['user', row.user_body, row.user_step_byte_offsets],
          ['assistant', row.agent_body, row.agent_step_byte_offsets],
        ] as const) {
          if (typeof body !== 'string' || !body || !offsets) continue;
          const bytes = Buffer.from(body, 'utf8');
          const offsetsText = typeof offsets === 'string' ? offsets
            : offsets instanceof Uint8Array ? Buffer.from(offsets).toString('utf8') : '';
          let positions: unknown;
          try { positions = JSON.parse(offsetsText); } catch { continue; }
          if (!Array.isArray(positions)) continue;
          for (const [entry, position] of positions.entries()) {
            if (!Array.isArray(position)) continue;
            const [index, start] = position;
            const end = positions[entry + 1]?.[1] ?? bytes.length;
            if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(start)
              || !Number.isSafeInteger(end) || start < 0 || start >= end || end > bytes.length) continue;
            const text = bytes.subarray(start, end).toString('utf8').trim();
            if (text) messages.set(`${index}:${role}`, { index, role, text });
          }
        }
      }
      return [...messages.values()].sort((a, b) => a.index - b.index)
        .map(({ role, text }) => ({ role, text }));
    },
    [],
  );
}

export async function scanLocalCliSessions(
  limitPerHarness = 20,
  opts?: { forceRefresh?: boolean },
): Promise<DiscoveredCliSession[]> {
  if (opts?.forceRefresh) {
    scanFileCache.clear();
  }
  const customResults = await Promise.all(
    [...customScanners.values()].map(async (scanner) => {
      try {
        const list = await scanner.scan(limitPerHarness);
        return list.map((item) => ({ ...item, scannerId: item.scannerId ?? scanner.id }));
      } catch {
        return [] as DiscoveredCliSession[];
      }
    }),
  );
  const groups = await Promise.all([
    scanClaude(limitPerHarness),
    scanCodex(limitPerHarness),
    ...Object.entries(agySources).map(([source, dir]) =>
      scanAgy(dir, source as keyof typeof agySources, limitPerHarness)),
    ...customResults,
  ]);
  return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findLocalSession(
  kind: HarnessKind,
  id: string,
  source?: DiscoveredCliSession['source'],
  scannerId?: string,
): Promise<DiscoveredCliSession | undefined> {
  if (scannerId && customScanners.has(scannerId)) {
    const custom = await customScanners.get(scannerId)!.scan(1, id).catch(() => []);
    if (custom[0]) return { ...custom[0], scannerId };
  }
  for (const scanner of customScanners.values()) {
    if (scanner.harnessKind === kind && (!source || scanner.source === source)) {
      const found = await scanner.scan(1, id).catch(() => []);
      if (found[0]) return { ...found[0], scannerId: scanner.id };
    }
  }
  switch (kind) {
    case 'codex': return (await scanCodex(1, id))[0];
    case 'claude': return (await scanClaude(1, id))[0];
    case 'agy': {
      const sources = source === 'agy_desktop' ? ['agy_desktop'] as const
        : source === 'agy_cli' ? ['agy_cli'] as const : ['agy_cli', 'agy_desktop'] as const;
      return sources.flatMap((key) => scanAgy(agySources[key], key, 1, id))[0];
    }
    default: return undefined;
  }
}

function isZstdFile(file: string): boolean {
  return file.toLowerCase().endsWith('.zst');
}

interface JsonLinesStats {
  bytesRead: number;
  linesRead: number;
  corruptedLines: number;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
}

async function* jsonLines(
  file: string,
  opts?: JsonlReadOptions,
  stats?: JsonLinesStats,
): AsyncGenerator<Record<string, any>> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
  const rawStream = fs.createReadStream(file);
  const compressed = isZstdFile(file);
  const decodedStream = compressed ? rawStream.pipe(createZstdDecompress()) : rawStream;
  decodedStream.setEncoding('utf8');
  const lines = createInterface({ input: decodedStream, crlfDelay: Infinity });
  const localStats: JsonLinesStats = stats ?? {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };
  let aborted = false;
  try {
    for await (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (localStats.bytesRead + lineBytes > maxBytes) {
        localStats.truncatedByBytes = true;
        aborted = true;
        break;
      }
      if (localStats.linesRead >= maxLines) {
        localStats.truncatedByLines = true;
        aborted = true;
        break;
      }
      localStats.bytesRead += lineBytes;
      localStats.linesRead += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          yield row;
        }
      } catch {
        // Incomplete trailing record while external app is writing, or corrupt line
        localStats.corruptedLines += 1;
      }
    }
  } catch {
    // Graceful tolerance for truncated zstd streams or mid-write EOF
    if (!aborted) {
      localStats.corruptedLines += 1;
    }
  } finally {
    lines.close();
    if (compressed) {
      decodedStream.destroy();
    }
    rawStream.destroy();
  }
}

async function firstRecord(file: string) {
  for await (const row of jsonLines(file, { maxBytes: 1024 * 1024, maxLines: 16 })) return row;
  return undefined;
}

function dirs(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function collectFiles(dir: string, depth: number, nameMatches: (name: string) => boolean) {
  const files: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const walk = (root: string, remaining: number) => {
    for (const ent of dirs(root)) {
      const file = path.join(root, ent.name);
      if (ent.isDirectory() && remaining > 0) walk(file, remaining - 1);
      if (ent.isFile() && nameMatches(ent.name)) {
        try {
          const st = fs.statSync(file);
          files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* rotated */ }
      }
    }
  };
  walk(dir, depth);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function getCodexRolloutStore(rollout: string): { home: string; archived: boolean } | undefined {
  let current = path.dirname(rollout);
  while (path.dirname(current) !== current) {
    const name = path.basename(current);
    if (name === 'sessions' || name === 'archived_sessions') {
      return { home: path.dirname(current), archived: name === 'archived_sessions' };
    }
    current = path.dirname(current);
  }
  return undefined;
}

function isCodexRolloutName(name: string, id?: string): boolean {
  const isPlain = name.endsWith('.jsonl');
  const isZst = name.endsWith('.jsonl.zst');
  if (!isPlain && !isZst) return false;
  if (!id) return true;
  return name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`) || name === `${id}.jsonl` || name === `${id}.jsonl.zst`;
}

export async function scanCodexFromHomes(
  homes: readonly string[],
  limit: number,
  id?: string,
): Promise<DiscoveredCliSession[]> {
  const names = new Map<string, string>();
  const files: ReturnType<typeof collectFiles> = [];
  for (const home of homes) {
    try {
      const indexFile = path.join(home, 'session_index.jsonl');
      if (fs.existsSync(indexFile)) {
        for await (const row of jsonLines(indexFile)) {
          if (typeof row.id === 'string' && typeof row.thread_name === 'string') {
            names.set(row.id, row.thread_name);
          }
        }
      }
    } catch { /* optional title index */ }
    for (const dir of ['sessions', 'archived_sessions']) {
      files.push(...collectFiles(path.join(home, dir), 3, (name) => isCodexRolloutName(name, id)));
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const candidateWindow = id ? files : files.slice(0, Math.max(limit * 4, 40));
  const parsedList = await mapWithConcurrency(candidateWindow, SCAN_CONCURRENCY, async ({ file, mtimeMs, size }) => {
    const cached = scanFileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.session;
    }
    try {
      const meta = await firstRecord(file);
      const payload = meta?.type === 'session_meta' ? meta.payload : undefined;
      const nativeSessionId: unknown = payload?.id ?? meta?.id ?? meta?.payload?.id;
      if (typeof nativeSessionId !== 'string') {
        scanFileCache.set(file, { mtimeMs, size, session: null });
        return null;
      }
      const cwd = typeof meta?.payload?.cwd === 'string' ? meta.payload.cwd : null;
      const origin = String(payload?.originator ?? '').toLowerCase();
      const desktop = origin.startsWith('codex desktop') || origin === 'codex app'
        || origin === 'codex_vscode' || payload?.source === 'vscode';
      const source: DiscoveredCliSession['source'] = desktop ? 'codex_desktop' : 'codex_cli';
      const discovered: DiscoveredCliSession = {
        harnessKind: 'codex',
        source,
        scannerId: 'codex',
        nativeSessionId,
        title: names.get(nativeSessionId) || `Codex · ${path.basename(cwd || nativeSessionId)}`,
        cwd,
        updatedAt: Math.floor(mtimeMs),
        sourcePath: file,
        fileSizeBytes: size,
        compressed: isZstdFile(file),
      };
      scanFileCache.set(file, { mtimeMs, size, session: discovered });
      return discovered;
    } catch {
      return null;
    }
  });

  const result = new Map<string, DiscoveredCliSession>();
  const counts = { codex_desktop: 0, codex_cli: 0 };
  for (const item of parsedList) {
    if (!item) continue;
    if (id && item.nativeSessionId !== id) continue;
    if (result.has(item.nativeSessionId)) continue;
    const src = item.source === 'codex_desktop' ? 'codex_desktop' : 'codex_cli';
    if (!id && counts[src] >= limit) continue;
    counts[src] += 1;
    // Update title in case session_index.jsonl changed since cache
    const latestTitle = names.get(item.nativeSessionId);
    result.set(item.nativeSessionId, latestTitle ? { ...item, title: latestTitle } : item);
    if (id && result.size) break;
    if (!id && counts.codex_desktop >= limit && counts.codex_cli >= limit) break;
  }
  return [...result.values()];
}

async function scanCodex(limit: number, id?: string): Promise<DiscoveredCliSession[]> {
  const homes = new Set<string>();
  for (const candidate of [process.env.CODEX_HOME, path.join(os.homedir(), '.codex')]) {
    if (!candidate) continue;
    try { homes.add(fs.realpathSync(candidate)); } catch { /* absent profile */ }
  }
  return scanCodexFromHomes([...homes], limit, id);
}

export async function scanClaudeFromHome(
  home: string,
  limit: number,
  id?: string,
): Promise<DiscoveredCliSession[]> {
  const index = new Map<string, Record<string, any>>();
  try {
    const historyFile = path.join(home, 'history.jsonl');
    if (fs.existsSync(historyFile)) {
      for await (const row of jsonLines(historyFile)) {
        if (typeof row.sessionId === 'string' && (!id || row.sessionId === id)) index.set(row.sessionId, row);
      }
    }
  } catch { /* optional prompt index */ }
  const files = collectFiles(
    path.join(home, 'projects'),
    1,
    (name) => /^[\da-f-]{36}\.jsonl$/i.test(name) && (!id || name === `${id}.jsonl`),
  ).slice(0, id ? 5 : Math.max(limit * 2, 30));

  const parsed = await mapWithConcurrency(files, SCAN_CONCURRENCY, async ({ file, mtimeMs, size }) => {
    const nativeSessionId = path.basename(file, '.jsonl');
    const row = index.get(nativeSessionId);
    const cached = scanFileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.session) {
      return cached.session;
    }
    let cwd = typeof row?.project === 'string' ? row.project : null;
    if (!cwd) {
      try {
        for await (const item of jsonLines(file, { maxBytes: 512 * 1024, maxLines: 50 })) {
          if (typeof item.cwd === 'string') { cwd = item.cwd; break; }
        }
      } catch {
        return null;
      }
    }
    const discovered: DiscoveredCliSession = {
      harnessKind: 'claude',
      source: 'claude_cli',
      scannerId: 'claude',
      nativeSessionId,
      title: (String(row?.display || '') || `Claude · ${path.basename(cwd || nativeSessionId)}`).slice(0, 100),
      cwd,
      updatedAt: Math.floor(mtimeMs),
      sourcePath: file,
      fileSizeBytes: size,
      compressed: false,
    };
    scanFileCache.set(file, { mtimeMs, size, session: discovered });
    return discovered;
  });

  return parsed.filter((item): item is DiscoveredCliSession => Boolean(item)).slice(0, limit);
}

async function scanClaude(limit: number, id?: string): Promise<DiscoveredCliSession[]> {
  return scanClaudeFromHome(claudeHome(), limit, id);
}

function scanAgy(dir: string, source: keyof typeof agySources, limit: number, id?: string): DiscoveredCliSession[] {
  const root = path.join(os.homedir(), '.gemini', dir);
  const dbPath = path.join(root, 'conversation_summaries.db');
  const found = new Map<string, DiscoveredCliSession>();

  const rows = openReadOnlySqliteWithBackoff(
    dbPath,
    (db) =>
      db.prepare(`SELECT conversation_id, title, workspace_uris, last_modified_time
        FROM conversation_summaries ${id ? 'WHERE conversation_id = ?' : ''}
        ORDER BY last_modified_time DESC LIMIT ?`).all(...(id ? [id, limit] : [limit])) as Array<Record<string, unknown>>,
    [],
  );

  for (const row of rows) {
    if (typeof row.conversation_id !== 'string' || !/^[\da-f-]{36}$/i.test(row.conversation_id)) continue;
    const nativeSessionId = row.conversation_id;
    let cwd: string | null = null;
    try {
      const uris: unknown = JSON.parse(String(row.workspace_uris));
      if (Array.isArray(uris)) {
        for (const uri of uris) {
          if (typeof uri === 'string' && uri.startsWith('file:')) { cwd = fileURLToPath(uri); break; }
        }
      }
    } catch { /* optional workspace */ }
    found.set(nativeSessionId, {
      harnessKind: 'agy',
      source,
      scannerId: source,
      nativeSessionId,
      cwd,
      title: String(row.title || `AGY · ${nativeSessionId.slice(0, 12)}`),
      updatedAt: Date.parse(String(row.last_modified_time)) || 0,
      compressed: false,
    });
  }

  if (found.size < limit) {
    for (const { file, mtimeMs, size } of collectFiles(path.join(root, 'conversations'), 0,
      (name) => /^[\da-f-]{36}\.(db|pb)$/i.test(name) && (!id || name.startsWith(`${id}.`)))) {
      if (found.size >= limit) break;
      const nativeSessionId = path.basename(file, path.extname(file));
      if (!found.has(nativeSessionId)) found.set(nativeSessionId, {
        harnessKind: 'agy',
        source,
        scannerId: source,
        nativeSessionId,
        cwd: null,
        title: `AGY · ${nativeSessionId.slice(0, 12)}`,
        updatedAt: Math.floor(mtimeMs),
        fileSizeBytes: size,
        compressed: false,
      });
    }
  }
  return [...found.values()];
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((item) => item && ['text', 'input_text', 'output_text'].includes(item.type)
    && typeof item.text === 'string' ? [item.text] : []).join('\n');
}

export async function readJsonlHistoryDetailed(
  session: DiscoveredCliSession,
  opts?: JsonlReadOptions,
): Promise<DetailedHistoryReadResult> {
  if (session.scannerId && customScanners.has(session.scannerId)) {
    return customScanners.get(session.scannerId)!.readHistory(session, opts);
  }
  if (!session.sourcePath) throw new Error('找不到原生会话记录');

  let fileLockedWarning = false;
  try {
    const st = fs.statSync(session.sourcePath);
    if (Date.now() - st.mtimeMs < 5_000) {
      fileLockedWarning = true;
    }
  } catch {
    // ignore stat race
  }

  const stats: JsonLinesStats = {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };
  const messages: HistoryMessage[] = [];
  const positions = new Map<string, number>();
  const eventMessages: HistoryMessage[] = [];
  for await (const row of jsonLines(session.sourcePath, opts, stats)) {
    const timestamp = Date.parse(String(row.timestamp)) || undefined;
    if (session.harnessKind === 'codex' && row.type === 'event_msg') {
      const role = row.payload?.type === 'user_message' ? 'user'
        : row.payload?.type === 'agent_message' ? 'assistant' : undefined;
      if (role && typeof row.payload.message === 'string' && row.payload.message.trim()) {
        eventMessages.push({ role, text: row.payload.message, timestamp });
      }
    }
    const message = session.harnessKind === 'codex'
      ? (row.type === 'response_item' && row.payload?.type === 'message' ? row.payload : undefined)
      : (row.type === 'user' || row.type === 'assistant') && !row.isMeta && !row.isSidechain && !row.isCompactSummary
        ? row.message : undefined;
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = messageText(message.content);
    if (session.harnessKind === 'codex' && role === 'user' && Array.isArray(message.content)) {
      text = messageText(message.content.filter((block: any) =>
        typeof block?.text !== 'string' || !/^(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions)/.test(block.text.trim())));
    }
    if (!text.trim()) continue;
    const key = typeof message.id === 'string' ? message.id : undefined;
    const position = key ? positions.get(key) : undefined;
    if (position === undefined) {
      if (key) positions.set(key, messages.length);
      messages.push({ role, text, timestamp });
    } else if (text.startsWith(messages[position]!.text)) {
      messages[position]!.text = text;
    } else if (text !== messages[position]!.text) {
      messages[position]!.text += `\n\n${text}`;
    }
  }
  const finalMessages =
    messages.some((message) => message.role === 'user') || !eventMessages.length
      ? messages
      : eventMessages;

  const partial = stats.truncatedByBytes || stats.truncatedByLines || stats.corruptedLines > 0;
  const truncatedReason = stats.truncatedByBytes
    ? 'max_bytes'
    : stats.truncatedByLines
      ? 'max_lines'
      : stats.corruptedLines > 0
        ? 'corrupted_trailing_line'
        : undefined;

  return {
    messages: finalMessages,
    partial,
    bytesRead: stats.bytesRead,
    linesRead: stats.linesRead,
    truncatedReason,
    fileLockedWarning,
  };
}

export async function readJsonlHistory(
  session: DiscoveredCliSession,
  opts?: JsonlReadOptions,
): Promise<HistoryMessage[]> {
  const result = await readJsonlHistoryDetailed(session, opts);
  return result.messages;
}
