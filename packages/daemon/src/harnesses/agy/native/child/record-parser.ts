import fs from 'node:fs';
import path from 'node:path';
import type { AgentForeground, Evidence, WorkState } from '@harnessmate/protocol';
import { resolveManagedProfilePathSync } from '../../agy-profile-manager.js';

export const CHILD_RECORD_SCHEMA_VERSIONS = ['app_v1', 'cli_legacy_v0'] as const;
export type ChildRecordSchemaVersion = (typeof CHILD_RECORD_SCHEMA_VERSIONS)[number];

export const DEFAULT_CHILD_SCAN_LIMITS = Object.freeze({
  maxFilesPerDir: 30,
  hardMaxFilesPerDir: 100,
  maxFileBytes: 262_144, // 256 KiB
  maxJsonDepth: 12,
  maxTranscriptLines: 200,
  maxSummaryChars: 400,
  maxLabelChars: 160,
  staleTtlMs: 30_000,
});

export interface ChildRecordScanOptions {
  /** Schema gate allowlist; unrecognized or disabled schemas fail closed. */
  readonly supportedSchemas?: readonly ChildRecordSchemaVersion[];
  /** Capped max JSON files scanned per subagents directory (bounded by hardMaxFilesPerDir). */
  readonly maxFilesPerDir?: number;
  /** Capped max bytes read per regular file (bounded by 256 KiB). */
  readonly maxFileBytes?: number;
  /** Maximum JSON nesting depth allowed before rejecting malformed/adversarial payloads. */
  readonly maxJsonDepth?: number;
  /** Maximum lines read from a verified child-owned JSONL file. */
  readonly maxTranscriptLines?: number;
  /** Staleness TTL for `native_snapshot` evidence (`staleAt = observedAt + staleTtlMs`). */
  readonly staleTtlMs?: number;
  /** Clock override for deterministic tests. */
  readonly nowMs?: number;
  /** Optional logical source identifier (never a raw host path!). */
  readonly sourceId?: string;
}

export interface ParsedChildRecord {
  /** Record filename stem (`native_record` namespace — distinct from `tool_call` and `session`). */
  readonly recordId: string;
  readonly schemaVersion: ChildRecordSchemaVersion;
  /** Verified child conversation ID when provided by schema (`session` namespace). */
  readonly conversationId?: string;
  readonly role?: string;
  readonly label?: string;
  readonly typeName?: string;
  readonly rawState: string;
  readonly workState: WorkState;
  readonly foreground: AgentForeground;
  readonly spawnStepIndex?: number;
  readonly workspaceCount?: number;
  readonly summary?: string;
  readonly updatedAt?: number;
  readonly truncated: boolean;
  readonly evidence: Extract<Evidence, { kind: 'native_snapshot' }>;
}

export interface RejectedChildRecordDiagnostic {
  readonly fileName: string;
  readonly reasonCode:
    | 'invalid_filename'
    | 'path_or_reparse_rejected'
    | 'invalid_json'
    | 'json_depth_exceeded'
    | 'unsupported_schema_version'
    | 'unknown_record_schema'
    | 'schema_disabled_by_gate';
  readonly detectedTopLevelKeys?: readonly string[];
}

export interface ChildRecordScanResult {
  readonly parentNativeSessionId: string;
  readonly records: readonly ParsedChildRecord[];
  readonly rejected: readonly RejectedChildRecordDiagnostic[];
  readonly scannedFileCount: number;
  readonly truncatedDirectoryScan: boolean;
  readonly observedAt: number;
  readonly staleAt: number;
  readonly readerDisabledReason?: string;
}

export interface ChildTranscriptReadResult {
  readonly recordId: string;
  readonly available: boolean;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly reasonCode?:
    | 'child_transcript_not_present'
    | 'path_or_reparse_rejected'
    | 'invalid_identifier';
}

