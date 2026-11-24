import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ContextCompressionConfigSchema,
  type CanonicalEvent,
  type CompressedTurnChunk,
  type CompressionCacheStats,
  type ContextCompressionConfig,
  type FileSymbolEntry,
  type FileSymbolKind,
  type FileSymbolOutline,
  type ReferencedPathCheck,
  type SessionCompressionStatus,
  type SessionTaskState,
  type UpdateCompressionConfigRequest,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { NormalizedAdapterEvent } from '../harnesses/types.js';

export const CONTEXT_COMPRESSION_PLUGIN_ID = 'hm.plugin.context-compression';
export const MAX_SYMBOL_FILE_BYTES = 512 * 1024;
export const WORKSPACE_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const GLOBAL_CONFIG_SCOPE = '__global__';
const LRU_INDEX_KEY = 'lru:index';
const DAILY_USAGE_PREFIX = 'usage:daily:';
const SESSION_USAGE_PREFIX = 'usage:session:';

export class ContextCompressionError extends Error {
  constructor(
    readonly code: 'E_PLUGIN_DISABLED' | 'E_SESSION_NOT_FOUND' | 'E_INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ContextCompressionError';
  }
}

export interface CompressRangeOptions {
  forceRecompute?: boolean;
  forceLocal?: boolean;
  /** Offset added to 1-based turn index when displaying turn ranges from sub-slices. */
  turnNumberOffset?: number;
}

export interface CompressRangeResult {
  chunks: CompressedTurnChunk[];
  combinedMarkdown: string;
  totalOriginalChars: number;
  totalCompressedChars: number;
  compressionRatio: number;
  usedLlm: boolean;
  fallback: boolean;
  fallbackReason: string | null;
  llmCallsMade: number;
  cacheHits: number;
}

export interface SymbolOutlineResult {
  outlines: FileSymbolOutline[];
  markdown: string;
  skippedFiles: Array<{ path: string; reason: string }>;
  cacheHits: number;
  parsedCount: number;
}

export interface ContextCompressorProvider {
  isEnabled(): boolean;
  getConfig(): ContextCompressionConfig;
  compressRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    budgetChars: number,
    opts?: CompressRangeOptions,
  ): Promise<CompressRangeResult>;
  buildSymbolOutline(
    workspacePath: string,
    filePaths: string[],
    maxChars: number,
  ): Promise<SymbolOutlineResult>;
}

export interface LlmSummarizerRequest {
  instanceId: string;
  model: string | null;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type LlmSummarizerFn = (req: LlmSummarizerRequest) => Promise<string>;

export interface ContextCompressionHooks {
  isEnabled?: () => boolean;
  emitEvent?: (
    sessionId: string,
    type: 'compression.chunk_ready' | 'compression.fallback_triggered',
    payload: Record<string, unknown>,
  ) => CanonicalEvent | void;
  getTaskState?: (sessionId: string) => SessionTaskState | undefined;
}

export interface ContextCompressionServiceOptions {
  llmSummarizer?: LlmSummarizerFn;
  maxWorkspaceCacheBytes?: number;
  now?: () => number;
}

interface LruIndexEntry {
  key: string;
  bytes: number;
  accessedAt: number;
}

interface DailyUsageRecord {
  date: string;
  calls: number;
}

interface CompressionTurn {
  turnIndex: number;
  turnId: string;
  startSeq: number;
  endSeq: number;
  harnessId: string;
  userText: string;
  assistantText: string;
  tools: Array<{ toolName: string; summary: string; status: string }>;
  files: string[];
  errorMessage: string | null;
  rawChars: number;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.zst', '.7z', '.rar',
  '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.node',
  '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
]);

const KNOWN_PATH_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp',
  'json', 'jsonc', 'md', 'mdx', 'yml', 'yaml', 'toml', 'sql',
  'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'sh', 'ps1',
]);

function detectLanguage(filePath: string): FileSymbolOutline['language'] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  return 'other';
}

function resolveInsideWorkspace(
  workspacePath: string,
  rawPath: string,
): { abs: string; rel: string } | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.length > 512) return null;
  if (/^[a-z]+:\/\//i.test(trimmed)) return null;
  const root = path.resolve(workspacePath);
  const abs = path.resolve(root, trimmed);
  const normRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normAbs = process.platform === 'win32' ? abs.toLowerCase() : abs;
  if (normAbs !== normRoot && !normAbs.startsWith(normRoot + path.sep)) {
    return null;
  }
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return { abs, rel };
}

