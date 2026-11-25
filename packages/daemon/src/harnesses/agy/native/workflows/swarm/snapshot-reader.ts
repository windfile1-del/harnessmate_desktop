import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '@harnessmate/protocol';
import { sanitizeSwarmPublicText } from './board-store.js';
import type {
  SwarmBoardPostRecord,
  SwarmBoardSnapshotReadInput,
  SwarmBoardSnapshotReadResult,
} from './contracts.js';

/**
 * Production allowlist of verified read-only local AGY Swarm Board snapshot schemas.
 *
 * CRITICAL (06_Protocol_Evidence.md E06 & Risk R-05):
 * No local private AGY Swarm Board format has been verified on Windows AGY 1.5.16+.
 * This list MUST remain empty in production so unverified local files and private SQLite
 * databases ALWAYS fail closed (`unverified_local_board_schema`).
 */
export const VERIFIED_LOCAL_BOARD_SCHEMAS: readonly string[] = Object.freeze([]);

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_JSON_DEPTH = 12;
const DEFAULT_MAX_POSTS = 200;
const DEFAULT_STALE_TTL_MS = 60_000;

const SAFE_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const PRIVATE_SQLITE_EXTS = new Set(['.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.wal', '.shm']);

function checkJsonDepth(value: unknown, maxDepth: number, depth = 0): boolean {
  if (depth > maxDepth) return false;
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!checkJsonDepth(item, maxDepth, depth + 1)) return false;
    }
    return true;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!checkJsonDepth(v, maxDepth, depth + 1)) return false;
  }
  return true;
}