const SAFE_RECORD_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/;
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const SECRET_OR_PATH_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:access_token|refresh_token|id_token|api_key|apikey|token|secret|password)\s*[=:]\s*[^\s&"',;}\]]+/gi,
  /file:\/\/\/[^\s"'<>]+/gi,
  /[A-Za-z]:\\(?:[^\\\s"'<>]+\\)+[^\\\s"'<>]*/g,
  /\/(?:Users|home|var|etc|tmp|mnt|opt|private)\/[^\s"'<>]+/g,
];

/**
 * Redacts private host paths, file URIs, and token-like secrets before exposing any
 * summary or timeline snippet in public DTOs.
 */
export function redactPrivateChildText(
  raw: string,
  maxChars: number = DEFAULT_CHILD_SCAN_LIMITS.maxSummaryChars,
): string {
  let clean = raw.replace(/\r\n/g, '\n').trim();
  for (const pattern of SECRET_OR_PATH_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  if (clean.length > maxChars) {
    return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return clean;
}

function assertBoundedJsonDepth(value: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!assertBoundedJsonDepth(item, maxDepth, depth + 1)) return false;
    }
    return true;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (!assertBoundedJsonDepth(child, maxDepth, depth + 1)) return false;
  }
  return true;
}

function readBoundedRegularFileWithHandleCheck(
  rootDir: string,
  segments: readonly string[],
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } | undefined {
  const safe = resolveManagedProfilePathSync(rootDir, segments, 'file');
  if (!safe) return undefined;

  const cappedBytes = Math.min(Math.max(1, maxBytes), DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes);
  let fd: number;
  try {
    fd = fs.openSync(safe.path, 'r');
  } catch {
    return undefined;
  }

  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isFile()) {
      return undefined;
    }
    // Re-verify opened handle identity against resolved lstat (defends against TOCTOU reparse/symlink swap)
    if (
      safe.info.ino !== 0 &&
      fstat.ino !== 0 &&
      (fstat.ino !== safe.info.ino || fstat.dev !== safe.info.dev)
    ) {
      return undefined;
    }

    const bytesToRead = Math.min(fstat.size, cappedBytes);
    const buf = Buffer.alloc(bytesToRead);
    const readBytes = bytesToRead > 0 ? fs.readSync(fd, buf, 0, bytesToRead, 0) : 0;
    return {
      text: buf.subarray(0, readBytes).toString('utf8'),
      truncated: fstat.size > cappedBytes,
    };
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Maps raw state strings from App (`app_v1`) or CLI (`cli_legacy_v0`) records to
 * normalized `WorkState` and `AgentForeground` WITHOUT treating `idle` as `succeeded`.
 */
export function mapNativeChildRecordState(rawState: string): {
  readonly workState: WorkState;
  readonly foreground: AgentForeground;
} {
  const norm = rawState.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (norm) {
    case 'queued':
    case 'pending':
    case 'starting':
      return { workState: 'queued', foreground: 'running' };
    case 'running':
    case 'active':
    case 'in_progress':
    case 'working':
      return { workState: 'running', foreground: 'running' };
    case 'waiting':
    case 'waiting_background':
    case 'sleeping':
      return { workState: 'waiting', foreground: 'idle' };
    case 'idle':
    case 'paused':
    case 'quiescent':
      // Crucial invariant (T07 / 08_Shared_Contracts.md): idle is NOT finished/succeeded!
      return { workState: 'waiting', foreground: 'idle' };
    case 'requires_action':
    case 'awaiting_approval':
    case 'needs_input':
      return { workState: 'requires_action', foreground: 'requires_action' };
    case 'completed':
    case 'done':
    case 'finished':
    case 'succeeded':
      return { workState: 'finished', foreground: 'idle' };
    case 'failed':
    case 'error':
    case 'errored':
      return { workState: 'failed', foreground: 'idle' };
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
      return { workState: 'cancelled', foreground: 'idle' };
    default:
      return { workState: 'unknown', foreground: 'unknown' };
  }
}

function extractBoundedString(
  obj: Record<string, unknown>,
  keys: readonly string[],
  maxChars: number,
): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return redactPrivateChildText(val, maxChars);
    }
  }
  return undefined;
}

/**
 * Versioned parser for a single subagent JSON payload.
 *
 * Supported schemas:
 * - `app_v1` (E06 real Windows App shape):
 *   `{ conversationId: string, subagentDescriptor: object, state: string, spawnStepIndex: number, workspaceUris: string[] }`
 * - `cli_legacy_v0` (AGY-4 legacy shape):
 *   `{ id?: string, role?: string, typeName?: string, status: string, summary?: string, updatedAt?: number }`
 *
 * Unknown or newer schema versions FAIL CLOSED and never fabricate child records.
 */
