import {
  NativeWorkflowResourceItemDtoSchema,
  toPublicEvidenceDto,
  type NativeWorkflowResourceItemDto,
} from '@harnessmate/protocol';
import type { SwarmBoardPostRecord, SwarmCoordinatorTraceEntry } from './contracts.js';

const MAX_SUMMARY_CHARS = 4000;

/**
 * Redacts private host paths, OAuth/Bearer tokens, and cookies before storing or returning
 * Board post or coordinator trace summaries (Risk R-06).
 */
export function sanitizeSwarmPublicText(
  raw: string,
  maxChars = MAX_SUMMARY_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  let cleaned = raw
    .replace(/(?:Bearer|token|api[_-]?key|cookie)\s*[=:]\s*[^\s,;]+/gi, '[REDACTED_SECRET]')
    .replace(/([?&](?:access_token|refresh_token|id_token|code|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z]:\\(?:Users|AppData|ProgramData|HarnessMate)[^\s"'`<>|]*/gi, '[REDACTED_PATH]')
    .replace(/\/(?:Users|home|var|private|tmp)\/[^\s"'`<>|]*/g, '[REDACTED_PATH]');

  let truncated = false;
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars);
    truncated = true;
  }
  return { text: cleaned, truncated };
}

interface StableIdCursorPayload {
  readonly afterId: string;
}

export function encodeStableIdPageToken(afterId: string): string {
  const payload: StableIdCursorPayload = { afterId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeStableIdPageToken(token?: string): string | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      afterId?: unknown;
    };
    return typeof parsed.afterId === 'string' && parsed.afterId.trim().length > 0
      ? parsed.afterId.trim()
      : null;
  } catch {
    return null;
  }
}

export interface StablePaginatedResult {
  readonly revision: number;
  readonly items: readonly NativeWorkflowResourceItemDto[];
  readonly nextPageToken: string | null;
  readonly hasMore: boolean;
  readonly cursorInvalid?: boolean;
}

/**
 * Stable-ID bounded store for Swarm Board posts and Coordinator activity trace entries.
 *
 * Key properties:
 * - Deduplicates by stable `postId` / `entryId` without ever deduplicating distinct entries by text.
 * - Paginates strictly by stable ID cursor (`afterId`), NOT unstable numeric offsets, so concurrent
 *   appends never duplicate or skip items across page boundaries.
 * - Validates every outgoing item through `NativeWorkflowResourceItemDtoSchema` (strict allowlist).
 */
export class SwarmBoardStore {
  private readonly posts: SwarmBoardPostRecord[] = [];
  private readonly postsById = new Map<string, SwarmBoardPostRecord>();
  private readonly traceEntries: SwarmCoordinatorTraceEntry[] = [];
  private readonly traceById = new Map<string, SwarmCoordinatorTraceEntry>();
  private boardRevision = 0;
  private traceRevision = 0;
  private droppedBoardPosts = 0;
  private droppedTraceEntries = 0;

  constructor(
    private readonly maxBoardPosts: number,
    private readonly maxTraceEntries: number,
  ) {}

  upsertPost(record: SwarmBoardPostRecord): {
    readonly inserted: boolean;
    readonly updated: boolean;
    readonly trimmed: boolean;
  } {
    const existing = this.postsById.get(record.postId);
    if (existing) {
      // Idempotent update if newer ingress ordinal or richer confirmed author attribution arrives.
      if (
        record.ingressOrdinal > existing.ingressOrdinal ||
        (!existing.authorAgentId && record.authorAgentId)
      ) {
        const idx = this.posts.findIndex((p) => p.postId === record.postId);
        if (idx >= 0) {
          this.posts[idx] = record;
        }
        this.postsById.set(record.postId, record);
        this.boardRevision += 1;
        return { inserted: false, updated: true, trimmed: false };
      }
      return { inserted: false, updated: false, trimmed: false };
    }

    this.posts.push(record);
    this.postsById.set(record.postId, record);
    this.boardRevision += 1;

    let trimmed = false;
    while (this.posts.length > this.maxBoardPosts) {
      const removed = this.posts.shift();
      if (removed) {
        this.postsById.delete(removed.postId);
        this.droppedBoardPosts += 1;
        trimmed = true;
      }
    }
    return { inserted: true, updated: false, trimmed };
  }

  appendTrace(entry: SwarmCoordinatorTraceEntry): {
    readonly inserted: boolean;
    readonly trimmed: boolean;
  } {
    if (this.traceById.has(entry.entryId)) {
      return { inserted: false, trimmed: false };
    }
    this.traceEntries.push(entry);
    this.traceById.set(entry.entryId, entry);
    this.traceRevision += 1;

    let trimmed = false;
    while (this.traceEntries.length > this.maxTraceEntries) {
      const removed = this.traceEntries.shift();
      if (removed) {
        this.traceById.delete(removed.entryId);
        this.droppedTraceEntries += 1;
        trimmed = true;
      }
    }
    return { inserted: true, trimmed };
  }

  getPost(postId: string): SwarmBoardPostRecord | undefined {
    return this.postsById.get(postId);
  }

  getPostCount(): number {
    return this.posts.length;
  }

  getTraceCount(): number {
    return this.traceEntries.length;
  }

  getBoardRevision(): number {
    return this.boardRevision;
  }

  getTraceRevision(): number {
    return this.traceRevision;
  }

  getDroppedCounts(): { readonly boardPosts: number; readonly traceEntries: number } {
    return {
      boardPosts: this.droppedBoardPosts,
      traceEntries: this.droppedTraceEntries,
    };
  }

  listTraceEntries(): readonly SwarmCoordinatorTraceEntry[] {
    return [...this.traceEntries];
  }

  /**
   * Stable-ID cursor pagination for `resource: 'board'` (`kind: 'board_post'`).
   */
  readBoardPage(opts: {
    readonly pageToken?: string;
    readonly limit: number;
    readonly nowMs?: number;
  }): StablePaginatedResult {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    const nowMs = opts.nowMs ?? Date.now();
    let startIndex = 0;

    if (opts.pageToken) {
      const afterId = decodeStableIdPageToken(opts.pageToken);
      if (!afterId) {
        return {
          revision: this.boardRevision,
          items: [],
          nextPageToken: null,
          hasMore: false,
          cursorInvalid: true,
        };
      }
      const foundIdx = this.posts.findIndex((p) => p.postId === afterId);
      if (foundIdx < 0) {
        return {
          revision: this.boardRevision,
          items: [],
          nextPageToken: null,
          hasMore: false,
          cursorInvalid: true,
        };
      }
      startIndex = foundIdx + 1;
    }

    const slice = this.posts.slice(startIndex, startIndex + safeLimit);
    const hasMore = startIndex + slice.length < this.posts.length;
    const lastItem = slice[slice.length - 1];

    const items = slice.map((post) =>
      NativeWorkflowResourceItemDtoSchema.parse({
        kind: 'board_post',
        postId: post.postId,
        ...(post.threadId ? { threadId: post.threadId } : {}),
        ...(post.authorAgentId ? { authorAgentId: post.authorAgentId } : {}),
        ...(post.authorLabel ? { authorLabel: post.authorLabel.slice(0, 120) } : {}),
        summary: post.summary,
        truncated: post.truncated,
        createdAt: post.createdAt,
        evidence: toPublicEvidenceDto(post.evidence, nowMs),
      }),
    );

    return {
      revision: this.boardRevision,
      items,
      nextPageToken: hasMore && lastItem ? encodeStableIdPageToken(lastItem.postId) : null,
      hasMore,
    };
  }

  /**
   * Stable-ID cursor pagination for `resource: 'logs'` (`kind: 'log_entry'`).
   * Preserves captured coordinator trajectory even when Swarm or Board gates are disabled.
   */
  readTracePage(opts: {
    readonly pageToken?: string;
    readonly limit: number;
    readonly nowMs?: number;
  }): StablePaginatedResult {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    const nowMs = opts.nowMs ?? Date.now();
    let startIndex = 0;

    if (opts.pageToken) {
      const afterId = decodeStableIdPageToken(opts.pageToken);
      if (!afterId) {
        return {
          revision: this.traceRevision,
          items: [],
          nextPageToken: null,
          hasMore: false,
          cursorInvalid: true,
        };
      }
      const foundIdx = this.traceEntries.findIndex((e) => e.entryId === afterId);
      if (foundIdx < 0) {
        return {
          revision: this.traceRevision,
          items: [],
          nextPageToken: null,
          hasMore: false,
          cursorInvalid: true,
        };
      }
      startIndex = foundIdx + 1;
    }

    const slice = this.traceEntries.slice(startIndex, startIndex + safeLimit);
    const hasMore = startIndex + slice.length < this.traceEntries.length;
    const lastEntry = slice[slice.length - 1];

    const items = slice.map((entry) =>
      NativeWorkflowResourceItemDtoSchema.parse({
        kind: 'log_entry',
        entryId: entry.entryId,
        seq: entry.seq,
        level: entry.level,
        summary: entry.summary,
        truncated: entry.truncated,
        createdAt: entry.timestamp,
        evidence: toPublicEvidenceDto(entry.evidence, nowMs),
      }),
    );

    return {
      revision: this.traceRevision,
      items,
      nextPageToken: hasMore && lastEntry ? encodeStableIdPageToken(lastEntry.entryId) : null,
      hasMore,
    };
  }
}