function isContainedPath(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Strictly read-only, version-gated, fail-closed local Swarm Board snapshot reader.
 *
 * Enforces every NP-08 / R-05 boundary:
 * 1. Closed unless `gates.swarmEnabled && gates.boardFeedEnabled && gates.localBoardSnapshotEnabled`.
 * 2. Unconditionally blocks SQLite/WAL extensions (never reads unverified private databases).
 * 3. Rejects path traversal, symlinks / Windows reparse points, and TOCTOU swaps via `fstatSync`.
 * 4. Fails closed when `schemaVersion` is not in the explicit verified allowlist (empty by default).
 * 5. Requires exact `nativeSessionId` + `profileRef` (and optional `workflowNativeId`) scope match.
 */
export function readVersionedSwarmBoardSnapshot(
  input: SwarmBoardSnapshotReadInput,
): SwarmBoardSnapshotReadResult {
  if (!input.gates.swarmEnabled || !input.gates.boardFeedEnabled || !input.gates.localBoardSnapshotEnabled) {
    return {
      available: false,
      reasonCode: 'local_board_snapshot_gate_disabled',
      posts: [],
      truncated: false,
    };
  }

  const supportedSchemas = input.supportedSchemas ?? VERIFIED_LOCAL_BOARD_SCHEMAS;
  if (supportedSchemas.length === 0) {
    return {
      available: false,
      reasonCode: 'no_verified_local_board_schema',
      posts: [],
      truncated: false,
    };
  }

  const relFile = input.candidateRelativeFile.trim();
  if (!relFile || path.isAbsolute(relFile) || relFile.includes('..') || relFile.includes('\0')) {
    return {
      available: false,
      reasonCode: 'invalid_snapshot_path',
      posts: [],
      truncated: false,
    };
  }

  const lowerFile = relFile.toLowerCase();
  for (const ext of PRIVATE_SQLITE_EXTS) {
    if (lowerFile.endsWith(ext)) {
      return {
        available: false,
        reasonCode: 'unverified_private_sqlite_blocked',
        posts: [],
        truncated: false,
      };
    }
  }
  if (!lowerFile.endsWith('.json')) {
    return {
      available: false,
      reasonCode: 'unsupported_snapshot_file_type',
      posts: [],
      truncated: false,
    };
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(input.snapshotRootPath);
  } catch {
    return {
      available: false,
      reasonCode: 'snapshot_root_unavailable',
      posts: [],
      truncated: false,
    };
  }

  // Walk every path segment from root to target rejecting symlinks / reparse points.
  const segments = relFile.split(/[\\/]+/).filter(Boolean);
  let cursor = rootReal;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(cursor);
    } catch {
      return {
        available: false,
        reasonCode: 'snapshot_file_not_found',
        posts: [],
        truncated: false,
      };
    }
    if (lstat.isSymbolicLink()) {
      return {
        available: false,
        reasonCode: 'snapshot_reparse_or_symlink_blocked',
        posts: [],
        truncated: false,
      };
    }
  }

  let targetReal: string;
  let preStat: fs.Stats;
  try {
    targetReal = fs.realpathSync(cursor);
    preStat = fs.lstatSync(cursor);
  } catch {
    return {
      available: false,
      reasonCode: 'snapshot_file_not_found',
      posts: [],
      truncated: false,
    };
  }

  if (!isContainedPath(rootReal, targetReal) || !preStat.isFile()) {
    return {
      available: false,
      reasonCode: 'snapshot_path_escaped_root',
      posts: [],
      truncated: false,
    };
  }

  const maxBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (preStat.size > maxBytes) {
    return {
      available: false,
      reasonCode: 'snapshot_file_size_exceeded',
      posts: [],
      truncated: false,
    };
  }

  let rawText: string;
  let fd: number | null = null;
  try {
    fd = fs.openSync(cursor, fs.constants.O_RDONLY);
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > maxBytes || fdStat.ino !== preStat.ino || fdStat.dev !== preStat.dev) {
      return {
        available: false,
        reasonCode: 'snapshot_handle_identity_mismatch',
        posts: [],
        truncated: false,
      };
    }
    const buf = Buffer.alloc(fdStat.size);
    let offset = 0;
    while (offset < fdStat.size) {
      const n = fs.readSync(fd, buf, offset, fdStat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    rawText = buf.subarray(0, offset).toString('utf8');
  } catch {
    return {
      available: false,
      reasonCode: 'snapshot_read_failed',
      posts: [],
      truncated: false,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      available: false,
      reasonCode: 'snapshot_invalid_json',
      posts: [],
      truncated: false,
    };
  }

  const maxDepth = input.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !checkJsonDepth(parsed, maxDepth)) {
    return {
      available: false,
      reasonCode: 'snapshot_schema_or_depth_invalid',
      posts: [],
      truncated: false,
    };
  }

  const doc = parsed as Record<string, unknown>;
  const schemaVersion = typeof doc.schemaVersion === 'string' ? doc.schemaVersion.trim() : '';
  if (!schemaVersion || !supportedSchemas.includes(schemaVersion)) {
    return {
      available: false,
      ...(schemaVersion ? { schemaVersion } : {}),
      reasonCode: 'unverified_local_board_schema',
      posts: [],
      truncated: false,
    };
  }

  // Strict scope verification: session + profile (+ optional workflow ID) must match active Swarm run.
  if (
    typeof doc.nativeSessionId !== 'string' ||
    doc.nativeSessionId.trim() !== input.expectedNativeSessionId
  ) {
    return {
      available: false,
      schemaVersion,
      reasonCode: 'snapshot_session_scope_mismatch',
      posts: [],
      truncated: false,
    };
  }
  if (typeof doc.profileRef !== 'string' || doc.profileRef.trim() !== input.expectedProfileRef) {
    return {
      available: false,
      schemaVersion,
      reasonCode: 'snapshot_profile_scope_mismatch',
      posts: [],
      truncated: false,
    };
  }
  if (
    input.expectedWorkflowNativeId &&
    typeof doc.workflowId === 'string' &&
    doc.workflowId.trim() !== input.expectedWorkflowNativeId
  ) {
    return {
      available: false,
      schemaVersion,
      reasonCode: 'snapshot_workflow_scope_mismatch',
      posts: [],
      truncated: false,
    };
  }

  if (!Array.isArray(doc.posts)) {
    return {
      available: false,
      schemaVersion,
      reasonCode: 'snapshot_posts_missing',
      posts: [],
      truncated: false,
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const staleTtlMs = input.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const maxPosts = input.maxPosts ?? DEFAULT_MAX_POSTS;
  const evidence: Evidence = {
    kind: 'native_snapshot',
    sourceId: `swarm_board:${schemaVersion}`,
    schemaVersion,
    observedAt: nowMs,
    staleAt: nowMs + staleTtlMs,
  };

  const posts: SwarmBoardPostRecord[] = [];
  let truncated = false;
  let ordinal = 0;

  for (const item of doc.posts) {
    if (posts.length >= maxPosts) {
      truncated = true;
      break;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const postId = typeof rec.postId === 'string' ? rec.postId.trim() : '';
    const rawBody = typeof rec.summary === 'string' ? rec.summary : typeof rec.body === 'string' ? rec.body : '';
    if (!SAFE_ID_REGEX.test(postId) || rawBody.trim().length === 0) continue;

    const threadId =
      typeof rec.threadId === 'string' && SAFE_ID_REGEX.test(rec.threadId.trim())
        ? rec.threadId.trim()
        : undefined;
    const authorLabel =
      typeof rec.authorLabel === 'string' && rec.authorLabel.trim().length > 0
        ? sanitizeSwarmPublicText(rec.authorLabel.trim(), 120).text
        : undefined;
    const sanitized = sanitizeSwarmPublicText(rawBody);
    const mentions = Array.isArray(rec.mentions)
      ? rec.mentions
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .map((m) => m.trim().replace(/^@+/, '').slice(0, 80))
          .slice(0, 16)
      : [];
    const createdAt =
      typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) && rec.createdAt >= 0
        ? Math.floor(rec.createdAt)
        : nowMs;

    posts.push({
      postId,
      ...(threadId ? { threadId } : {}),
      ...(authorLabel ? { authorLabel } : {}),
      summary: sanitized.text,
      truncated: sanitized.truncated,
      mentions,
      isSystemWake: rec.isSystemWake === true,
      createdAt,
      ingressOrdinal: ++ordinal,
      evidence,
    });
  }

  return {
    available: true,
    schemaVersion,
    posts,
    truncated,
  };
}