export function parseVersionedChildRecordPayload(params: {
  readonly recordId: string;
  readonly raw: unknown;
  readonly truncated: boolean;
  readonly observedAt: number;
  readonly staleAt: number;
  readonly sourceId: string;
  readonly supportedSchemas: readonly ChildRecordSchemaVersion[];
  readonly maxJsonDepth?: number;
}):
  | { readonly ok: true; readonly record: ParsedChildRecord }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'invalid_json'
        | 'json_depth_exceeded'
        | 'unsupported_schema_version'
        | 'unknown_record_schema'
        | 'schema_disabled_by_gate';
      readonly detectedTopLevelKeys?: readonly string[];
    } {
  const maxDepth = params.maxJsonDepth ?? DEFAULT_CHILD_SCAN_LIMITS.maxJsonDepth;
  if (!params.raw || typeof params.raw !== 'object' || Array.isArray(params.raw)) {
    return { ok: false, reasonCode: 'invalid_json' };
  }
  if (!assertBoundedJsonDepth(params.raw, maxDepth)) {
    return { ok: false, reasonCode: 'json_depth_exceeded' };
  }

  const obj = params.raw as Record<string, unknown>;
  const topKeys = Object.keys(obj).sort();

  // Fail closed on explicit unsupported/future schemaVersion
  if ('schemaVersion' in obj) {
    const sv = obj.schemaVersion;
    const isKnownExplicit = sv === 1 || sv === '1' || sv === 'app_v1' || sv === 'cli_legacy_v0';
    if (!isKnownExplicit) {
      return {
        ok: false,
        reasonCode: 'unsupported_schema_version',
        detectedTopLevelKeys: topKeys,
      };
    }
  }

  // 1. E06 real App v1 shape:
  //    conversationId:string, subagentDescriptor:object, state:string, spawnStepIndex:number, workspaceUris:array
  const looksLikeAppV1 =
    typeof obj.conversationId === 'string' &&
    obj.conversationId.trim().length > 0 &&
    obj.subagentDescriptor !== null &&
    typeof obj.subagentDescriptor === 'object' &&
    !Array.isArray(obj.subagentDescriptor) &&
    typeof obj.state === 'string' &&
    typeof obj.spawnStepIndex === 'number' &&
    Number.isInteger(obj.spawnStepIndex) &&
    obj.spawnStepIndex >= 0 &&
    Array.isArray(obj.workspaceUris);

  if (looksLikeAppV1) {
    if (!params.supportedSchemas.includes('app_v1')) {
      return {
        ok: false,
        reasonCode: 'schema_disabled_by_gate',
        detectedTopLevelKeys: topKeys,
      };
    }
    const descriptor = obj.subagentDescriptor as Record<string, unknown>;
    const role = extractBoundedString(
      descriptor,
      ['role', 'Role', 'agentRole', 'title'],
      DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars,
    );
    const typeName = extractBoundedString(
      descriptor,
      ['typeName', 'TypeName', 'agentType', 'type', 'kind'],
      DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars,
    );
    const label = extractBoundedString(
      descriptor,
      ['label', 'displayName', 'name', 'role', 'Role'],
      DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars,
    );
    const summary = extractBoundedString(
      descriptor,
      ['summary', 'description'],
      DEFAULT_CHILD_SCAN_LIMITS.maxSummaryChars,
    );
    const mapped = mapNativeChildRecordState(obj.state as string);
    const updatedAt =
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt >= 0
        ? Math.floor(obj.updatedAt)
        : undefined;

    return {
      ok: true,
      record: {
        recordId: params.recordId,
        schemaVersion: 'app_v1',
        conversationId: (obj.conversationId as string).trim(),
        ...(role ? { role } : {}),
        ...(label ? { label } : {}),
        ...(typeName ? { typeName } : {}),
        rawState: (obj.state as string).trim(),
        workState: mapped.workState,
        foreground: mapped.foreground,
        spawnStepIndex: obj.spawnStepIndex as number,
        // Never expose raw workspaceUris; retain only privacy-safe count
        workspaceCount: (obj.workspaceUris as unknown[]).filter((u) => typeof u === 'string').length,
        ...(summary ? { summary } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        truncated: params.truncated,
        evidence: {
          kind: 'native_snapshot',
          sourceId: params.sourceId,
          schemaVersion: 'app_v1',
          observedAt: params.observedAt,
          staleAt: params.staleAt,
        },
      },
    };
  }

  // 2. Legacy CLI / AGY-4 v0 shape:
  //    { id?, role?, typeName?, status: string, summary?, updatedAt? }
  const legacyAllowedKeys = new Set([
    'id',
    'role',
    'typeName',
    'status',
    'summary',
    'updatedAt',
    'conversationId',
    'schemaVersion',
  ]);
  const hasLegacyStatus = typeof obj.status === 'string' && obj.status.trim().length > 0;
  const hasOnlyKnownLegacyKeys = topKeys.every((k) => legacyAllowedKeys.has(k));

  if (hasLegacyStatus && hasOnlyKnownLegacyKeys) {
    if (!params.supportedSchemas.includes('cli_legacy_v0')) {
      return {
        ok: false,
        reasonCode: 'schema_disabled_by_gate',
        detectedTopLevelKeys: topKeys,
      };
    }
    const role = extractBoundedString(obj, ['role'], DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars);
    const typeName = extractBoundedString(obj, ['typeName'], DEFAULT_CHILD_SCAN_LIMITS.maxLabelChars);
    const summary = extractBoundedString(obj, ['summary'], DEFAULT_CHILD_SCAN_LIMITS.maxSummaryChars);
    const conversationId =
      typeof obj.conversationId === 'string' && obj.conversationId.trim().length > 0
        ? obj.conversationId.trim()
        : undefined;
    const mapped = mapNativeChildRecordState(obj.status as string);
    const updatedAt =
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt >= 0
        ? Math.floor(obj.updatedAt)
        : undefined;

    return {
      ok: true,
      record: {
        recordId:
          typeof obj.id === 'string' && obj.id.trim().length > 0
            ? obj.id.trim()
            : params.recordId,
        schemaVersion: 'cli_legacy_v0',
        ...(conversationId ? { conversationId } : {}),
        ...(role ? { role } : {}),
        ...(role ? { label: role } : {}),
        ...(typeName ? { typeName } : {}),
        rawState: (obj.status as string).trim(),
        workState: mapped.workState,
        foreground: mapped.foreground,
        ...(summary ? { summary } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        truncated: params.truncated,
        evidence: {
          kind: 'native_snapshot',
          sourceId: params.sourceId,
          schemaVersion: 'cli_legacy_v0',
          observedAt: params.observedAt,
          staleAt: params.staleAt,
        },
      },
    };
  }

  return {
    ok: false,
    reasonCode: 'unknown_record_schema',
    detectedTopLevelKeys: topKeys,
  };
}

/**
 * Strictly read-only, schema-gated, bounded scan of AGY subagent JSON records under
 * `<appDataPath>/brain/<parentNativeSessionId>/.system_generated/subagents/`.
 *
 * Security & correctness guarantees:
 * - Strictly validates every path segment via `resolveManagedProfilePathSync` (rejects symlinks,
 *   Windows junctions/reparse points, `..`, and path separators) plus `fstatSync` handle verification.
 * - Caps scanned file count and per-file bytes (`maxFilesPerDir`, `maxFileBytes`).
 * - Fails closed on unknown or disabled schema versions.
 * - Never writes, touches, or opens SQLite/WAL files.
 */
export function scanVersionedChildRecords(
  appDataPath: string,
  parentNativeSessionId: string,
  opts?: ChildRecordScanOptions,
): ChildRecordScanResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleTtlMs = Math.max(1_000, opts?.staleTtlMs ?? DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs);
  const staleAt = nowMs + staleTtlMs;
  const supportedSchemas = opts?.supportedSchemas ?? CHILD_RECORD_SCHEMA_VERSIONS;
  const sourceId = opts?.sourceId ?? 'agy_readonly_subagents';

  const cleanParent = parentNativeSessionId.trim();
  if (!cleanParent || !SAFE_SEGMENT_RE.test(cleanParent)) {
    return {
      parentNativeSessionId: cleanParent,
      records: [],
      rejected: [],
      scannedFileCount: 0,
      truncatedDirectoryScan: false,
      observedAt: nowMs,
      staleAt,
      readerDisabledReason: 'invalid_parent_session_id',
    };
  }

  if (supportedSchemas.length === 0) {
    return {
      parentNativeSessionId: cleanParent,
      records: [],
      rejected: [],
      scannedFileCount: 0,
      truncatedDirectoryScan: false,
      observedAt: nowMs,
      staleAt,
      readerDisabledReason: 'reader_disabled_by_schema_gate',
    };
  }

  const subagentsDir = resolveManagedProfilePathSync(
    appDataPath,
    ['brain', cleanParent, '.system_generated', 'subagents'],
    'directory',
  );
  if (!subagentsDir) {
    return {
      parentNativeSessionId: cleanParent,
      records: [],
      rejected: [],
      scannedFileCount: 0,
      truncatedDirectoryScan: false,
      observedAt: nowMs,
      staleAt,
    };
  }

  const maxFiles = Math.min(
    Math.max(1, opts?.maxFilesPerDir ?? DEFAULT_CHILD_SCAN_LIMITS.maxFilesPerDir),
    DEFAULT_CHILD_SCAN_LIMITS.hardMaxFilesPerDir,
  );
  const maxBytes = Math.min(
    Math.max(1024, opts?.maxFileBytes ?? DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes),
    DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes,
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(subagentsDir.path).sort();
  } catch {
    return {
      parentNativeSessionId: cleanParent,
      records: [],
      rejected: [],
      scannedFileCount: 0,
      truncatedDirectoryScan: false,
      observedAt: nowMs,
      staleAt,
    };
  }

  const jsonEntries = entries.filter((name) => name.endsWith('.json'));
  const truncatedDirectoryScan = jsonEntries.length > maxFiles;
  const boundedEntries = jsonEntries.slice(0, maxFiles);

  const records: ParsedChildRecord[] = [];
  const rejected: RejectedChildRecordDiagnostic[] = [];

  for (const entry of boundedEntries) {
    if (!SAFE_RECORD_FILENAME_RE.test(entry)) {
      rejected.push({ fileName: entry.slice(0, 64), reasonCode: 'invalid_filename' });
      continue;
    }

    const read = readBoundedRegularFileWithHandleCheck(
      appDataPath,
      ['brain', cleanParent, '.system_generated', 'subagents', entry],
      maxBytes,
    );
    if (!read) {
      rejected.push({ fileName: entry, reasonCode: 'path_or_reparse_rejected' });
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(read.text);
    } catch {
      rejected.push({ fileName: entry, reasonCode: 'invalid_json' });
      continue;
    }

    const recordId = path.basename(entry, '.json');
    const result = parseVersionedChildRecordPayload({
      recordId,
      raw: parsedJson,
      truncated: read.truncated,
      observedAt: nowMs,
      staleAt,
      sourceId,
      supportedSchemas,
      maxJsonDepth: opts?.maxJsonDepth,
    });

    if (result.ok) {
      records.push(result.record);
    } else {
      rejected.push({
        fileName: entry,
        reasonCode: result.reasonCode,
        ...(result.detectedTopLevelKeys ? { detectedTopLevelKeys: result.detectedTopLevelKeys } : {}),
      });
    }
  }

  return {
    parentNativeSessionId: cleanParent,
    records,
    rejected,
    scannedFileCount: boundedEntries.length,
    truncatedDirectoryScan,
    observedAt: nowMs,
    staleAt,
  };
}

/**
 * Reads a single versioned child record by recordId (filename stem).
 */
export function readVersionedChildRecord(
  appDataPath: string,
  parentNativeSessionId: string,
  recordId: string,
  opts?: ChildRecordScanOptions,
): {
  readonly record: ParsedChildRecord | null;
  readonly rejection?: RejectedChildRecordDiagnostic;
} {
  const cleanParent = parentNativeSessionId.trim();
  const cleanRecord = recordId.trim();
  const nowMs = opts?.nowMs ?? Date.now();
  const staleTtlMs = Math.max(1_000, opts?.staleTtlMs ?? DEFAULT_CHILD_SCAN_LIMITS.staleTtlMs);
  const staleAt = nowMs + staleTtlMs;
  const supportedSchemas = opts?.supportedSchemas ?? CHILD_RECORD_SCHEMA_VERSIONS;

  if (!SAFE_SEGMENT_RE.test(cleanParent) || !SAFE_SEGMENT_RE.test(cleanRecord)) {
    return {
      record: null,
      rejection: { fileName: `${cleanRecord.slice(0, 64)}.json`, reasonCode: 'invalid_filename' },
    };
  }

  const fileName = `${cleanRecord}.json`;
  if (!SAFE_RECORD_FILENAME_RE.test(fileName)) {
    return {
      record: null,
      rejection: { fileName: fileName.slice(0, 64), reasonCode: 'invalid_filename' },
    };
  }

  const maxBytes = Math.min(
    Math.max(1024, opts?.maxFileBytes ?? DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes),
    DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes,
  );
  const read = readBoundedRegularFileWithHandleCheck(
    appDataPath,
    ['brain', cleanParent, '.system_generated', 'subagents', fileName],
    maxBytes,
  );
  if (!read) {
    return {
      record: null,
      rejection: { fileName, reasonCode: 'path_or_reparse_rejected' },
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read.text);
  } catch {
    return {
      record: null,
      rejection: { fileName, reasonCode: 'invalid_json' },
    };
  }

  const res = parseVersionedChildRecordPayload({
    recordId: cleanRecord,
    raw: parsedJson,
    truncated: read.truncated,
    observedAt: nowMs,
    staleAt,
    sourceId: opts?.sourceId ?? 'agy_readonly_subagents',
    supportedSchemas,
    maxJsonDepth: opts?.maxJsonDepth,
  });

  if (res.ok) {
    return { record: res.record };
  }
  return {
    record: null,
    rejection: {
      fileName,
      reasonCode: res.reasonCode,
      ...(res.detectedTopLevelKeys ? { detectedTopLevelKeys: res.detectedTopLevelKeys } : {}),
    },
  };
}

/**
 * Strictly reads ONLY a child's own sibling `<recordId>.jsonl` transcript file.
 *
 * CRITICAL NP-05 INVARIANT (S09 / R-04):
 * NEVER falls back to parent `logs/transcript.jsonl`. When the child-owned JSONL is absent
 * (as observed in all 88 E06 App samples), returns `available: false` with
 * `reasonCode: 'child_transcript_not_present'`.
 */
export function readChildOwnedTranscriptOnly(
  appDataPath: string,
  parentNativeSessionId: string,
  recordId: string,
  opts?: { readonly maxFileBytes?: number; readonly maxLines?: number },
): ChildTranscriptReadResult {
  const cleanParent = parentNativeSessionId.trim();
  const cleanRecord = recordId.trim();
  if (!SAFE_SEGMENT_RE.test(cleanParent) || !SAFE_SEGMENT_RE.test(cleanRecord)) {
    return {
      recordId: cleanRecord,
      available: false,
      lines: [],
      truncated: false,
      reasonCode: 'invalid_identifier',
    };
  }

  const maxBytes = Math.min(
    Math.max(1024, opts?.maxFileBytes ?? DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes),
    DEFAULT_CHILD_SCAN_LIMITS.maxFileBytes,
  );
  const maxLines = Math.min(
    Math.max(1, opts?.maxLines ?? DEFAULT_CHILD_SCAN_LIMITS.maxTranscriptLines),
    500,
  );

  // Check if sibling JSONL exists via symlink/reparse-safe resolver.
  // NEVER read `logs/transcript.jsonl` (parent transcript)!
  const segments = ['brain', cleanParent, '.system_generated', 'subagents', `${cleanRecord}.jsonl`];
  const existsSafe = resolveManagedProfilePathSync(appDataPath, segments, 'file');
  if (!existsSafe) {
    // Distinguish missing file vs symlink/reparse rejection if possible without following links
    const subDir = resolveManagedProfilePathSync(
      appDataPath,
      ['brain', cleanParent, '.system_generated', 'subagents'],
      'directory',
    );
    if (subDir) {
      const candidate = path.join(subDir.path, `${cleanRecord}.jsonl`);
      try {
        const st = fs.lstatSync(candidate);
        if (st.isSymbolicLink() || !st.isFile()) {
          return {
            recordId: cleanRecord,
            available: false,
            lines: [],
            truncated: false,
            reasonCode: 'path_or_reparse_rejected',
          };
        }
      } catch {
        // File truly does not exist
      }
    }
    return {
      recordId: cleanRecord,
      available: false,
      lines: [],
      truncated: false,
      reasonCode: 'child_transcript_not_present',
    };
  }

  const read = readBoundedRegularFileWithHandleCheck(appDataPath, segments, maxBytes);
  if (!read) {
    return {
      recordId: cleanRecord,
      available: false,
      lines: [],
      truncated: false,
      reasonCode: 'path_or_reparse_rejected',
    };
  }

  const allLines = read.text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const truncatedLines = allLines.length > maxLines;
  const sliced = truncatedLines ? allLines.slice(-maxLines) : allLines;

  return {
    recordId: cleanRecord,
    available: true,
    lines: sliced,
    truncated: read.truncated || truncatedLines,
  };
}