function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function checkBinaryFile(absPath: string, fileSize: number): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (fileSize === 0) return false;
  const sampleSize = Math.min(8192, fileSize);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(sampleSize);
    const bytesRead = fs.readSync(fd, buf, 0, sampleSize, 0);
    return isBinaryBuffer(buf.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pure zero-native-dependency regex symbol extractor for TS/JS, Python, Go, and Rust.
 */
export function extractFileSymbols(
  content: string,
  filePath: string,
): { language: FileSymbolOutline['language']; symbols: FileSymbolEntry[] } {
  const language = detectLanguage(filePath);
  const symbols: FileSymbolEntry[] = [];
  if (language === 'other' || !content) {
    return { language, symbols };
  }

  const lines = content.split(/\r?\n/);
  let inBlockComment = false;
  let pyClassStack: { indent: number; name: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (language === 'typescript' || language === 'javascript' || language === 'go' || language === 'rust') {
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) {
          inBlockComment = true;
        }
        continue;
      }
      if (trimmed.startsWith('//')) continue;
    }

    const indent = raw.length - raw.trimStart().length;

    if (language === 'typescript' || language === 'javascript') {
      const mExportDecl = raw.match(
        /^(export\s+(?:default\s+)?|declare\s+)?(abstract\s+)?(class|interface|type|enum|async\s+function\*?|function\*?)\s+([A-Za-z_$][\w$]*)/,
      );
      if (mExportDecl) {
        const exported = Boolean(mExportDecl[1]?.startsWith('export'));
        const kw = mExportDecl[3]!.replace(/^async\s+/, '').replace(/\*$/, '');
        const kind = kw as FileSymbolKind;
        symbols.push({ kind, name: mExportDecl[4]!, line: lineNum, exported });
        continue;
      }
      const mConst = raw.match(
        /^(export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\b(?:\s*:[^=]+)?\s*=\s*(.*)$/,
      );
      if (mConst) {
        const exported = Boolean(mConst[1]);
        const rhs = mConst[4]!.trim();
        const isFnValue =
          /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(rhs) ||
          /^(?:async\s+)?function\b/.test(rhs);
        if (exported || isFnValue || (indent === 0 && mConst[2] === 'const')) {
          symbols.push({
            kind: isFnValue ? 'function' : 'const',
            name: mConst[3]!,
            line: lineNum,
            exported,
          });
        }
      }
      continue;
    }

    if (language === 'python') {
      if (trimmed.startsWith('#')) continue;
      if (pyClassStack && indent <= pyClassStack.indent) {
        pyClassStack = null;
      }
      const mClass = raw.match(/^class\s+([A-Za-z_][\w]*)\b/);
      if (mClass) {
        const name = mClass[1]!;
        symbols.push({
          kind: 'class',
          name,
          line: lineNum,
          exported: !name.startsWith('_'),
        });
        pyClassStack = { indent, name };
        continue;
      }
      const mDef = raw.match(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
      if (mDef) {
        const defIndent = mDef[1]!.length;
        const fnName = mDef[2]!;
        if (defIndent === 0) {
          symbols.push({
            kind: 'def',
            name: fnName,
            line: lineNum,
            exported: !fnName.startsWith('_'),
          });
        } else if (pyClassStack && defIndent > pyClassStack.indent) {
          symbols.push({
            kind: 'def',
            name: `${pyClassStack.name}.${fnName}`,
            line: lineNum,
            exported: !pyClassStack.name.startsWith('_') && !fnName.startsWith('_'),
          });
        }
      }
      continue;
    }

    if (language === 'go') {
      const mType = raw.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface|[\w[\]*]+)/);
      if (mType) {
        const name = mType[1]!;
        const kind: FileSymbolKind =
          mType[2] === 'struct'
            ? 'struct'
            : mType[2] === 'interface'
              ? 'interface'
              : 'type';
        symbols.push({
          kind,
          name,
          line: lineNum,
          exported: /^[A-Z]/.test(name),
        });
        continue;
      }
      const mFunc = raw.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*(?:\[[^\]]+\]\s*)?\(/);
      if (mFunc) {
        const name = mFunc[1]!;
        symbols.push({
          kind: 'function',
          name,
          line: lineNum,
          exported: /^[A-Z]/.test(name),
        });
        continue;
      }
      const mConst = raw.match(/^(?:const|var)\s+([A-Z][\w]*)\b/);
      if (mConst) {
        symbols.push({
          kind: 'const',
          name: mConst[1]!,
          line: lineNum,
          exported: true,
        });
      }
      continue;
    }

    if (language === 'rust') {
      const mRsItem = raw.match(
        /^(pub(?:\s*\([^)]+\))?\s+)?(?:async\s+|unsafe\s+)?(struct|enum|trait|impl|fn|type|mod|const)\s+(?:<[^>]+>\s+)?([A-Za-z_][\w]*)/,
      );
      if (mRsItem) {
        const exported = Boolean(mRsItem[1]);
        const kw = mRsItem[2]!;
        let name = mRsItem[3]!;
        let kind: FileSymbolKind = kw === 'fn' ? 'function' : (kw as FileSymbolKind);
        if (kw === 'impl') {
          const forMatch = raw.match(/^impl(?:<[^>]+>)?\s+[\w:]+\s+for\s+([A-Za-z_][\w]*)/);
          if (forMatch?.[1]) {
            name = `${name} for ${forMatch[1]}`;
          }
          kind = 'impl';
        }
        symbols.push({ kind, name, line: lineNum, exported });
      }
    }
  }

  return { language, symbols };
}

/**
 * Checks every file path mentioned in a summary against actual workspace files on disk.
 * Missing paths are flagged in `referencedPaths` and annotated with `[已删除/已重命名]`.
 */
export function validateReferencedPaths(
  summaryMarkdown: string,
  workspacePath: string,
): { markdown: string; referencedPaths: ReferencedPathCheck[] } {
  if (!summaryMarkdown || !workspacePath) {
    return { markdown: summaryMarkdown, referencedPaths: [] };
  }

  const candidates = new Set<string>();
  const backtickRegex = /`([^`\r\n]{1,220})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickRegex.exec(summaryMarkdown)) !== null) {
    const raw = match[1]!.trim();
    const cleaned = extractCandidatePath(raw);
    if (cleaned) candidates.add(cleaned);
  }

  const slashPathRegex = /(?:^|[\s(,:：，、（])((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[a-zA-Z0-9]{1,8})(?=[\s),:;\]`.。，；）]|$)/g;
  while ((match = slashPathRegex.exec(summaryMarkdown)) !== null) {
    const cleaned = extractCandidatePath(match[1]!);
    if (cleaned) candidates.add(cleaned);
  }

  const referencedPaths: ReferencedPathCheck[] = [];
  const missingPaths: string[] = [];

  for (const cand of [...candidates].sort()) {
    const resolved = resolveInsideWorkspace(workspacePath, cand);
    let existsAtCheck = false;
    if (resolved) {
      try {
        existsAtCheck = fs.existsSync(resolved.abs);
      } catch {
        existsAtCheck = false;
      }
    }
    referencedPaths.push({ path: cand, existsAtCheck });
    if (!existsAtCheck) {
      missingPaths.push(cand);
    }
  }

  let annotated = summaryMarkdown;
  for (const missing of missingPaths) {
    const escaped = missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(\`(?:\\./)?${escaped}\`|(?<![\\w/.-])(?:\\./)?${escaped})(?!\\s*\\[已删除\\/已重命名\\])`,
      'g',
    );
    annotated = annotated.replace(pattern, '$1 [已删除/已重命名]');
  }

  return { markdown: annotated, referencedPaths };
}

