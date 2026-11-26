import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

const DEFAULT_MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_LINES = 10_000;
const DEFAULT_MAX_AGY_SQLITE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_AGY_HISTORY_MESSAGES = 5_000;
const DEFAULT_MAX_AGY_HISTORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_PAGE_MAX_BYTES = 1_536 * 1024;
const SCAN_CONCURRENCY = 6;

const DEFAULT_LEGACY_SOURCES = {
  'codex:default': ['codex_cli', 'codex_desktop'],
  'claude:default': ['claude_cli'],
  'agy_cli:default': ['agy_cli'],
  'agy_desktop:default': ['agy_desktop'],
  'custom:default': ['custom'],
};

class HistoryReadCancelledError extends Error {
  constructor(message = '历史读取已取消') {
    super(message);
    this.name = 'HistoryReadCancelledError';
  }
}

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function canonicalizeRootPath(dirPath) {
  const resolved = path.resolve(dirPath.trim());
  try {
    const real = fs.realpathSync(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function dedupePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const key = canonicalizeRootPath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function defaultRootsForNamespace(namespace) {
  const home = os.homedir();
  switch (namespace) {
    case 'codex': {
      const candidates = [process.env.CODEX_HOME, path.join(home, '.codex')].filter(
        (item) => typeof item === 'string' && item.trim().length > 0,
      );
      return dedupePaths(candidates.map((c) => path.resolve(c)));
    }
    case 'claude':
      return [path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'))];
    case 'agy_cli':
      return [path.resolve(path.join(home, '.gemini', 'antigravity-cli'))];
    case 'agy_desktop':
      return [path.resolve(path.join(home, '.gemini', 'antigravity'))];
    default:
      return [];
  }
}

function resolveIdentity(namespace, config, fallbackDefaultRoot) {
  const configuredRoots = [];
  if (typeof config?.rootDir === 'string' && config.rootDir.trim()) {
    configuredRoots.push(path.resolve(config.rootDir.trim()));
  }
  if (Array.isArray(config?.homes)) {
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

  const explicitSourceId = typeof config?.sourceId === 'string' && config.sourceId.trim()
    ? config.sourceId.trim()
    : undefined;
  const isDefault = !explicitSourceId && matchesDefaultRoot;

  let sourceId;
  if (explicitSourceId) {
    sourceId = explicitSourceId;
  } else if (isDefault) {
    sourceId = `${namespace}:default`;
  } else {
    const digest = crypto.createHash('sha256').update(JSON.stringify([namespace, canonicalRoots])).digest('hex').slice(0, 12);
    sourceId = `${namespace}:acct:${digest}`;
  }

  const compatLegacySources = DEFAULT_LEGACY_SOURCES[sourceId] ? [...DEFAULT_LEGACY_SOURCES[sourceId]] : [];
  return { namespace, sourceId, isDefault, roots, compatLegacySources };
}

function encodeOffsetCursor(offset) {
  const safeOffset = Math.max(0, Math.floor(offset));
  return Buffer.from(JSON.stringify({ v: 1, offset: safeOffset }), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { ok: true, offset: 0 };
  }
  if (typeof cursor !== 'string' || cursor.length > 256) {
    return { ok: false, message: '分页游标格式无效' };
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded || decoded.v !== 1 || typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      return { ok: false, message: '分页游标内容无效' };
    }
    return { ok: true, offset: decoded.offset };
  } catch {
    return { ok: false, message: '分页游标解析失败' };
  }
}

function isZstdTranscript(filePath) {
  return filePath.toLowerCase().endsWith('.zst');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new HistoryReadCancelledError(
      typeof signal.reason === 'string' && signal.reason ? signal.reason : '历史读取已取消',
    );
  }
}

async function* streamJsonLinesAbortable(file, opts = {}, stats = undefined) {
  throwIfAborted(opts.signal);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
  const rawStream = fs.createReadStream(file);
  rawStream.on('error', () => {});
  const compressed = isZstdTranscript(file);
  const decodedStream = compressed ? rawStream.pipe(createZstdDecompress()) : rawStream;
  if (compressed) decodedStream.on('error', () => {});
  decodedStream.setEncoding('utf8');
  const lines = createInterface({ input: decodedStream, crlfDelay: Infinity });

  const localStats = stats ?? {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };

  const onAbort = () => {
    lines.close();
    if (compressed) decodedStream.destroy();
    rawStream.destroy();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let limitReached = false;
  try {
    for await (const line of lines) {
      throwIfAborted(opts.signal);
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (localStats.bytesRead + lineBytes > maxBytes) {
        localStats.truncatedByBytes = true;
        limitReached = true;
        break;
      }
      if (localStats.linesRead >= maxLines) {
        localStats.truncatedByLines = true;
        limitReached = true;
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
        localStats.corruptedLines += 1;
      }
    }
    throwIfAborted(opts.signal);
  } catch (err) {
    if (err instanceof HistoryReadCancelledError || opts.signal?.aborted) {
      throw new HistoryReadCancelledError(
        typeof opts.signal?.reason === 'string' && opts.signal.reason ? opts.signal.reason : '历史读取已取消',
      );
    }
    if (!limitReached) {
      localStats.corruptedLines += 1;
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    lines.close();
    if (compressed) decodedStream.destroy();
    rawStream.destroy();
  }
}

async function readFirstJsonlRecord(file, signal) {
  for await (const row of streamJsonLinesAbortable(file, { maxBytes: 1024 * 1024, maxLines: 16, signal })) {
    return row;
  }
  return undefined;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((item) =>
      item && typeof item === 'object' && (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('\n');
}

async function readJsonlTranscriptAbortable(sourcePath, harnessKind, opts = {}) {
  throwIfAborted(opts.signal);
  let fileLockedWarning = false;
  try {
    const st = fs.statSync(sourcePath);
    if (Date.now() - st.mtimeMs < 5_000) fileLockedWarning = true;
  } catch {}

  const stats = {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };
  const messages = [];
  const positions = new Map();
  const eventMessages = [];

  for await (const row of streamJsonLinesAbortable(sourcePath, opts, stats)) {
    const timestamp = Date.parse(String(row.timestamp)) || undefined;

    if (harnessKind === 'custom') {
      const role = row.role === 'user' || row.role === 'assistant' ? row.role : undefined;
      const text = typeof row.text === 'string' ? row.text : extractMessageText(row.message?.content ?? row.content);
      if (role && text.trim()) messages.push({ role, text, timestamp });
      continue;
    }

    if (harnessKind === 'codex' && row.type === 'event_msg') {
      const role = row.payload?.type === 'user_message' ? 'user' : row.payload?.type === 'agent_message' ? 'assistant' : undefined;
      if (role && typeof row.payload?.message === 'string' && row.payload.message.trim()) {
        eventMessages.push({ role, text: row.payload.message, timestamp });
      }
    }

    const message = harnessKind === 'codex'
      ? (row.type === 'response_item' && row.payload?.type === 'message' ? row.payload : undefined)
      : (row.type === 'user' || row.type === 'assistant') && !row.isMeta && !row.isSidechain && !row.isCompactSummary
        ? row.message
        : undefined;

    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = extractMessageText(message.content);
    if (harnessKind === 'codex' && role === 'user' && Array.isArray(message.content)) {
      text = extractMessageText(
        message.content.filter((block) =>
          typeof block?.text !== 'string' || !/^(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions)/.test(block.text.trim()),
        ),
      );
    }
    if (!text.trim()) continue;
    const key = typeof message.id === 'string' ? message.id : undefined;
    const position = key ? positions.get(key) : undefined;
    if (position === undefined) {
      if (key) positions.set(key, messages.length);
      messages.push({ role, text, timestamp });
    } else if (text.startsWith(messages[position].text)) {
      messages[position].text = text;
    } else if (text !== messages[position].text) {
      messages[position].text += `\n\n${text}`;
    }
  }

  const finalMessages =
    harnessKind === 'codex' && !messages.some((m) => m.role === 'user') && eventMessages.length > 0
      ? eventMessages
      : messages;

  const partial = stats.truncatedByBytes || stats.truncatedByLines || stats.corruptedLines > 0;
  const truncatedReason = stats.truncatedByBytes
    ? 'max_bytes'
    : stats.truncatedByLines
      ? 'max_lines'
      : stats.corruptedLines > 0
        ? 'corrupted_trailing_line'
        : undefined;

  return { messages: finalMessages, partial, bytesRead: stats.bytesRead, linesRead: stats.linesRead, truncatedReason, fileLockedWarning };
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function collectFiles(dir, depth, nameMatches) {
  const files = [];
  const walk = (root, remaining) => {
    for (const ent of safeReaddir(root)) {
      const file = path.join(root, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory() && remaining > 0) walk(file, remaining - 1);
      else if (ent.isFile() && nameMatches(ent.name)) {
        try {
          const st = fs.statSync(file);
          files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  };
  walk(dir, depth);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function mapWithConcurrency(items, concurrency, signal, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new HistoryReadCancelledError(typeof signal.reason === 'string' ? signal.reason : '操作已取消');
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const count = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

function sameCanonicalPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinCanonicalRoot(rootReal, candidateReal) {
  const rel = path.relative(
    process.platform === 'win32' ? rootReal.toLowerCase() : rootReal,
    process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal,
  );
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSafeAgyPath(root, segments, expectKind) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
    if (!fs.statSync(rootReal).isDirectory()) return { ok: false, reason: 'root_missing' };
  } catch {
    return { ok: false, reason: 'root_missing' };
  }
  let current = rootReal;
  let info;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) {
      return { ok: false, reason: 'reparse_or_escape_blocked' };
    }
    current = path.join(current, seg);
    try { info = fs.lstatSync(current); } catch { return { ok: false, reason: 'missing' }; }
    const expectFile = expectKind === 'file' && i === segments.length - 1;
    if (info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return { ok: false, reason: 'reparse_or_escape_blocked' };
    }
  }
  if (!info) return { ok: false, reason: 'missing' };
  try {
    const resolved = fs.realpathSync(current);
    if (!sameCanonicalPath(resolved, current) || !isWithinCanonicalRoot(rootReal, resolved)) {
      return { ok: false, reason: 'reparse_or_escape_blocked' };
    }
    return { ok: true, path: resolved, size: info.size };
  } catch {
    return { ok: false, reason: 'reparse_or_escape_blocked' };
  }
}

async function openAgyReadOnlySqlite(dbPath, reader, maxDbBytes = DEFAULT_MAX_AGY_SQLITE_BYTES) {
  let stat;
  try {
    stat = fs.lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'db_missing' };
  } catch {
    return { ok: false, reason: 'db_missing' };
  }
  if (stat.size > maxDbBytes) return { ok: false, reason: 'db_too_large' };
  const { DatabaseSync } = await import('node:sqlite');
  const hasWal = fs.existsSync(`${dbPath}-wal`);
  const hasShm = fs.existsSync(`${dbPath}-shm`);
  const target = hasWal && hasShm ? dbPath : `${pathToFileURL(dbPath).href}?immutable=1`;

  for (let attempt = 0; attempt < 3; attempt++) {
    let db;
    try {
      db = new DatabaseSync(target, { readOnly: true });
      return { ok: true, value: reader(db) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SQLITE_BUSY|database is locked/i.test(msg) && attempt < 2) {
        const waitUntil = Date.now() + 10 * (attempt + 1);
        while (Date.now() < waitUntil) {}
        continue;
      }
      return { ok: false, reason: 'sqlite_unreadable', message: msg };
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return { ok: false, reason: 'sqlite_unreadable', message: 'SQLite unavailable' };
}

function isCodexRolloutName(name, id) {
  const isPlain = name.endsWith('.jsonl');
  const isZst = name.endsWith('.jsonl.zst');
  if (!isPlain && !isZst) return false;
  if (!id) return true;
  return name.endsWith(`-${id}.jsonl`) || name.endsWith(`-${id}.jsonl.zst`) || name === `${id}.jsonl` || name === `${id}.jsonl.zst`;
}

function workspaceHintFromCwd(cwd) {
  if (!cwd || !cwd.trim()) return undefined;
  const trimmed = cwd.trim();
  return { cwd: trimmed, label: path.basename(trimmed) || trimmed };
}

function verifyExistingRoot(root) {
  try {
    const realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) return { ok: false };
    return { ok: true, realRoot };
  } catch {
    return { ok: false };
  }
}

function verifyExplicitRoots(roots, config) {
  const hasExplicit = Boolean(
    (typeof config?.rootDir === 'string' && config.rootDir.trim()) ||
    (Array.isArray(config?.homes) && config.homes.some((h) => typeof h === 'string' && h.trim())),
  );
  if (!hasExplicit) return;
  if (!roots.some((r) => verifyExistingRoot(r).ok)) {
    throw new Error(`配置的来源根目录不存在或不可访问: ${roots.join(', ')}`);
  }
}

function matchesWorkspaceFilter(summary, workspaceId, workspaceCwd, recordWorkspaceId) {
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

function matchesDiscoverFilters(entry, req) {
  const { summary } = entry;
  if (req.harnessKind && summary.harnessKind !== req.harnessKind) return false;
  if (req.source && summary.legacySource !== req.source && summary.ref.sourceId !== req.source) return false;
  if (typeof req.fromTs === 'number' && summary.updatedAt < req.fromTs) return false;
  if (typeof req.toTs === 'number' && summary.updatedAt > req.toTs) return false;
  if (!matchesWorkspaceFilter(summary, req.workspaceId, req.workspaceCwd, entry.workspaceId)) return false;
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

function paginateItems(allMessages, offset, limit, pageMaxBytes) {
  const items = [];
  let pageBytes = 0;
  let nextIndex = offset;
  while (nextIndex < allMessages.length && items.length < limit) {
    const msg = allMessages[nextIndex];
    const item = {
      itemId: `message-${nextIndex + 1}`,
      role: msg.role,
      text: msg.text,
      ...(typeof msg.timestamp === 'number' ? { timestamp: msg.timestamp } : {}),
    };
    const itemBytes = Buffer.byteLength(item.text, 'utf8') + 128;
    if (items.length > 0 && pageBytes + itemBytes > pageMaxBytes) break;
    items.push(item);
    pageBytes += itemBytes;
    nextIndex += 1;
  }
  const nextCursor = nextIndex < allMessages.length ? encodeOffsetCursor(nextIndex) : null;
  return { items, nextCursor };
}

export function createHistorySourceInstance({ instanceId, pluginId, namespace, config = {}, packageRoot }) {
  let currentConfig = config;
  const fallbackCustomRoot = namespace === 'custom' && packageRoot ? path.join(packageRoot, 'samples') : undefined;
  let identity = resolveIdentity(namespace, currentConfig, fallbackCustomRoot);

  const scanCache = new Map();
  const inFlight = new Map();
  const instanceController = new AbortController();
  let disposed = false;
  let opCounter = 0;
  let lastError = null;

  function toSummary(params) {
    const workspaceHint = params.cwd
      ? workspaceHintFromCwd(params.cwd)
      : (params.workspaceLabel ? { label: params.workspaceLabel } : undefined);
    return {
      ref: {
        sourceInstanceId: instanceId,
        sourceId: identity.sourceId,
        nativeSessionId: params.nativeSessionId,
      },
      title: params.title,
      harnessKind: params.harnessKind,
      updatedAt: params.updatedAt,
      ...(workspaceHint ? { workspaceHint } : {}),
      ...(params.legacySource ? { legacySource: params.legacySource } : {}),
      ...(identity.compatLegacySources.length > 0 ? { compatLegacySources: [...identity.compatLegacySources] } : {}),
      ...(params.sourcePath ? { sourcePath: params.sourcePath } : {}),
    };
  }

  function registerOp(operationId) {
    const opId = operationId?.trim() || `op_${++opCounter}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort(instanceController.signal.reason ?? '来源实例已停用');
    if (instanceController.signal.aborted) onAbort();
    else instanceController.signal.addEventListener('abort', onAbort, { once: true });
    inFlight.set(opId, controller);
    return {
      opId,
      signal: controller.signal,
      cleanup: () => {
        instanceController.signal.removeEventListener('abort', onAbort);
        if (inFlight.get(opId) === controller) inFlight.delete(opId);
      },
    };
  }

  async function scanCodex(maxFiles, signal) {
    const names = new Map();
    const files = [];
    for (const root of identity.roots) {
      throwIfAborted(signal);
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;
      try {
        const indexFile = path.join(verified.realRoot, 'session_index.jsonl');
        if (fs.existsSync(indexFile)) {
          for await (const row of streamJsonLinesAbortable(indexFile, { signal })) {
            if (typeof row.id === 'string' && typeof row.thread_name === 'string') names.set(row.id, row.thread_name);
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
      }
      for (const sub of ['sessions', 'archived_sessions']) {
        files.push(...collectFiles(path.join(verified.realRoot, sub), 3, (name) => isCodexRolloutName(name)));
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidateWindow = files.slice(0, maxFiles);
    const originSet = Array.isArray(currentConfig?.origins) && currentConfig.origins.length ? new Set(currentConfig.origins) : undefined;

    const parsed = await mapWithConcurrency(candidateWindow, SCAN_CONCURRENCY, signal, async ({ file, mtimeMs, size }) => {
      const cached = scanCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.summary ? { summary: cached.summary, sourcePath: cached.sourcePath } : null;
      }
      try {
        const meta = await readFirstJsonlRecord(file, signal);
        const payload = meta?.type === 'session_meta' && meta.payload && typeof meta.payload === 'object' ? meta.payload : undefined;
        const nativeSessionId = payload?.id ?? meta?.id;
        if (typeof nativeSessionId !== 'string' || !nativeSessionId) {
          scanCache.set(file, { mtimeMs, size, summary: null, sourcePath: file });
          return null;
        }
        const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
        const origin = String(payload?.originator ?? '').toLowerCase();
        const desktop = origin.startsWith('codex desktop') || origin === 'codex app' || origin === 'codex_vscode' || payload?.source === 'vscode';
        const legacySource = desktop ? 'codex_desktop' : 'codex_cli';
        const summary = toSummary({
          nativeSessionId,
          title: names.get(nativeSessionId) || `Codex · ${path.basename(cwd || nativeSessionId)}`,
          harnessKind: currentConfig?.harnessKind ?? 'codex',
          updatedAt: Math.floor(mtimeMs),
          cwd,
          legacySource,
          sourcePath: file,
        });
        scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
        return { summary, sourcePath: file };
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
        return null;
      }
    });

    const deduped = new Map();
    for (const item of parsed) {
      if (!item) continue;
      if (originSet && item.summary.legacySource && !originSet.has(item.summary.legacySource)) continue;
      const id = item.summary.ref.nativeSessionId;
      if (deduped.has(id)) continue;
      const latestTitle = names.get(id);
      deduped.set(id, { summary: latestTitle ? { ...item.summary, title: latestTitle } : item.summary, sourcePath: item.sourcePath });
    }
    return [...deduped.values()];
  }

  async function scanClaude(maxFiles, signal) {
    const index = new Map();
    const files = [];
    for (const root of identity.roots) {
      throwIfAborted(signal);
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;
      try {
        const historyFile = path.join(verified.realRoot, 'history.jsonl');
        if (fs.existsSync(historyFile)) {
          for await (const row of streamJsonLinesAbortable(historyFile, { signal })) {
            if (typeof row.sessionId === 'string') index.set(row.sessionId, row);
          }
        }
      } catch (err) {
        if (err instanceof HistoryReadCancelledError) throw err;
      }
      files.push(...collectFiles(path.join(verified.realRoot, 'projects'), 1, (name) => /^[\da-f-]{36}\.jsonl$/i.test(name)));
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const parsed = await mapWithConcurrency(files.slice(0, maxFiles), SCAN_CONCURRENCY, signal, async ({ file, mtimeMs, size }) => {
      const cached = scanCache.get(file);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.summary) {
        return { summary: cached.summary, sourcePath: cached.sourcePath };
      }
      const nativeSessionId = path.basename(file, '.jsonl');
      const row = index.get(nativeSessionId);
      let cwd = typeof row?.project === 'string' ? row.project : null;
      if (!cwd) {
        try {
          for await (const item of streamJsonLinesAbortable(file, { maxBytes: 512 * 1024, maxLines: 50, signal })) {
            if (typeof item.cwd === 'string') { cwd = item.cwd; break; }
          }
        } catch (err) {
          if (err instanceof HistoryReadCancelledError) throw err;
          return null;
        }
      }
      const summary = toSummary({
        nativeSessionId,
        title: (String(row?.display || '') || `Claude · ${path.basename(cwd || nativeSessionId)}`).slice(0, 100),
        harnessKind: currentConfig?.harnessKind ?? 'claude',
        updatedAt: Math.floor(mtimeMs),
        cwd,
        legacySource: 'claude_cli',
        sourcePath: file,
      });
      scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
      return { summary, sourcePath: file };
    });
    const deduped = new Map();
    for (const item of parsed) {
      if (item && !deduped.has(item.summary.ref.nativeSessionId)) deduped.set(item.summary.ref.nativeSessionId, item);
    }
    return [...deduped.values()];
  }

  async function scanAgy(maxFiles, signal) {
    const legacySource = namespace === 'agy_desktop' ? 'agy_desktop' : 'agy_cli';
    const found = new Map();
    for (const root of identity.roots) {
      throwIfAborted(signal);
      const resolvedDb = resolveSafeAgyPath(root, ['conversation_summaries.db'], 'file');
      if (resolvedDb.ok) {
        const opened = await openAgyReadOnlySqlite(
          resolvedDb.path,
          (db) =>
            db.prepare(
              `SELECT conversation_id, title, workspace_uris, last_modified_time
               FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`,
            ).all(maxFiles),
          currentConfig?.maxAgyDbBytes,
        );
        if (!opened.ok) {
          throw new Error(`无法只读打开 AGY 摘要数据库 (${opened.reason}${opened.message ? `: ${opened.message}` : ''})`);
        }
        for (const row of opened.value) {
          throwIfAborted(signal);
          if (typeof row.conversation_id !== 'string' || !/^[\da-f-]{36}$/i.test(row.conversation_id)) continue;
          let cwd = null;
          try {
            const uris = JSON.parse(String(row.workspace_uris));
            if (Array.isArray(uris)) {
              for (const uri of uris) {
                if (typeof uri === 'string' && uri.startsWith('file:')) { cwd = fileURLToPath(uri); break; }
              }
            }
          } catch {}
          found.set(row.conversation_id, {
            summary: toSummary({
              nativeSessionId: row.conversation_id,
              title: String(row.title || `AGY · ${row.conversation_id.slice(0, 12)}`),
              harnessKind: currentConfig?.harnessKind ?? 'agy',
              updatedAt: Date.parse(String(row.last_modified_time)) || 0,
              cwd,
              legacySource,
            }),
          });
        }
      } else if (resolvedDb.reason === 'reparse_or_escape_blocked') {
        throw new Error('拦截到越界或符号链接 AGY 摘要数据库');
      }

      const resolvedConv = resolveSafeAgyPath(root, ['conversations'], 'directory');
      if (resolvedConv.ok) {
        for (const { file, mtimeMs } of collectFiles(resolvedConv.path, 0, (name) => /^[\da-f-]{36}\.(db|pb)$/i.test(name))) {
          throwIfAborted(signal);
          if (found.size >= maxFiles) break;
          const nativeSessionId = path.basename(file, path.extname(file));
          if (found.has(nativeSessionId)) continue;
          found.set(nativeSessionId, {
            summary: toSummary({
              nativeSessionId,
              title: `AGY · ${nativeSessionId.slice(0, 12)}`,
              harnessKind: currentConfig?.harnessKind ?? 'agy',
              updatedAt: Math.floor(mtimeMs),
              cwd: null,
              legacySource,
              sourcePath: file,
            }),
            sourcePath: file,
          });
        }
      }
    }
    return [...found.values()];
  }

  async function scanCustom(signal) {
    const out = [];
    if (Array.isArray(currentConfig?.records)) {
      for (const rec of currentConfig.records) {
        throwIfAborted(signal);
        if (!rec || typeof rec.nativeSessionId !== 'string' || !rec.nativeSessionId.trim()) continue;
        out.push({
          workspaceId: rec.workspaceId,
          summary: toSummary({
            nativeSessionId: rec.nativeSessionId.trim(),
            title: rec.title || `Custom · ${rec.nativeSessionId.slice(0, 12)}`,
            harnessKind: rec.harnessKind ?? currentConfig?.harnessKind ?? 'custom',
            updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
            cwd: rec.cwd,
            workspaceLabel: rec.workspaceLabel,
            legacySource: 'custom',
          }),
        });
      }
      return out;
    }

    for (const root of identity.roots) {
      throwIfAborted(signal);
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;
      for (const { file, mtimeMs, size } of collectFiles(verified.realRoot, 2, (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))) {
        throwIfAborted(signal);
        const cached = scanCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size && cached.summary) {
          out.push({ summary: cached.summary, sourcePath: file });
          continue;
        }
        try {
          const meta = await readFirstJsonlRecord(file, signal);
          const payload = meta?.type === 'session_meta' && meta.payload && typeof meta.payload === 'object' ? meta.payload : meta;
          const nativeSessionId = typeof payload?.nativeSessionId === 'string'
            ? payload.nativeSessionId
            : typeof payload?.id === 'string'
              ? payload.id
              : path.basename(file).replace(/\.jsonl(?:\.zst)?$/i, '');
          const summary = toSummary({
            nativeSessionId,
            title: typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : `Custom · ${nativeSessionId}`,
            harnessKind: typeof payload?.harnessKind === 'string' ? payload.harnessKind : (currentConfig?.harnessKind ?? 'custom'),
            updatedAt: typeof payload?.updatedAt === 'number' ? payload.updatedAt : Math.floor(mtimeMs),
            cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
            workspaceLabel: typeof payload?.workspaceLabel === 'string' ? payload.workspaceLabel : undefined,
            legacySource: 'custom',
            sourcePath: file,
          });
          scanCache.set(file, { mtimeMs, size, summary, sourcePath: file });
          out.push({ summary, sourcePath: file, workspaceId: typeof payload?.workspaceId === 'string' ? payload.workspaceId : undefined });
        } catch (err) {
          if (err instanceof HistoryReadCancelledError) throw err;
        }
      }
    }
    return out;
  }

  function findFileForSession(nativeSessionId) {
    for (const entry of scanCache.values()) {
      if (entry.summary?.ref.nativeSessionId === nativeSessionId && entry.sourcePath) return entry.sourcePath;
    }
    for (const root of identity.roots) {
      const verified = verifyExistingRoot(root);
      if (!verified.ok) continue;
      if (namespace === 'codex') {
        for (const sub of ['sessions', 'archived_sessions']) {
          const matches = collectFiles(path.join(verified.realRoot, sub), 3, (name) => isCodexRolloutName(name, nativeSessionId));
          if (matches[0]) return matches[0].file;
        }
      } else if (namespace === 'claude') {
        const matches = collectFiles(path.join(verified.realRoot, 'projects'), 1, (name) => name === `${nativeSessionId}.jsonl`);
        if (matches[0]) return matches[0].file;
      } else if (namespace === 'custom') {
        const matches = collectFiles(verified.realRoot, 2, (name) => name === `${nativeSessionId}.jsonl` || name === `${nativeSessionId}.jsonl.zst`);
        if (matches[0]) return matches[0].file;
      }
    }
    return undefined;
  }

  async function readFullTranscript(nativeSessionId, signal) {
    if (namespace === 'agy_cli' || namespace === 'agy_desktop') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(nativeSessionId)) {
        return { ok: false, code: 'invalid_request', message: `非法的 AGY 会话 ID: ${nativeSessionId}` };
      }
      if (identity.roots.length === 0) {
        return { ok: false, code: 'source_unreadable', message: '未配置 AGY 来源根目录' };
      }
      const maxMessages = Math.max(1, currentConfig?.maxAgyMessages ?? DEFAULT_MAX_AGY_HISTORY_MESSAGES);
      const maxTotalBytes = Math.max(256, currentConfig?.maxAgyBytes ?? DEFAULT_MAX_AGY_HISTORY_BYTES);
      const maxDbBytes = Math.max(1024, currentConfig?.maxAgyDbBytes ?? DEFAULT_MAX_AGY_SQLITE_BYTES);

      let lastFailure = { code: 'source_unreadable', message: '找不到对应的 AGY 原生会话记录' };
      for (const root of identity.roots) {
        throwIfAborted(signal);
        const resolved = resolveSafeAgyPath(root, ['conversation_summaries.db'], 'file');
        if (!resolved.ok) {
          lastFailure = { code: 'source_unreadable', message: `AGY 会话不可读 (${resolved.reason})` };
          continue;
        }
        const opened = await openAgyReadOnlySqlite(
          resolved.path,
          (db) => {
            const messages = new Map();
            let totalBytes = 0;
            let truncatedReason;
            const rows = db.prepare(
              `SELECT user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets
               FROM conversations_fts WHERE conversation_id = ? AND chunk_index >= 0 ORDER BY chunk_index`,
            ).iterate(nativeSessionId);
            for (const row of rows) {
              if (truncatedReason) break;
              for (const [role, body, offsets] of [
                ['user', row.user_body, row.user_step_byte_offsets],
                ['assistant', row.agent_body, row.agent_step_byte_offsets],
              ]) {
                if (truncatedReason) break;
                if (typeof body !== 'string' || !body || !offsets) continue;
                const bytes = Buffer.from(body, 'utf8');
                const offsetsText = typeof offsets === 'string'
                  ? offsets
                  : offsets instanceof Uint8Array ? Buffer.from(offsets).toString('utf8') : '';
                let positions;
                try { positions = JSON.parse(offsetsText); } catch { continue; }
                if (!Array.isArray(positions)) continue;
                for (let entry = 0; entry < positions.length; entry++) {
                  const position = positions[entry];
                  if (!Array.isArray(position)) continue;
                  const [index, start] = position;
                  const end = positions[entry + 1]?.[1] ?? bytes.length;
                  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(start)
                    || !Number.isSafeInteger(end) || start < 0 || start >= end || end > bytes.length) continue;
                  const text = bytes.subarray(start, end).toString('utf8').trim();
                  if (!text) continue;
                  const key = `${index}:${role}`;
                  const entryBytes = Buffer.byteLength(text, 'utf8');
                  if (!messages.has(key) && messages.size >= maxMessages) {
                    truncatedReason = 'max_messages';
                    break;
                  }
                  if (totalBytes + entryBytes > maxTotalBytes) {
                    truncatedReason = 'max_bytes';
                    break;
                  }
                  totalBytes += entryBytes;
                  messages.set(key, { index, role, text });
                }
              }
            }
            let hasSummary = false;
            if (messages.size === 0) {
              const s = db.prepare('SELECT 1 AS found FROM conversation_summaries WHERE conversation_id = ? LIMIT 1').get(nativeSessionId);
              hasSummary = s?.found === 1;
            }
            return {
              messages: [...messages.values()].sort((a, b) => a.index - b.index).map(({ role, text }) => ({ role, text })),
              truncatedReason,
              hasSummary,
            };
          },
          maxDbBytes,
        );
        if (!opened.ok) {
          lastFailure = { code: 'source_unreadable', message: `AGY 会话不可读 (${opened.reason})` };
          continue;
        }
        if (opened.value.messages.length === 0) {
          const pbPath = resolveSafeAgyPath(root, ['conversations', `${nativeSessionId}.pb`], 'file');
          const dbConvPath = resolveSafeAgyPath(root, ['conversations', `${nativeSessionId}.db`], 'file');
          if (opened.value.hasSummary || pbPath.ok || dbConvPath.ok) {
            return {
              ok: false,
              code: 'source_unreadable',
              message: '已发现 AGY 会话标题或 .pb 文件，但 conversation_summaries.db (conversations_fts) 缺少正文索引，只读来源无法解析正文',
            };
          }
          continue;
        }
        const partial = Boolean(opened.value.truncatedReason);
        const warnings = partial
          ? [opened.value.truncatedReason === 'max_messages' ? 'AGY 索引历史达到消息条数上限，已截断返回' : 'AGY 索引历史达到字节上限，已截断返回']
          : [];
        return { ok: true, messages: opened.value.messages, partial, warnings };
      }
      return { ok: false, ...lastFailure };
    }

    if (namespace === 'custom' && Array.isArray(currentConfig?.records)) {
      const rec = currentConfig.records.find((r) => r.nativeSessionId === nativeSessionId);
      if (!rec) return { ok: false, code: 'source_unreadable', message: `找不到自定义会话记录: ${nativeSessionId}` };
      return {
        ok: true,
        messages: rec.items.map((item) => ({ role: item.role, text: item.text, ...(typeof item.timestamp === 'number' ? { timestamp: item.timestamp } : {}) })),
        partial: false,
        warnings: [],
      };
    }

    let sourcePath = findFileForSession(nativeSessionId);
    if (!sourcePath && namespace === 'custom') {
      const entries = await scanCustom(signal);
      sourcePath = entries.find((e) => e.summary.ref.nativeSessionId === nativeSessionId)?.sourcePath;
    }
    if (!sourcePath) return { ok: false, code: 'source_unreadable', message: `找不到原生会话文件: ${nativeSessionId}` };

    try {
      const lst = fs.lstatSync(sourcePath);
      if (lst.isSymbolicLink() || !lst.isFile()) return { ok: false, code: 'source_unreadable', message: '原生会话路径不是普通文件（已拦截符号链接）' };
    } catch {
      return { ok: false, code: 'source_unreadable', message: `原生会话文件已移动或不可读: ${nativeSessionId}` };
    }

    const detailed = await readJsonlTranscriptAbortable(
      sourcePath,
      namespace === 'codex' ? 'codex' : namespace === 'claude' ? 'claude' : 'custom',
      {
        maxBytes: currentConfig?.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
        maxLines: currentConfig?.maxTranscriptLines ?? DEFAULT_MAX_TRANSCRIPT_LINES,
        signal,
      },
    );
    if (detailed.messages.length === 0) {
      return {
        ok: false,
        code: 'source_unreadable',
        message: detailed.partial ? '会话文件损坏或仅包含不可解析行，未读取到有效消息正文' : '会话记录存在但未包含可解析的用户/助手文本消息',
      };
    }
    const warnings = [];
    if (detailed.truncatedReason === 'max_bytes') warnings.push(`读取达到字节上限 (${detailed.bytesRead} B)，长历史已截断`);
    else if (detailed.truncatedReason === 'max_lines') warnings.push(`读取达到行数上限 (${detailed.linesRead} 行)，长历史已截断`);
    else if (detailed.truncatedReason === 'corrupted_trailing_line') warnings.push('检测到损坏行或半截尾行，已容错跳过并保留已解析消息');
    if (detailed.fileLockedWarning) warnings.push('检测到该原生会话文件最近 5 秒内有写入活动，可能存在外部 CLI 并发锁');
    return { ok: true, messages: detailed.messages, partial: detailed.partial, warnings, fileLockedWarning: detailed.fileLockedWarning };
  }

  return {
    get identity() {
      return identity;
    },
    updateConfig(nextConfig = {}) {
      currentConfig = nextConfig;
      identity = resolveIdentity(namespace, currentConfig, fallbackCustomRoot);
      scanCache.clear();
    },
    dispose() {
      disposed = true;
      const pending = [...inFlight.entries()];
      inFlight.clear();
      for (const [, controller] of pending) {
        if (!controller.signal.aborted) controller.abort('来源实例已停用');
      }
      if (!instanceController.signal.aborted) instanceController.abort('来源实例已停用');
      scanCache.clear();
    },
    async getStatus() {
      return ok({
        instanceId,
        pluginId,
        namespace,
        sourceId: identity.sourceId,
        isDefault: identity.isDefault,
        roots: [...identity.roots],
        compatLegacySources: [...identity.compatLegacySources],
        active: !disposed,
        inFlightOperations: inFlight.size,
        cacheEntries: scanCache.size,
        lastError,
      });
    },
    async cancel(req = {}) {
      const rawId = typeof req?.operationId === 'string' && req.operationId.trim()
        ? req.operationId.trim()
        : (typeof req?.requestId === 'string' && req.requestId.trim() ? req.requestId.trim() : undefined);
      if (rawId) {
        const controller = inFlight.get(rawId);
        if (!controller) return ok({ cancelled: false, operationId: rawId, abortedCount: 0 });
        controller.abort('用户或上级任务取消');
        inFlight.delete(rawId);
        return ok({ cancelled: true, operationId: rawId, abortedCount: 1 });
      }
      let abortedCount = 0;
      for (const [opId, controller] of [...inFlight.entries()]) {
        controller.abort('来源操作已批量取消');
        inFlight.delete(opId);
        abortedCount += 1;
      }
      return ok({ cancelled: abortedCount > 0, abortedCount });
    },
    async discover(req = {}) {
      if (disposed) return fail('cancelled', '来源实例已停用');
      if (req !== null && typeof req !== 'object') return fail('invalid_request', 'discover 请求参数无效');
      const cursorRes = decodeOffsetCursor(req.cursor);
      if (!cursorRes.ok) return fail('invalid_request', cursorRes.message);
      const offset = cursorRes.offset;
      const rawLimit = req.limit ?? 20;
      if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
        return fail('invalid_request', 'discover limit 必须为正整数');
      }
      const limit = Math.min(1000, Math.floor(rawLimit));
      if (typeof req.fromTs === 'number' && !Number.isFinite(req.fromTs)) return fail('invalid_request', 'fromTs 必须为有效时间戳');
      if (typeof req.toTs === 'number' && !Number.isFinite(req.toTs)) return fail('invalid_request', 'toTs 必须为有效时间戳');
      if (req.refresh) scanCache.clear();

      const op = registerOp(req.operationId);
      try {
        if (!Array.isArray(currentConfig?.records)) verifyExplicitRoots(identity.roots, currentConfig);
        const hasFilters = Boolean(req.query?.trim() || req.workspaceId || req.workspaceCwd || req.harnessKind || req.source || typeof req.fromTs === 'number' || typeof req.toTs === 'number');
        const scanBudget = currentConfig?.maxScanFiles ?? Math.max((offset + limit) * 4, hasFilters ? 400 : 120);
        let entries;
        if (namespace === 'codex') entries = await scanCodex(scanBudget, op.signal);
        else if (namespace === 'claude') entries = await scanClaude(scanBudget, op.signal);
        else if (namespace === 'agy_cli' || namespace === 'agy_desktop') entries = await scanAgy(scanBudget, op.signal);
        else entries = await scanCustom(op.signal);

        if (op.signal.aborted || disposed) return fail('cancelled', 'discover 操作已取消');
        const filtered = entries
          .filter((entry) => matchesDiscoverFilters(entry, req))
          .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.summary.ref.nativeSessionId.localeCompare(b.summary.ref.nativeSessionId));
        const page = filtered.slice(offset, offset + limit).map((e) => e.summary);
        const nextCursor = offset + page.length < filtered.length ? encodeOffsetCursor(offset + page.length) : null;
        lastError = null;
        return ok({ sessions: page, nextCursor });
      } catch (err) {
        if (err instanceof HistoryReadCancelledError || op.signal.aborted || disposed) {
          return fail('cancelled', err instanceof Error ? err.message : 'discover 操作已取消');
        }
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        return fail('source_unreadable', message);
      } finally {
        op.cleanup();
      }
    },
    async read(req) {
      if (disposed) return fail('cancelled', '来源实例已停用');
      if (!req || typeof req !== 'object' || !req.ref || typeof req.ref !== 'object') {
        return fail('invalid_request', '缺少有效的 ref 参数');
      }
      const { ref } = req;
      if (ref.sourceInstanceId !== instanceId) {
        return fail('invalid_request', `ref.sourceInstanceId (${ref.sourceInstanceId}) 与当前实例 (${instanceId}) 不匹配`);
      }
      if (ref.sourceId !== identity.sourceId) {
        return fail('invalid_request', `ref.sourceId (${ref.sourceId}) 与当前来源 (${identity.sourceId}) 不匹配`);
      }
      if (typeof ref.nativeSessionId !== 'string' || !ref.nativeSessionId.trim()) {
        return fail('invalid_request', 'ref.nativeSessionId 不能为空');
      }
      const cursorRes = decodeOffsetCursor(req.cursor);
      if (!cursorRes.ok) return fail('invalid_request', cursorRes.message);
      const offset = cursorRes.offset;
      const rawLimit = req.limit ?? 100;
      if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1) {
        return fail('invalid_request', 'read limit 必须为正整数');
      }
      const limit = Math.min(500, Math.floor(rawLimit));
      const pageMaxBytes = Math.max(4096, currentConfig?.pageMaxBytes ?? DEFAULT_PAGE_MAX_BYTES);

      const op = registerOp(req.operationId);
      try {
        const res = await readFullTranscript(ref.nativeSessionId.trim(), op.signal);
        if (op.signal.aborted || disposed) return fail('cancelled', 'read 操作已取消');
        if (!res.ok) {
          lastError = res.message;
          return fail(res.code, res.message);
        }
        const { items, nextCursor } = paginateItems(res.messages, offset, limit, pageMaxBytes);
        lastError = null;
        return ok({
          ref: { sourceInstanceId: instanceId, sourceId: identity.sourceId, nativeSessionId: ref.nativeSessionId.trim() },
          items,
          nextCursor,
          readStatus: res.partial ? 'partial' : 'complete',
          warnings: res.warnings,
          ...(res.fileLockedWarning ? { fileLockedWarning: true } : {}),
        });
      } catch (err) {
        if (err instanceof HistoryReadCancelledError || op.signal.aborted || disposed) {
          return fail('cancelled', err instanceof Error ? err.message : 'read 操作已取消');
        }
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        return fail('source_unreadable', message);
      } finally {
        op.cleanup();
      }
    },
  };
}

export function registerHistorySourcePlugin(ctx, config, descriptor) {
  const source = createHistorySourceInstance({
    instanceId: ctx.instanceId || ctx.pluginId,
    pluginId: ctx.pluginId,
    namespace: descriptor.namespace,
    config,
    packageRoot: descriptor.packageRoot,
  });

  ctx.effect(() => () => {
    source.dispose();
  });

  if (typeof ctx.onConfigUpdated === 'function') {
    ctx.onConfigUpdated((nextConfig) => {
      source.updateConfig(nextConfig);
    });
  }

  ctx.provide(
    'history.source.v1',
    {
      discover: (req) => source.discover(req),
      read: (req) => source.read(req),
      cancel: (req) => source.cancel(req),
      getStatus: () => source.getStatus(),
    },
    {
      version: '1.0.0',
      metadata: {
        title: descriptor.title,
        sourceNamespace: descriptor.namespace,
        harnessKind: descriptor.harnessKind,
        defaultSourceId: source.identity.sourceId,
        compatLegacySources: source.identity.compatLegacySources,
      },
    },
  );

  ctx.routes.register('/status', async (req) => {
    if (req.method !== 'GET') return { status: 405, body: fail('invalid_request', 'Method Not Allowed') };
    return { status: 200, body: await source.getStatus() };
  });

  ctx.routes.register('/discover', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: fail('invalid_request', 'Method Not Allowed') };
    return { status: 200, body: await source.discover(req.body ?? {}) };
  });

  ctx.routes.register('/read', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: fail('invalid_request', 'Method Not Allowed') };
    return { status: 200, body: await source.read(req.body) };
  });

  ctx.routes.register('/cancel', async (req) => {
    if (req.method !== 'POST') return { status: 405, body: fail('invalid_request', 'Method Not Allowed') };
    return { status: 200, body: await source.cancel(req.body ?? {}) };
  });
}
