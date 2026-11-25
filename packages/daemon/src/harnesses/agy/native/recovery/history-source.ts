import type {
  Activity,
  BindingGeneration,
  NativeCanonicalEvent,
  NativeRuntimeProjection,
  RpcId,
  RuntimeBinding,
} from '@harnessmate/protocol';
import { readAgyIndexedHistoryDetailedFromRoot, type HistoryMessage } from '../../../history-scanner.js';
import type { NativeRuntimeStore } from '../wiring/persistence.js';
import type { NativeIngress } from '../wiring/types.js';
import type {
  BlockedReplayServerRequest,
  HistoryReplayEntry,
  HistoryReplayEnvelopeBatch,
  PersistedNativeHistoryReadResult,
  RecoveryReasonCode,
  SanitizedHistoryReplayResult,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRpcId(raw: unknown): RpcId | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.generation === b.generation &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId
  );
}

/**
 * Independent read-only history & replay source for NP-15.
 *
 * Guarantees:
 * - Reads persisted native feeds & projections even when `activeReconcileEnabled` is false.
 * - Fails closed when SQLite component schema is newer than reader while keeping legacy reads alive.
 * - Sanitizes `history_replay` ACP frames: blocks all server requests (approvals/elicitations),
 *   never creates retention leases or live workflow controls, and enforces frame bounds.
 * - Delegates local AGY indexed SQLite reads to hardened `history-scanner.ts` (source-isolated).
 */