function extractCandidatePath(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '');
  if (!cleaned || cleaned.includes('..') || cleaned.includes('://') || cleaned.startsWith('/')) {
    return null;
  }
  const dotIdx = cleaned.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === cleaned.length - 1) return null;
  const ext = cleaned.slice(dotIdx + 1).toLowerCase();
  if (!KNOWN_PATH_EXTENSIONS.has(ext)) return null;
  if (!cleaned.includes('/') && /^\d/.test(cleaned)) return null;
  return cleaned;
}

function compactText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  if (maxLen <= 3) return clean.slice(0, maxLen);
  return `${clean.slice(0, maxLen - 1)}…`;
}

function collectTurnsForCompression(
  events: readonly CanonicalEvent[],
  fallbackHarnessId: string,
  turnOffset = 0,
): CompressionTurn[] {
  const order: string[] = [];
  const map = new Map<string, CompressionTurn>();
  const toolIdx = new Map<string, { turn: CompressionTurn; idx: number }>();

  const ensureTurn = (turnId: string, seq: number, harnessId?: string): CompressionTurn => {
    let t = map.get(turnId);
    if (!t) {
      t = {
        turnIndex: turnOffset + order.length + 1,
        turnId,
        startSeq: seq,
        endSeq: seq,
        harnessId: harnessId || fallbackHarnessId,
        userText: '',
        assistantText: '',
        tools: [],
        files: [],
        errorMessage: null,
        rawChars: 0,
      };
      map.set(turnId, t);
      order.push(turnId);
    }
    t.endSeq = Math.max(t.endSeq, seq);
    if (harnessId) t.harnessId = harnessId;
    return t;
  };

  for (const ev of events) {
    if (!ev.turnId || ev.payload.maintenance === true) continue;
    const p = ev.payload;
    const hId = typeof p.harnessId === 'string' && p.harnessId ? p.harnessId : undefined;
    const turn = ensureTurn(ev.turnId, ev.seq, hId);

    switch (ev.type) {
      case 'message.user': {
        const text = String(p.text ?? '');
        turn.userText = text;
        turn.rawChars += text.length;
        break;
      }
      case 'message.assistant.delta': {
        const text = String(p.text ?? '');
        turn.assistantText += text;
        turn.rawChars += text.length;
        break;
      }
      case 'message.assistant.completed': {
        const full = String(p.text ?? '');
        if (full.length >= turn.assistantText.length) {
          turn.rawChars += full.length - turn.assistantText.length;
          turn.assistantText = full;
        }
        break;
      }
      case 'tool.call.started': {
        const callId = String(p.toolCallId ?? `tool_${turn.tools.length}`);
        const summary = String(p.summary ?? '');
        const idx = turn.tools.length;
        turn.tools.push({
          toolName: String(p.toolName ?? 'tool'),
          summary,
          status: 'running',
        });
        toolIdx.set(callId, { turn, idx });
        const input = p.input;
        if (input && typeof input === 'object') {
          const obj = input as Record<string, unknown>;
          for (const key of ['path', 'file_path', 'filePath', 'file', 'target_file']) {
            if (typeof obj[key] === 'string') {
              const cand = extractCandidatePath(obj[key] as string);
              if (cand && !turn.files.includes(cand)) turn.files.push(cand);
            }
          }
        }
        break;
      }
      case 'tool.call.completed': {
        const callId = String(p.toolCallId ?? '');
        const hit = toolIdx.get(callId);
        const outputLen = typeof p.output === 'string' ? p.output.length : 0;
        const diffLen = typeof p.diff === 'string' ? p.diff.length : 0;
        turn.rawChars += outputLen + diffLen;
        if (hit) {
          hit.turn.tools[hit.idx]!.status = String(p.status ?? 'success');
        }
        if (typeof p.diff === 'string') {
          for (const line of p.diff.split(/\r?\n/)) {
            const m = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
            if (m?.[1] && m[1] !== '/dev/null') {
              const cand = extractCandidatePath(m[1]);
              if (cand && !turn.files.includes(cand)) turn.files.push(cand);
            }
          }
        }
        break;
      }
      case 'turn.failed': {
        turn.errorMessage = String(p.message ?? 'Turn failed');
        turn.rawChars += turn.errorMessage.length;
        break;
      }
      default:
        break;
    }
  }

  return order.map((id) => map.get(id)!);
}