export class AgyRecoveryHistorySource {
  constructor(
    private readonly defaults: {
      readonly maxHistoryReplayFrames?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  readPersistedNativeFeedHistory(
    persistence: NativeRuntimeStore,
    sessionId: string,
    instanceId: string,
    opts?: {
      readonly afterSeq?: number;
      readonly limit?: number;
      readonly cursor?: string;
      readonly expectedGeneration?: BindingGeneration;
      readonly nowMs?: number;
    },
  ): PersistedNativeHistoryReadResult {
    const schemaStatus = persistence.getSchemaStatus();
    if (!schemaStatus.compatible) {
      return {
        available: false,
        readOnly: true,
        reasonCode: 'native_schema_newer_than_reader',
        projection: null,
        events: [],
        nextCursor: null,
        hasMore: false,
        resyncRequired: false,
        demotedActivities: [],
      };
    }

    const latest = persistence.getLatestBindingForSession(sessionId, instanceId);
    if (!latest) {
      return {
        available: true,
        readOnly: true,
        projection: null,
        events: [],
        nextCursor: null,
        hasMore: false,
        resyncRequired: false,
        demotedActivities: [],
      };
    }

    const nowMs = opts?.nowMs ?? this.defaults.now?.() ?? Date.now();
    const rawProjection = persistence.readProjection(latest.runtimeId, { enabled: true, nowMs });

    // Demote any non-terminal activities if binding is not attached, never faking live status
    const demotedActivities: Activity[] = (rawProjection?.activities ?? []).map((act) => {
      if (
        latest.status !== 'attached' &&
        !['finished', 'failed', 'cancelled', 'unknown', 'reconciling'].includes(act.state)
      ) {
        return {
          ...act,
          state: latest.status === 'reconciling' ? 'reconciling' : 'unknown',
        };
      }
      return act;
    });

    const projection: NativeRuntimeProjection | null = rawProjection
      ? {
          ...rawProjection,
          activities: demotedActivities,
        }
      : null;

    const eventsRes = persistence.listEvents(latest.runtimeId, {
      afterSeq: opts?.afterSeq ?? 0,
      limit: opts?.limit ?? 100,
      cursor: opts?.cursor,
      expectedGeneration: opts?.expectedGeneration,
    });

    if (eventsRes.resyncRequired) {
      return {
        available: true,
        readOnly: true,
        reasonCode: 'history_replay_only',
        projection,
        events: [],
        nextCursor: null,
        hasMore: false,
        resyncRequired: true,
        resyncReason: eventsRes.reason,
        demotedActivities,
      };
    }

    const events: NativeCanonicalEvent[] = eventsRes.events;
    return {
      available: true,
      readOnly: true,
      reasonCode: latest.status === 'attached' ? undefined : ('history_replay_only' as RecoveryReasonCode),
      projection,
      events,
      nextCursor: eventsRes.nextCursor,
      hasMore: eventsRes.hasMore,
      resyncRequired: false,
      demotedActivities,
    };
  }

  /**
   * Sanitizes `history_replay` ACP frames into read-only replay entries.
   * Never creates approvals, retention leases, or live state transitions.
   */
  sanitizeHistoryReplayFrames(batch: HistoryReplayEnvelopeBatch): SanitizedHistoryReplayResult {
    const captureId = batch.captureId ?? 'history_replay_stream';
    const maxFrames = Math.max(1, batch.maxFrames ?? this.defaults.maxHistoryReplayFrames ?? 2_000);
    const now = this.defaults.now?.() ?? Date.now();

    const entries: HistoryReplayEntry[] = [];
    const blockedServerRequests: BlockedReplayServerRequest[] = [];
    let ignoredNonReplayCount = 0;
    let droppedFrameCount = 0;

    for (const envelope of batch.frames) {
      if (envelope.channel !== 'history_replay') {
        ignoredNonReplayCount += 1;
        continue;
      }
      if (batch.expectedBinding && !sameBinding(envelope.binding, batch.expectedBinding)) {
        ignoredNonReplayCount += 1;
        continue;
      }

      const wire = asRecord(envelope.wire);
      if (!wire) {
        droppedFrameCount += 1;
        continue;
      }

      const method = typeof wire.method === 'string' ? wire.method : null;
      const rpcId = parseRpcId(wire.id);

      // Block ALL server requests (permission/question/elicitation) in history replay
      if (method && (rpcId !== null || method.includes('request_permission') || method.includes('elicitation'))) {
        blockedServerRequests.push({
          ingressOrdinal: envelope.ingressOrdinal,
          rpcId,
          method,
          reasonCode: 'replay_server_request_blocked',
        });
        continue;
      }

      if (entries.length >= maxFrames) {
        droppedFrameCount += 1;
        continue;
      }

      const evidence = {
        kind: 'replay' as const,
        captureId,
        ordinal: envelope.ingressOrdinal,
        observedAt: now,
      };

      if (method === 'session/update') {
        const params = asRecord(wire.params);
        const update = asRecord(params?.update);
        const updateType = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : '';

        if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk' || updateType === 'agent_thought_chunk') {
          const content = asRecord(update?.content);
          const text = typeof content?.text === 'string' ? content.text : undefined;
          if (!text) continue;
          entries.push({
            entryId: `rpl_${envelope.ingressOrdinal}`,
            ingressOrdinal: envelope.ingressOrdinal,
            kind:
              updateType === 'user_message_chunk'
                ? 'user_message'
                : updateType === 'agent_thought_chunk'
                  ? 'thinking'
                  : 'assistant_message',
            text,
            ...(envelope.originSession ? { originSession: envelope.originSession } : {}),
            evidence,
          });
          continue;
        }

        if (updateType === 'tool_call' || updateType === 'tool_call_update') {
          entries.push({
            entryId: `rpl_${envelope.ingressOrdinal}`,
            ingressOrdinal: envelope.ingressOrdinal,
            kind: 'tool_event',
            ...(typeof update?.toolCallId === 'string' ? { toolCallId: update.toolCallId } : {}),
            ...(typeof update?.title === 'string' ? { text: update.title } : {}),
            ...(typeof update?.status === 'string' ? { status: update.status } : {}),
            ...(envelope.originSession ? { originSession: envelope.originSession } : {}),
            evidence,
          });
          continue;
        }

        entries.push({
          entryId: `rpl_${envelope.ingressOrdinal}`,
          ingressOrdinal: envelope.ingressOrdinal,
          kind: 'metadata',
          ...(typeof updateType === 'string' && updateType ? { status: updateType } : {}),
          ...(envelope.originSession ? { originSession: envelope.originSession } : {}),
          evidence,
        });
      }
    }

    return {
      entries,
      blockedServerRequests,
      blockedServerRequestCount: blockedServerRequests.length,
      ignoredNonReplayCount,
      droppedFrameCount,
      truncated: droppedFrameCount > 0,
      createsLiveLeases: false,
      emitsLiveApprovals: false,
    };
  }

  readLocalAgyIndexedHistory(opts: {
    readonly rootDir: string;
    readonly source: 'agy_cli' | 'agy_desktop';
    readonly nativeSessionId: string;
    readonly maxMessages?: number;
    readonly maxTotalBytes?: number;
    readonly maxDbBytes?: number;
  }): {
    readonly source: 'agy_cli' | 'agy_desktop';
    readonly messages: readonly HistoryMessage[];
    readonly partial: boolean;
    readonly truncatedReason?: 'max_messages' | 'max_bytes';
    readonly rootVerified: boolean;
    readonly skippedReason?:
      | 'root_missing'
      | 'reparse_or_escape_blocked'
      | 'db_missing'
      | 'db_too_large'
      | 'invalid_session_id'
      | 'sqlite_unreadable';
    readonly observedAt: number;
  } {
    const detailed = readAgyIndexedHistoryDetailedFromRoot(opts.rootDir, opts.nativeSessionId, {
      maxMessages: opts.maxMessages,
      maxTotalBytes: opts.maxTotalBytes,
      maxDbBytes: opts.maxDbBytes,
    });
    return {
      source: opts.source,
      ...detailed,
    };
  }
}