function buildLocalChunkSummary(
  turns: readonly CompressionTurn[],
  budgetChars: number,
): string {
  if (turns.length === 0) return '';
  const first = turns[0]!;
  const last = turns[turns.length - 1]!;
  const harnesses = [...new Set(turns.map((t) => t.harnessId))];
  const touchedFiles = [...new Set(turns.flatMap((t) => t.files))];
  const errors = turns.filter((t) => t.errorMessage);
  const toolCounts = new Map<string, number>();
  for (const t of turns) {
    for (const tc of t.tools) {
      toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1);
    }
  }

  const lines: string[] = [
    `#### Turns ${first.turnIndex}–${last.turnIndex} (seq ${first.startSeq}–${last.endSeq}, ${harnesses.join('/')})`,
  ];

  const intentCount = Math.min(3, turns.length);
  const pickedIntents =
    turns.length <= 3
      ? turns
      : [turns[0]!, turns[Math.floor(turns.length / 2)]!, turns[turns.length - 1]!];
  const intentNotes = pickedIntents
    .slice(0, intentCount)
    .filter((t) => t.userText)
    .map((t) => `T${t.turnIndex}: ${compactText(t.userText, 72)}`);
  if (intentNotes.length > 0) {
    lines.push(`- **Intents**: ${intentNotes.join(' | ')}`);
  }

  if (touchedFiles.length > 0) {
    const filePreview = touchedFiles.slice(0, 8).map((f) => `\`${f}\``).join(', ');
    const more = touchedFiles.length > 8 ? ` (+${touchedFiles.length - 8})` : '';
    lines.push(`- **Files**: ${filePreview}${more}`);
  }

  if (toolCounts.size > 0) {
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}×${count}`)
      .join(', ');
    lines.push(`- **Tools**: ${topTools}`);
  }

  const recentConclusions = turns
    .slice(-2)
    .filter((t) => t.assistantText)
    .map((t) => `T${t.turnIndex}: ${compactText(t.assistantText, 120)}`);
  if (recentConclusions.length > 0) {
    lines.push(`- **Outcomes**: ${recentConclusions.join(' | ')}`);
  }

  if (errors.length > 0) {
    lines.push(
      `- **Errors (${errors.length})**: ${errors
        .slice(-2)
        .map((e) => `T${e.turnIndex}: ${compactText(e.errorMessage ?? '', 90)}`)
        .join(' | ')}`,
    );
  }

  const joined = lines.join('\n');
  if (joined.length <= budgetChars) return joined;
  return compactText(joined, Math.max(120, budgetChars));
}

export class ContextCompressionService implements ContextCompressorProvider {
  private hooks: ContextCompressionHooks = {};
  private enabled = false;
  private readonly maxWorkspaceBytes: number;
  private readonly now: () => number;
  private readonly memoryChunks = new Map<string, CompressedTurnChunk>();
  private readonly memorySymbols = new Map<string, FileSymbolOutline>();
  private readonly memoryLru = new Map<string, LruIndexEntry[]>();
  private readonly rollingSessions = new Set<string>();
  private readonly pendingRollupTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly options: ContextCompressionServiceOptions = {},
  ) {
    this.maxWorkspaceBytes = options.maxWorkspaceCacheBytes ?? WORKSPACE_CACHE_MAX_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  attachHooks(hooks: ContextCompressionHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
    if (hooks.isEnabled) {
      this.enabled = hooks.isEnabled();
    }
  }

  setPluginActive(active: boolean): void {
    this.enabled = active;
    if (!active) {
      this.onPluginDisabled();
    }
  }

  isEnabled(): boolean {
    if (this.hooks.isEnabled) {
      return this.hooks.isEnabled();
    }
    return this.enabled;
  }

  onPluginDisabled(): void {
    this.enabled = false;
    for (const timer of this.pendingRollupTimers) {
      clearTimeout(timer);
    }
    this.pendingRollupTimers.clear();
    this.rollingSessions.clear();
  }

  getConfig(): ContextCompressionConfig {
    const raw = this.store.getPluginStorageValue(
      GLOBAL_CONFIG_SCOPE,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      'config',
    );
    const parsed = ContextCompressionConfigSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : ContextCompressionConfigSchema.parse({});
  }

  updateConfig(patch: UpdateCompressionConfigRequest): ContextCompressionConfig {
    const current = this.getConfig();
    const next = ContextCompressionConfigSchema.parse({ ...current, ...patch });
    this.store.setPluginStorageValue(
      GLOBAL_CONFIG_SCOPE,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      'config',
      next,
    );
    return next;
  }

  private getTodayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private getDailyLlmCallsUsed(): number {
    const today = this.getTodayKey();
    const raw = this.store.getPluginStorageValue(
      GLOBAL_CONFIG_SCOPE,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      `${DAILY_USAGE_PREFIX}${today}`,
    ) as DailyUsageRecord | undefined;
    if (!raw || raw.date !== today || typeof raw.calls !== 'number') return 0;
    return raw.calls;
  }

  private incrementDailyLlmCalls(): void {
    const today = this.getTodayKey();
    const next = this.getDailyLlmCallsUsed() + 1;
    this.store.setPluginStorageValue(
      GLOBAL_CONFIG_SCOPE,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      `${DAILY_USAGE_PREFIX}${today}`,
      { date: today, calls: next } satisfies DailyUsageRecord,
    );
  }

  private getSessionTokensUsed(workspaceId: string, sessionId: string): number {
    const raw = this.store.getPluginStorageValue(
      workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      `${SESSION_USAGE_PREFIX}${sessionId}`,
    ) as { tokens?: number } | undefined;
    return typeof raw?.tokens === 'number' ? raw.tokens : 0;
  }

  private addSessionTokensUsed(workspaceId: string, sessionId: string, tokens: number): void {
    const current = this.getSessionTokensUsed(workspaceId, sessionId);
    this.store.setPluginStorageValue(
      workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      `${SESSION_USAGE_PREFIX}${sessionId}`,
      { tokens: current + Math.max(0, Math.round(tokens)) },
    );
  }

  private readLruIndex(workspaceId: string): LruIndexEntry[] {
    const cached = this.memoryLru.get(workspaceId);
    if (cached) return cached;
    const raw = this.store.getPluginStorageValue(
      workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      LRU_INDEX_KEY,
    );
    const list = Array.isArray(raw) ? (raw as LruIndexEntry[]) : [];
    this.memoryLru.set(workspaceId, list);
    return list;
  }

  private writeWorkspaceCachedValue(
    workspaceId: string,
    key: string,
    value: unknown,
  ): void {
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    this.store.setPluginStorageValue(workspaceId, CONTEXT_COMPRESSION_PLUGIN_ID, key, value);
    const ts = this.now();
    const entries = this.readLruIndex(workspaceId).filter((e) => e.key !== key);
    entries.push({ key, bytes: serializedBytes, accessedAt: ts });

    let totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    if (totalBytes > this.maxWorkspaceBytes) {
      entries.sort((a, b) => a.accessedAt - b.accessedAt);
      while (totalBytes > this.maxWorkspaceBytes && entries.length > 1) {
        const victim = entries.shift()!;
        totalBytes -= victim.bytes;
        this.store.deletePluginStorageValue(
          workspaceId,
          CONTEXT_COMPRESSION_PLUGIN_ID,
          victim.key,
        );
        this.memoryChunks.delete(`${workspaceId}::${victim.key}`);
        this.memorySymbols.delete(`${workspaceId}::${victim.key}`);
      }
    }

    this.memoryLru.set(workspaceId, entries);
    this.store.setPluginStorageValue(
      workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      LRU_INDEX_KEY,
      entries,
    );
  }

  private touchWorkspaceLruKey(workspaceId: string, key: string): void {
    const entries = this.readLruIndex(workspaceId);
    const target = entries.find((e) => e.key === key);
    if (!target) return;
    target.accessedAt = this.now();
  }

  private resolveWorkspaceScopeForPath(workspacePath: string): string {
    const resolved = path.resolve(workspacePath);
    const workspaces = this.store.listWorkspaces();
    const hit = workspaces.find((w) => path.resolve(w.rootPath) === resolved);
    if (hit) return hit.id;
    return `path:${createHash('sha256').update(resolved).digest('hex').slice(0, 16)}`;
  }

  async buildSymbolOutline(
    workspacePath: string,
    filePaths: string[],
    maxChars: number,
  ): Promise<SymbolOutlineResult> {
    const capChars = Math.max(200, maxChars);
    const workspaceScope = this.resolveWorkspaceScopeForPath(workspacePath);
    const outlines: FileSymbolOutline[] = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    let cacheHits = 0;
    let parsedCount = 0;

    const seenRel = new Set<string>();
    for (const rawPath of filePaths) {
      const resolved = resolveInsideWorkspace(workspacePath, rawPath);
      if (!resolved) {
        skippedFiles.push({ path: rawPath, reason: 'path_traversal_or_invalid' });
        continue;
      }
      if (seenRel.has(resolved.rel)) continue;
      seenRel.add(resolved.rel);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved.abs);
      } catch {
        skippedFiles.push({ path: resolved.rel, reason: 'not_found' });
        continue;
      }
      if (!stat.isFile()) {
        skippedFiles.push({ path: resolved.rel, reason: 'not_regular_file' });
        continue;
      }
      if (stat.size > MAX_SYMBOL_FILE_BYTES) {
        skippedFiles.push({ path: resolved.rel, reason: 'exceeds_512kb_limit' });
        continue;
      }

      try {
        if (checkBinaryFile(resolved.abs, stat.size)) {
          skippedFiles.push({ path: resolved.rel, reason: 'binary_file' });
          continue;
        }
      } catch {
        skippedFiles.push({ path: resolved.rel, reason: 'unreadable' });
        continue;
      }

      const key = `sym:${createHash('sha256').update(resolved.rel).digest('hex').slice(0, 20)}`;
      const memKey = `${workspaceScope}::${key}`;
      let outline = this.memorySymbols.get(memKey);
      if (!outline) {
        const stored = this.store.getPluginStorageValue(
          workspaceScope,
          CONTEXT_COMPRESSION_PLUGIN_ID,
          key,
        ) as FileSymbolOutline | undefined;
        if (stored && typeof stored.mtimeMs === 'number') {
          outline = stored;
          this.memorySymbols.set(memKey, stored);
        }
      }

      if (
        outline &&
        Math.abs(outline.mtimeMs - stat.mtimeMs) < 1e-3 &&
        outline.sizeBytes === stat.size
      ) {
        cacheHits++;
        this.touchWorkspaceLruKey(workspaceScope, key);
        outlines.push(outline);
        continue;
      }

      const content = fs.readFileSync(resolved.abs, 'utf8');
      const extracted = extractFileSymbols(content, resolved.rel);
      outline = {
        path: resolved.rel,
        language: extracted.language,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        symbols: extracted.symbols,
      };
      parsedCount++;
      this.memorySymbols.set(memKey, outline);
      this.writeWorkspaceCachedValue(workspaceScope, key, outline);
      outlines.push(outline);
    }

    const mdLines: string[] = [];
    if (outlines.some((o) => o.symbols.length > 0)) {
      mdLines.push('### Hot File Symbol Outlines');
      for (const fileOutline of outlines) {
        if (fileOutline.symbols.length === 0) continue;
        mdLines.push(`- \`${fileOutline.path}\` (${fileOutline.language}):`);
        for (const sym of fileOutline.symbols.slice(0, 24)) {
          const vis = sym.exported ? 'export ' : '';
          mdLines.push(`  - L${sym.line} \`${vis}${sym.kind} ${sym.name}\``);
        }
      }
    }

    let markdown = mdLines.join('\n');
    if (markdown.length > capChars) {
      markdown = `${markdown.slice(0, Math.max(0, capChars - 36))}\n... [symbol outline truncated]`;
      for (const o of outlines) {
        o.truncated = true;
      }
    }

    return { outlines, markdown, skippedFiles, cacheHits, parsedCount };
  }

  private async runDefaultAdapterSummarizer(req: LlmSummarizerRequest): Promise<string> {
    const adapter = this.registry.get(req.instanceId);
    if (!adapter) {
      throw new Error(`Summarizer adapter unavailable: ${req.instanceId}`);
    }
    const handle = await adapter.createSession({
      cwd: req.cwd,
      model: req.model,
      permissionMode: 'plan',
    });
    const turnId = `cmp_${randomUUID()}`;
    let buffer = '';
    let settled = false;

    try {
      return await new Promise<string>((resolve, reject) => {
        const cleanupAndReject = (err: Error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          req.signal.removeEventListener('abort', onAbort);
          reject(err);
        };

        const onAbort = () => {
          void handle.interrupt().catch(() => {});
          cleanupAndReject(new Error('LLM summarization aborted due to timeout'));
        };
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener('abort', onAbort, { once: true });

        const unsubscribe = handle.onEvent((ev: NormalizedAdapterEvent) => {
          if (ev.type === 'message.assistant.delta' && ev.turnId === turnId) {
            buffer += ev.text;
          } else if (ev.type === 'message.assistant.completed' && ev.turnId === turnId) {
            if (ev.text.length >= buffer.length) buffer = ev.text;
          } else if (ev.type === 'turn.completed' && ev.turnId === turnId) {
            if (settled) return;
            settled = true;
            unsubscribe();
            req.signal.removeEventListener('abort', onAbort);
            resolve(buffer.trim());
          } else if (ev.type === 'turn.failed' && ev.turnId === turnId) {
            cleanupAndReject(new Error(ev.message || 'Summarizer turn failed'));
          }
        });

        void handle
          .sendTurn({
            turnId,
            text: req.prompt,
            model: req.model,
            permissionMode: 'plan',
          })
          .catch((err: unknown) => {
            cleanupAndReject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  private async invokeLlmWithTimeout(
    req: Omit<LlmSummarizerRequest, 'signal'>,
  ): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`Summarizer timed out after ${req.timeoutMs}ms`), { isTimeout: true }));
      }, req.timeoutMs);
    });
    const fn =
      this.options.llmSummarizer ??
      ((r: LlmSummarizerRequest) => this.runDefaultAdapterSummarizer(r));

    try {
      return await Promise.race([
        fn({ ...req, signal: controller.signal }),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async compressRange(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    budgetChars: number,
    opts: CompressRangeOptions = {},
  ): Promise<CompressRangeResult> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new ContextCompressionError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }

    const config = this.getConfig();
    const startSeq = Math.max(0, Math.floor(fromSeq));
    const endSeq = Math.max(startSeq, Math.floor(toSeq));
    const totalBudget = Math.max(300, Math.floor(budgetChars));

    const rawEvents = [
      ...this.store.iterateEvents(sessionId, Math.max(0, startSeq - 1), endSeq),
    ].filter((ev) => ev.seq >= startSeq && ev.seq <= endSeq);

    const turns = collectTurnsForCompression(
      rawEvents,
      session.harnessId,
      opts.turnNumberOffset ?? 0,
    );

    if (turns.length === 0) {
      return {
        chunks: [],
        combinedMarkdown: '',
        totalOriginalChars: 0,
        totalCompressedChars: 0,
        compressionRatio: 1,
        usedLlm: false,
        fallback: false,
        fallbackReason: null,
        llmCallsMade: 0,
        cacheHits: 0,
      };
    }

    const turnGroups: CompressionTurn[][] = [];
    for (let i = 0; i < turns.length; i += config.chunkSizeTurns) {
      turnGroups.push(turns.slice(i, i + config.chunkSizeTurns));
    }

    const perChunkBudget = Math.max(240, Math.floor(totalBudget / turnGroups.length));
    const summarizerId = opts.forceLocal ? null : config.summarizerInstanceId;
    const modeTag = summarizerId
      ? `llm:${summarizerId}:${config.summarizerModel ?? ''}`
      : 'local:deterministic';

    const chunks: CompressedTurnChunk[] = [];
    let llmCallsMade = 0;
    let cacheHits = 0;
    let anyFallback = false;
    let lastFallbackReason: string | null = null;

    for (const group of turnGroups) {
      const chunkFromSeq = group[0]!.startSeq;
      const chunkToSeq = group[group.length - 1]!.endSeq;
      const fromTurn = group[0]!.turnIndex;
      const toTurn = group[group.length - 1]!.turnIndex;

      const canonicalInput = group.map((t) => ({
        id: t.turnId,
        s: t.startSeq,
        e: t.endSeq,
        u: t.userText,
        a: t.assistantText,
        f: t.files,
        err: t.errorMessage,
      }));
      const sourceItemsHash = createHash('sha256')
        .update(modeTag)
        .update('\0')
        .update(JSON.stringify(canonicalInput))
        .digest('hex')
        .slice(0, 24);

      const kvKey = `chunk:${sessionId}:${chunkFromSeq}:${chunkToSeq}:${sourceItemsHash}`;
      const memKey = `${session.workspaceId}::${kvKey}`;

      if (!opts.forceRecompute) {
        let cached = this.memoryChunks.get(memKey);
        if (!cached) {
          const fromKv = this.store.getPluginStorageValue(
            session.workspaceId,
            CONTEXT_COMPRESSION_PLUGIN_ID,
            kvKey,
          ) as CompressedTurnChunk | undefined;
          if (fromKv && fromKv.sourceItemsHash === sourceItemsHash) {
            cached = fromKv;
            this.memoryChunks.set(memKey, fromKv);
          }
        }
        if (cached) {
          cacheHits++;
          this.touchWorkspaceLruKey(session.workspaceId, kvKey);
          const fittedSummary =
            cached.summaryMarkdown.length > perChunkBudget
              ? compactText(cached.summaryMarkdown, perChunkBudget)
              : cached.summaryMarkdown;
          chunks.push({
            ...cached,
            summaryMarkdown: fittedSummary,
            compressedChars: fittedSummary.length,
            cacheHit: true,
          });
          continue;
        }
      }

      const originalChars = group.reduce((acc, t) => acc + Math.max(1, t.rawChars), 0);
      let rawSummary = '';
      let usedLlm = false;
      let fallback = false;
      let fallbackReason: string | null = null;

      if (summarizerId) {
        const estimatedPromptTokens = Math.ceil(originalChars / 4);
        const dailyUsed = this.getDailyLlmCallsUsed();
        const sessionTokensUsed = this.getSessionTokensUsed(session.workspaceId, sessionId);

        if (
          dailyUsed >= config.dailyCallLimit ||
          sessionTokensUsed + estimatedPromptTokens > config.sessionTokenBudgetCap
        ) {
          fallback = true;
          fallbackReason = 'budget_exceeded';
          anyFallback = true;
          lastFallbackReason = fallbackReason;
          this.hooks.emitEvent?.(sessionId, 'compression.fallback_triggered', {
            reason: fallbackReason,
            fromSeq: chunkFromSeq,
            toSeq: chunkToSeq,
            dailyUsed,
            dailyLimit: config.dailyCallLimit,
            sessionTokensUsed,
            sessionTokenBudgetCap: config.sessionTokenBudgetCap,
          });
        } else {
          const prompt = [
            `Summarize conversation turns ${fromTurn}..${toTurn} into <= ${perChunkBudget} chars.`,
            'Preserve key user goals, exact modified file paths, concrete decisions, and errors.',
            'Do NOT invent unverified file paths. Return compact Markdown bullets only.',
            '',
            ...group.map(
              (t) =>
                `[Turn ${t.turnIndex} (${t.harnessId})]\nUser: ${compactText(t.userText, 500)}\nFiles: ${t.files.join(', ') || 'none'}\nAssistant: ${compactText(t.assistantText, 800)}${t.errorMessage ? `\nError: ${t.errorMessage}` : ''}`,
            ),
          ].join('\n');

          try {
            const llmText = await this.invokeLlmWithTimeout({
              instanceId: summarizerId,
              model: config.summarizerModel,
              cwd: session.cwd,
              prompt,
              timeoutMs: config.timeoutMs,
            });
            if (!llmText || !llmText.trim()) {
              throw new Error('Empty summary returned by summarizer');
            }
            rawSummary = compactText(llmText.trim(), perChunkBudget);
            usedLlm = true;
            llmCallsMade++;
            this.incrementDailyLlmCalls();
            this.addSessionTokensUsed(
              session.workspaceId,
              sessionId,
              estimatedPromptTokens + Math.ceil(rawSummary.length / 4),
            );
          } catch (err) {
            fallback = true;
            fallbackReason =
              err && typeof err === 'object' && 'isTimeout' in err
                ? 'timeout'
                : 'adapter_error';
            anyFallback = true;
            lastFallbackReason = fallbackReason;
            this.hooks.emitEvent?.(sessionId, 'compression.fallback_triggered', {
              reason: fallbackReason,
              fromSeq: chunkFromSeq,
              toSeq: chunkToSeq,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (!rawSummary) {
        rawSummary = buildLocalChunkSummary(group, perChunkBudget);
      }

      const checked = validateReferencedPaths(rawSummary, session.cwd);
      const compressedChars = checked.markdown.length;
      const compressionRatio =
        originalChars > 0
          ? Number((originalChars / Math.max(1, compressedChars)).toFixed(2))
          : 1;

      const chunk: CompressedTurnChunk = {
        chunkId: `chk_${createHash('sha256').update(kvKey).digest('hex').slice(0, 12)}`,
        sessionId,
        fromSeq: chunkFromSeq,
        toSeq: chunkToSeq,
        fromTurn,
        toTurn,
        sourceItemsHash,
        summaryMarkdown: checked.markdown,
        originalChars,
        compressedChars,
        compressionRatio,
        usedLlm,
        summarizerInstanceId: usedLlm ? summarizerId : null,
        fallback,
        fallbackReason,
        cacheHit: false,
        referencedPaths: checked.referencedPaths,
        createdAt: this.now(),
      };

      // Cache successful normal results (avoid permanently caching transient timeout/error fallbacks
      // unless local mode was intentionally chosen, so transient LLM outages can recover cleanly).
      if (!fallback || fallbackReason === 'budget_exceeded') {
        this.memoryChunks.set(memKey, chunk);
        this.writeWorkspaceCachedValue(session.workspaceId, kvKey, chunk);
      }

      this.hooks.emitEvent?.(sessionId, 'compression.chunk_ready', {
        chunkId: chunk.chunkId,
        fromSeq: chunk.fromSeq,
        toSeq: chunk.toSeq,
        fromTurn: chunk.fromTurn,
        toTurn: chunk.toTurn,
        originalChars: chunk.originalChars,
        compressedChars: chunk.compressedChars,
        compressionRatio: chunk.compressionRatio,
        usedLlm: chunk.usedLlm,
      });

      chunks.push(chunk);
    }

    const totalOriginalChars = chunks.reduce((s, c) => s + c.originalChars, 0);
    const totalCompressedChars = chunks.reduce((s, c) => s + c.compressedChars, 0);
    const combinedMarkdown = chunks.map((c) => c.summaryMarkdown).filter(Boolean).join('\n\n');

    return {
      chunks,
      combinedMarkdown,
      totalOriginalChars,
      totalCompressedChars,
      compressionRatio:
        totalOriginalChars > 0
          ? Number((totalOriginalChars / Math.max(1, totalCompressedChars)).toFixed(2))
          : 1,
      usedLlm: chunks.some((c) => c.usedLlm),
      fallback: anyFallback,
      fallbackReason: lastFallbackReason,
      llmCallsMade,
      cacheHits,
    };
  }

  scheduleIdleRollup(sessionId: string): void {
    if (!this.isEnabled()) return;
    const config = this.getConfig();
    if (!config.backgroundRollupEnabled) return;
    if (this.rollingSessions.has(sessionId)) return;

    const timer = setTimeout(() => {
      this.pendingRollupTimers.delete(timer);
      void this.runIdleRollup(sessionId).catch(() => {});
    }, 0);
    timer.unref?.();
    this.pendingRollupTimers.add(timer);
  }

  async runIdleRollup(sessionId: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const config = this.getConfig();
    if (!config.backgroundRollupEnabled) return false;
    if (this.rollingSessions.has(sessionId)) return false;

    const session = this.store.getSession(sessionId);
    if (!session || session.lastSeq < 2) return false;

    const events = [...this.store.iterateEvents(sessionId, 0, session.lastSeq)];
    const turns = collectTurnsForCompression(events, session.harnessId);
    if (turns.length < config.rollupTurnThreshold) return false;

    const totalRawChars = turns.reduce((s, t) => s + t.rawChars, 0);
    // Only pre-warm when occupancy crosses ~60% of a typical 32k token (~80k char) handoff window
    if (totalRawChars < 48_000) return false;

    const olderTurns = turns.slice(0, Math.max(config.chunkSizeTurns, turns.length - 8));
    if (olderTurns.length === 0) return false;

    this.rollingSessions.add(sessionId);
    try {
      await this.compressRange(
        sessionId,
        olderTurns[0]!.startSeq,
        olderTurns[olderTurns.length - 1]!.endSeq,
        8_000,
      );
      return true;
    } finally {
      this.rollingSessions.delete(sessionId);
    }
  }

  listSessionChunks(sessionId: string): CompressedTurnChunk[] {
    const session = this.store.getSession(sessionId);
    if (!session) return [];
    const prefix = `chunk:${sessionId}:`;
    const keys = this.store
      .listPluginStorageKeys(session.workspaceId, CONTEXT_COMPRESSION_PLUGIN_ID)
      .filter((k) => k.startsWith(prefix));
    const list: CompressedTurnChunk[] = [];
    for (const key of keys) {
      const memKey = `${session.workspaceId}::${key}`;
      const chunk =
        this.memoryChunks.get(memKey) ??
        (this.store.getPluginStorageValue(
          session.workspaceId,
          CONTEXT_COMPRESSION_PLUGIN_ID,
          key,
        ) as CompressedTurnChunk | undefined);
      if (chunk) list.push(chunk);
    }
    list.sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
    return list;
  }

  clearSessionCache(sessionId: string): { clearedCount: number } {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new ContextCompressionError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
    const prefix = `chunk:${sessionId}:`;
    const keys = this.store
      .listPluginStorageKeys(session.workspaceId, CONTEXT_COMPRESSION_PLUGIN_ID)
      .filter((k) => k.startsWith(prefix));
    for (const key of keys) {
      this.store.deletePluginStorageValue(
        session.workspaceId,
        CONTEXT_COMPRESSION_PLUGIN_ID,
        key,
      );
      this.memoryChunks.delete(`${session.workspaceId}::${key}`);
    }
    this.store.deletePluginStorageValue(
      session.workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      `${SESSION_USAGE_PREFIX}${sessionId}`,
    );

    const remaining = this.readLruIndex(session.workspaceId).filter(
      (entry) => !entry.key.startsWith(prefix),
    );
    this.memoryLru.set(session.workspaceId, remaining);
    this.store.setPluginStorageValue(
      session.workspaceId,
      CONTEXT_COMPRESSION_PLUGIN_ID,
      LRU_INDEX_KEY,
      remaining,
    );
    return { clearedCount: keys.length };
  }

  private listWorkspaceSymbolOutlines(workspaceScope: string): FileSymbolOutline[] {
    const keys = this.store
      .listPluginStorageKeys(workspaceScope, CONTEXT_COMPRESSION_PLUGIN_ID)
      .filter((k) => k.startsWith('sym:'));
    const items: FileSymbolOutline[] = [];
    for (const key of keys) {
      const outline =
        this.memorySymbols.get(`${workspaceScope}::${key}`) ??
        (this.store.getPluginStorageValue(
          workspaceScope,
          CONTEXT_COMPRESSION_PLUGIN_ID,
          key,
        ) as FileSymbolOutline | undefined);
      if (outline) items.push(outline);
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return items;
  }

  async getSessionStatus(sessionId: string): Promise<SessionCompressionStatus> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new ContextCompressionError('E_SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }

    const config = this.getConfig();
    const chunks = this.listSessionChunks(sessionId);
    const taskState = this.hooks.getTaskState?.(sessionId);
    const hotFiles = [...new Set([
      ...(taskState?.touchedFiles ?? []),
      ...chunks.flatMap((c) =>
        c.referencedPaths.filter((p) => p.existsAtCheck).map((p) => p.path),
      ),
    ])].slice(0, 12);

    let symbolOutlines: FileSymbolOutline[] = [];
    let symbolOutlineMarkdown = '';
    if (hotFiles.length > 0) {
      const outlineRes = await this.buildSymbolOutline(
        session.cwd,
        hotFiles,
        config.symbolOutlineMaxChars,
      );
      symbolOutlines = outlineRes.outlines;
      symbolOutlineMarkdown = outlineRes.markdown;
    } else {
      const cachedOutlines = this.listWorkspaceSymbolOutlines(
        this.resolveWorkspaceScopeForPath(session.cwd),
      );
      symbolOutlines = cachedOutlines.slice(0, 12);
    }

    const lruEntries = this.readLruIndex(session.workspaceId);
    const wsSymbolEntries = this.readLruIndex(this.resolveWorkspaceScopeForPath(session.cwd));
    const workspaceBytesUsed =
      lruEntries.reduce((s, e) => s + e.bytes, 0) +
      (this.resolveWorkspaceScopeForPath(session.cwd) === session.workspaceId
        ? 0
        : wsSymbolEntries.reduce((s, e) => s + e.bytes, 0));

    const totalOriginalChars = chunks.reduce((s, c) => s + c.originalChars, 0);
    const totalCompressedChars = chunks.reduce((s, c) => s + c.compressedChars, 0);

    const cacheStats: CompressionCacheStats = {
      chunkCount: chunks.length,
      symbolFileCount: symbolOutlines.length,
      workspaceBytesUsed,
      workspaceBytesCap: this.maxWorkspaceBytes,
      dailyLlmCallsUsed: this.getDailyLlmCallsUsed(),
      dailyLlmCallsLimit: config.dailyCallLimit,
      sessionTokensUsed: this.getSessionTokensUsed(session.workspaceId, sessionId),
      sessionTokenBudgetCap: config.sessionTokenBudgetCap,
    };

    return {
      enabled: this.isEnabled(),
      sessionId,
      workspaceId: session.workspaceId,
      config,
      chunks,
      symbolOutlines,
      symbolOutlineMarkdown,
      totalOriginalChars,
      totalCompressedChars,
      compressionRatio:
        totalOriginalChars > 0
          ? Number((totalOriginalChars / Math.max(1, totalCompressedChars)).toFixed(2))
          : 1,
      cacheStats,
    };
  }
}
