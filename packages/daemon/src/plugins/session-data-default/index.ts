import { randomUUID } from 'node:crypto';
import {
  LEGACY_SESSION_DATA_CONTRACT,
  LEGACY_SESSION_DATA_CONTRACT_VERSION,
  SESSION_DATA_CONTRACT,
  SESSION_DATA_CONTRACT_VERSION,
  type LegacySessionDataCompatServiceV1,
  type PluginManifest,
  type ServiceMethodResult,
  type SessionCanonicalEventDto,
  type SessionDataChannelEvent,
  type SessionDataCommitBatchRequest,
  type SessionDataCommitBatchResult,
  type SessionDataServiceV1,
  type SessionDataStreamIdentity,
  type SessionHarnessBindingDto,
  type SessionRecordDto,
  type SessionRunRecordDto,
  type SessionTurnReceiptDto,
  type SessionUsageAggregateDto,
  type SessionWorkspaceDto,
} from '@harnessmate/plugin-api';
import type {
  CanonicalEventType,
  ContextInjectionDriver,
  DiscoveredCliSession,
  PermissionMode,
  ReasoningEffort,
  Session,
  SessionRunStatus,
  TurnBlockRecord,
  TurnBlockStatus,
  Workspace,
} from '@harnessmate/protocol';
import type { HistoryImportAdapter } from '../../core/history-import-adapter.js';
import type { SessionChangeFeedService } from '../../core/session-change-feed.js';
import type { HarnessMateStore, SqlTransactionContext } from '../../db/sqlite.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';

export const SESSION_DATA_DEFAULT_PLUGIN_ID = 'hm.plugin.session-data-default';

export const SESSION_DATA_DEFAULT_MANIFEST: PluginManifest = {
  id: SESSION_DATA_DEFAULT_PLUGIN_ID,
  name: '默认会话数据插件 (SQLite)',
  version: '1.0.0',
  description: '负责工作区、会话、事件流、轮次块、运行记录、驱动续接绑定、导入事务与已提交变更流的默认持久化实现。',
  author: 'HarnessMate Core',
  category: 'workflow',
  provides: [SESSION_DATA_CONTRACT, LEGACY_SESSION_DATA_CONTRACT],
  contributes: {},
};

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'permission_denied' | 'not_found' | 'conflict' | 'plugin_disabled' | 'not_supported' | 'internal',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isSecretBlock(blockType: string, payload?: Record<string, unknown>): boolean {
  return blockType === 'secret_request' || (blockType === 'runtime_request' && payload?.kind === 'secret_request');
}

function toSessionDto(session: Session): SessionRecordDto {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    harnessId: session.harnessId,
    harnessKind: session.harnessKind,
    nativeSessionId: session.nativeSessionId,
    parentSessionId: session.parentSessionId ?? null,
    forkedFromTurnSeq: session.forkedFromTurnSeq ?? null,
    forkMode: session.forkMode === 'native'
      ? 'clean_fork'
      : session.forkMode === 'portable'
        ? 'with_context'
        : null,
    importMode: session.importMode ?? null,
    importSource: session.importSource ?? null,
    participatingHarnesses: session.participatingHarnesses ?? [session.harnessId],
    contextSyncMode: session.contextSyncMode ?? 'auto',
    cwd: session.cwd,
    worktreeBranch: session.worktreeBranch ?? null,
    title: session.title,
    status: session.status,
    model: session.model,
    actualModel: session.actualModel ?? null,
    modelReroutedReason: session.modelReroutedReason ?? null,
    reasoningEffort: session.reasoningEffort,
    permissionMode: session.permissionMode,
    lastSeq: session.lastSeq,
    usage: session.usage ? { ...session.usage } : null,
    pendingApprovalCount: session.pendingApprovalCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toWorkspaceDto(ws: Workspace): SessionWorkspaceDto {
  return {
    id: ws.id,
    name: ws.name,
    rootPath: ws.rootPath,
    isGitRepo: ws.isGitRepo,
    gitBranch: ws.gitBranch ?? null,
    createdAt: ws.createdAt,
  };
}

export interface DefaultSessionDataDeps {
  store: HarnessMateStore;
  historyImportAdapter: HistoryImportAdapter;
  changeFeed: SessionChangeFeedService;
}

export function createDefaultSessionDataPlugin(
  deps: DefaultSessionDataDeps,
): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  return {
    provides: [SESSION_DATA_CONTRACT, LEGACY_SESSION_DATA_CONTRACT],
    apply(ctx) {
      const instanceId = ctx.instanceId ?? SESSION_DATA_DEFAULT_PLUGIN_ID;
      const runId = randomUUID();
      const txAccess = deps.store.getSqlTransactionAccess();
      const streamIdentity: SessionDataStreamIdentity = {
        providerInstanceId: instanceId,
        streamId: 'sqlite-main',
        runId,
      };
      let active = true;
      let writable = true;

      const streamRef = (): SessionDataStreamIdentity => ({
        providerInstanceId: instanceId,
        streamId: 'sqlite-main',
        runId,
      });

      const assertActive = (): ServiceMethodResult<never> | null => {
        if (!active) {
          return peerErr('plugin_disabled', `默认会话数据插件 (${instanceId}) 已停用`);
        }
        return null;
      };

      const assertWritable = (): ServiceMethodResult<never> | null => {
        if (!active || !writable) {
          return peerErr('plugin_disabled', `默认会话数据插件 (${instanceId}) 当前不可写入或已停用`);
        }
        return null;
      };

      const publishChannel = (event: SessionDataChannelEvent) => {
        if (!active) return;
        try {
          ctx.services?.publish(SESSION_DATA_CONTRACT, event as unknown as Record<string, unknown>);
        } catch {
          // Do not break committed persistence if plugin is disposing simultaneously
        }
      };

      const recordChangeInTx = (
        tx: SqlTransactionContext,
        kind: 'upsert_item' | 'upsert_session' | 'delete_session' | 'delete_item',
        sessionId: string,
        workspaceId: string,
        itemId: string | null = null,
        payload?: Record<string, unknown>,
        committedAt = Date.now(),
      ): number => {
        const res = tx
          .prepare(
            `INSERT INTO session_change_log (kind, session_id, workspace_id, item_id, payload_json, committed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(kind, sessionId, workspaceId, itemId, payload ? JSON.stringify(payload) : null, committedAt);
        const seq = Number(res.lastInsertRowid);
        tx.markCommittedSeq(seq);
        return seq;
      };

      const upsertOwnerInTx = (
        tx: SqlTransactionContext,
        resourceType: 'workspace' | 'session',
        resourceId: string,
        workspaceId: string | null,
        updatedAt = Date.now(),
      ) => {
        tx.prepare(
          `INSERT INTO resource_owners (resource_type, resource_id, contract, instance_id, workspace_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource_type, resource_id, contract) DO UPDATE SET
             instance_id = excluded.instance_id,
             workspace_id = COALESCE(excluded.workspace_id, resource_owners.workspace_id),
             updated_at = excluded.updated_at`,
        ).run(resourceType, resourceId, SESSION_DATA_CONTRACT, instanceId, workspaceId, updatedAt);
      };

      const upsertBindingWithResets = (b: {
        sessionId: string;
        harnessId: string;
        harnessKind: string;
        nativeSessionId: string | null;
        lastModel?: string | null;
        lastActualModel?: string | null;
        lastEffort?: string | null;
        syncedUpToSeq: number;
        driverUsed?: string | null;
        updatedAt?: number;
      }) => {
        const saved = deps.store.upsertSessionBinding({
          sessionId: b.sessionId,
          harnessId: b.harnessId,
          harnessKind: b.harnessKind,
          nativeSessionId: b.nativeSessionId,
          lastModel: b.lastModel ?? null,
          lastActualModel: b.lastActualModel ?? null,
          lastEffort: (b.lastEffort as ReasoningEffort | null) ?? null,
          syncedUpToSeq: b.syncedUpToSeq,
          driverUsed: (b.driverUsed as ContextInjectionDriver | null) ?? null,
          updatedAt: b.updatedAt ?? Date.now(),
        });
        const exactPatch: Partial<{
          nativeSessionId: string | null;
          syncedUpToSeq: number;
          driverUsed: ContextInjectionDriver | null;
        }> = {};
        if (b.nativeSessionId === null) exactPatch.nativeSessionId = null;
        if (b.syncedUpToSeq === 0) exactPatch.syncedUpToSeq = 0;
        if (b.driverUsed === null) exactPatch.driverUsed = null;
        if (Object.keys(exactPatch).length > 0) {
          return deps.store.setSessionBindingExact(b.sessionId, b.harnessId, exactPatch) ?? saved;
        }
        return saved;
      };

      // Backfill ownership index on plugin activation without overwriting external owners
      txAccess.runImmediate((tx) => {
        const now = Date.now();
        const wsRows = tx.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>;
        for (const ws of wsRows) {
          tx.prepare(
            `INSERT OR IGNORE INTO resource_owners (resource_type, resource_id, contract, instance_id, workspace_id, updated_at)
             VALUES ('workspace', ?, ?, ?, ?, ?)`,
          ).run(ws.id, SESSION_DATA_CONTRACT, instanceId, ws.id, now);
        }
        const sessRows = tx.prepare('SELECT id, workspace_id FROM sessions').all() as Array<{
          id: string;
          workspace_id: string;
        }>;
        for (const sess of sessRows) {
          tx.prepare(
            `INSERT OR IGNORE INTO resource_owners (resource_type, resource_id, contract, instance_id, workspace_id, updated_at)
             VALUES ('session', ?, ?, ?, ?, ?)`,
          ).run(sess.id, SESSION_DATA_CONTRACT, instanceId, sess.workspace_id, now);
        }
      });

      const readLatestChangeSeq = (): number => deps.store.getLatestSessionChangeSeq();

      const dataService: SessionDataServiceV1 = {
        async getStreamInfo() {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk({
            stream: streamRef(),
            latestChangeSeq: readLatestChangeSeq(),
            writable,
          });
        },

        async listWorkspaces() {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk({
            workspaces: deps.store.listWorkspaces().map(toWorkspaceDto),
            stream: streamRef(),
          });
        },

        async getWorkspace(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const ws = deps.store.getWorkspace(req.workspaceId);
          return peerOk({ workspace: ws ? toWorkspaceDto(ws) : null });
        },

        async getWorkspaceByPath(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const ws = deps.store.getWorkspaceByPath(req.rootPath);
          return peerOk({ workspace: ws ? toWorkspaceDto(ws) : null });
        },

        async createWorkspace(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const outcome = txAccess.runImmediate((tx) => {
            const existing = deps.store.getWorkspaceByPath(req.rootPath);
            if (existing) {
              upsertOwnerInTx(tx, 'workspace', existing.id, existing.id);
              return { workspace: toWorkspaceDto(existing), created: false };
            }
            const now = req.createdAt ?? Date.now();
            const ws: Workspace = {
              id: req.id ?? randomUUID(),
              name: req.name,
              rootPath: req.rootPath,
              isGitRepo: Boolean(req.isGitRepo),
              gitBranch: req.gitBranch ?? null,
              createdAt: now,
            };
            deps.store.createWorkspace(ws);
            upsertOwnerInTx(tx, 'workspace', ws.id, ws.id, now);
            return { workspace: toWorkspaceDto(ws), created: true };
          });
          if (outcome.created) {
            publishChannel({
              kind: 'workspace_changed',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              workspaceId: outcome.workspace.id,
            });
          }
          return peerOk(outcome);
        },

        async updateWorkspaceGit(req) {
          const denied = assertWritable();
          if (denied) return denied;
          deps.store.updateWorkspaceGit(req.workspaceId, req.isGitRepo, req.gitBranch);
          const updated = deps.store.getWorkspace(req.workspaceId);
          if (updated) {
            publishChannel({
              kind: 'workspace_changed',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              workspaceId: updated.id,
            });
          }
          return peerOk({ workspace: updated ? toWorkspaceDto(updated) : null });
        },

        async deleteWorkspace(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const deleted = txAccess.runImmediate((tx) => {
            const sessions = tx
              .prepare('SELECT id FROM sessions WHERE workspace_id = ?')
              .all(req.workspaceId) as Array<{ id: string }>;
            const didDelete = deps.store.deleteWorkspace(req.workspaceId);
            if (didDelete) {
              tx.prepare('DELETE FROM resource_owners WHERE resource_type = ? AND resource_id = ? AND contract = ?')
                .run('workspace', req.workspaceId, SESSION_DATA_CONTRACT);
              for (const s of sessions) {
                tx.prepare('DELETE FROM resource_owners WHERE resource_type = ? AND resource_id = ? AND contract = ?')
                  .run('session', s.id, SESSION_DATA_CONTRACT);
              }
            }
            return didDelete;
          });
          if (deleted) {
            publishChannel({
              kind: 'workspace_changed',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              workspaceId: req.workspaceId,
            });
          }
          return peerOk({ deleted });
        },

        async listSessions(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk({
            sessions: deps.store.listSessions(req).map(toSessionDto),
            stream: streamRef(),
          });
        },

        async getSession(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const session = deps.store.getSession(req.sessionId);
          return peerOk({ session: session ? toSessionDto(session) : null });
        },

        async createSession(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const now = Date.now();
          const s = req.session;
          const sessionInput: Session = {
            id: s.id ?? randomUUID(),
            workspaceId: s.workspaceId,
            harnessId: s.harnessId,
            harnessKind: s.harnessKind,
            nativeSessionId: s.nativeSessionId ?? null,
            parentSessionId: s.parentSessionId ?? null,
            forkedFromTurnSeq: s.forkedFromTurnSeq ?? null,
            forkMode: s.forkMode === 'with_context' ? 'portable' : s.forkMode === 'clean_fork' ? 'native' : null,
            importMode: s.importMode ?? null,
            importSource: s.importSource ?? null,
            participatingHarnesses: s.participatingHarnesses ?? [s.harnessId],
            contextSyncMode: s.contextSyncMode ?? 'auto',
            cwd: s.cwd,
            worktreeBranch: s.worktreeBranch ?? null,
            title: s.title,
            status: (s.status as Session['status']) ?? 'idle',
            model: s.model ?? null,
            actualModel: s.actualModel ?? null,
            modelReroutedReason: s.modelReroutedReason ?? null,
            reasoningEffort: (s.reasoningEffort as ReasoningEffort | null) ?? null,
            permissionMode: s.permissionMode as PermissionMode,
            lastSeq: s.lastSeq ?? 0,
            usage: s.usage ?? null,
            pendingApprovalCount: s.pendingApprovalCount ?? 0,
            createdAt: s.createdAt ?? now,
            updatedAt: s.updatedAt ?? now,
          };
          const created = txAccess.runImmediate((tx) => {
            const out = deps.store.createSession(sessionInput);
            upsertOwnerInTx(tx, 'session', out.id, out.workspaceId, out.updatedAt);
            upsertOwnerInTx(tx, 'workspace', out.workspaceId, out.workspaceId, out.updatedAt);
            return out;
          });
          const latestSeq = readLatestChangeSeq();
          publishChannel({
            kind: 'session_changed',
            stream: streamRef(),
            changeSeq: latestSeq,
            sessionId: created.id,
            workspaceId: created.workspaceId,
          });
          return peerOk({
            session: toSessionDto(created),
            stream: streamRef(),
          });
        },

        async updateSession(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const updated = deps.store.updateSession(req.sessionId, {
            ...(req.patch.title !== undefined ? { title: req.patch.title } : {}),
            ...(req.patch.harnessId !== undefined ? { harnessId: req.patch.harnessId } : {}),
            ...(req.patch.harnessKind !== undefined ? { harnessKind: req.patch.harnessKind } : {}),
            ...(req.patch.nativeSessionId !== undefined ? { nativeSessionId: req.patch.nativeSessionId } : {}),
            ...(req.patch.participatingHarnesses !== undefined
              ? { participatingHarnesses: req.patch.participatingHarnesses }
              : {}),
            ...(req.patch.contextSyncMode !== undefined ? { contextSyncMode: req.patch.contextSyncMode } : {}),
            ...(req.patch.status !== undefined ? { status: req.patch.status as Session['status'] } : {}),
            ...(req.patch.model !== undefined ? { model: req.patch.model } : {}),
            ...(req.patch.actualModel !== undefined ? { actualModel: req.patch.actualModel } : {}),
            ...(req.patch.modelReroutedReason !== undefined
              ? { modelReroutedReason: req.patch.modelReroutedReason }
              : {}),
            ...(req.patch.reasoningEffort !== undefined
              ? { reasoningEffort: req.patch.reasoningEffort as ReasoningEffort | null }
              : {}),
            ...(req.patch.permissionMode !== undefined
              ? { permissionMode: req.patch.permissionMode as PermissionMode }
              : {}),
            ...(req.patch.usage !== undefined ? { usage: req.patch.usage } : {}),
          });
          if (updated) {
            publishChannel({
              kind: 'session_changed',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              sessionId: updated.id,
              workspaceId: updated.workspaceId,
            });
          }
          return peerOk({ session: updated ? toSessionDto(updated) : null });
        },

        async deleteSession(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const existing = deps.store.getSession(req.sessionId);
          const deleted = txAccess.runImmediate((tx) => {
            const didDelete = deps.store.deleteSession(req.sessionId);
            if (didDelete) {
              tx.prepare('DELETE FROM resource_owners WHERE resource_type = ? AND resource_id = ? AND contract = ?')
                .run('session', req.sessionId, SESSION_DATA_CONTRACT);
            }
            return didDelete;
          });
          if (deleted) {
            publishChannel({
              kind: 'session_deleted',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              sessionId: req.sessionId,
              ...(existing?.workspaceId ? { workspaceId: existing.workspaceId } : {}),
            });
          }
          return peerOk({ deleted });
        },

        async listEvents(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const afterSeq = typeof req.afterSeq === 'number' && Number.isFinite(req.afterSeq)
            ? Math.max(0, Math.floor(req.afterSeq))
            : 0;
          const throughSeq = typeof req.throughSeq === 'number' && Number.isFinite(req.throughSeq)
            ? Math.max(0, Math.floor(req.throughSeq))
            : undefined;
          const limit = typeof req.limit === 'number' && Number.isFinite(req.limit)
            ? Math.min(4000, Math.max(1, Math.floor(req.limit)))
            : 500;
          const raw = throughSeq !== undefined
            ? deps.store.getEventsInRange(req.sessionId, afterSeq, throughSeq, limit + 1)
            : deps.store.getEventsAfter(req.sessionId, afterSeq, limit + 1);
          const filtered = req.turnId ? raw.filter((e) => e.turnId === req.turnId) : raw;
          const hasMore = filtered.length > limit;
          const sliced = hasMore ? filtered.slice(0, limit) : filtered;
          const lastSeq = sliced.length > 0 ? sliced[sliced.length - 1]!.seq : afterSeq;
          return peerOk({
            sessionId: req.sessionId,
            stream: streamRef(),
            events: sliced.map((ev) => ({
              sessionId: ev.sessionId,
              seq: ev.seq,
              type: ev.type,
              turnId: ev.turnId,
              payload: ev.payload,
              createdAt: ev.createdAt,
            })),
            lastSeq,
            nextAfterSeq: hasMore && sliced.length > 0 ? sliced[sliced.length - 1]!.seq : null,
            hasMore,
          });
        },

        async appendEvent(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const session = deps.store.getSession(req.sessionId);
          if (!session) return peerErr('not_found', `会话不存在: ${req.sessionId}`);
          const ev = deps.store.appendEvent(
            req.sessionId,
            req.type as CanonicalEventType,
            req.payload ?? {},
            req.turnId ?? null,
            req.createdAt ?? Date.now(),
          );
          const dto: SessionCanonicalEventDto = {
            sessionId: ev.sessionId,
            seq: ev.seq,
            type: ev.type,
            turnId: ev.turnId,
            payload: ev.payload,
            createdAt: ev.createdAt,
          };
          publishChannel({
            kind: 'events_committed',
            stream: streamRef(),
            changeSeq: readLatestChangeSeq(),
            sessionId: session.id,
            workspaceId: session.workspaceId,
            events: [dto],
          });
          return peerOk({
            event: dto,
            stream: streamRef(),
          });
        },

        async listTurnItems(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const limit = typeof req.limit === 'number' && Number.isFinite(req.limit)
            ? Math.min(2000, Math.max(1, Math.floor(req.limit)))
            : 50;
          const raw = deps.store.listTurnItems(req.sessionId, {
            afterSeq: req.afterSeq,
            turnId: req.turnId,
            blockTypes: req.blockTypes,
            limit: 2000,
          });
          const filtered = req.beforeSeq !== undefined ? raw.filter((item) => item.seq < req.beforeSeq!) : raw;
          const sliced = filtered.slice(0, limit);
          const nextSeq = filtered.length > limit && sliced.length > 0 ? sliced[sliced.length - 1]!.seq : null;
          return peerOk({
            items: sliced,
            nextSeq,
            stream: streamRef(),
          });
        },

        async getTurnItem(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const item = deps.store.getTurnItem(req.itemId);
          if (!item) return peerOk(null);
          if (item.sessionId !== req.sessionId) {
            return peerErr('permission_denied', '无权读取其他会话的 TurnItem');
          }
          const offset = typeof req.textOffset === 'number' && Number.isFinite(req.textOffset)
            ? Math.max(0, Math.floor(req.textOffset))
            : 0;
          const maxChars = typeof req.maxChars === 'number' && Number.isFinite(req.maxChars)
            ? Math.min(64_000, Math.max(1, Math.floor(req.maxChars)))
            : Math.max(1, item.textBody.length || 1);
          const text = item.textBody.slice(offset, offset + maxChars);
          const nextTextOffset = offset + maxChars < item.textBody.length ? offset + maxChars : null;
          return peerOk({
            item,
            text,
            totalChars: item.textBody.length,
            textOffset: offset,
            nextTextOffset,
            hasMore: nextTextOffset !== null,
          });
        },

        async upsertTurnItem(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const saved = deps.store.upsertTurnItem(req.item as TurnBlockRecord);
          return peerOk({ item: saved });
        },

        async settleRunningTurnItems(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const settledCount = deps.store.settleRunningTurnItems(
            req.sessionId,
            req.status as TurnBlockStatus,
          );
          return peerOk({ settledCount });
        },

        async commitBatch(req: SessionDataCommitBatchRequest) {
          const denied = assertWritable();
          if (denied) return denied;
          const existingSession = deps.store.getSession(req.sessionId);
          if (!existingSession) {
            return peerErr('not_found', `会话不存在: ${req.sessionId}`);
          }

          const batchResult = txAccess.runImmediate((tx) => {
            const now = Date.now();
            if (req.sessionPatch && Object.keys(req.sessionPatch).length > 0) {
              deps.store.updateSession(req.sessionId, {
                ...(req.sessionPatch.title !== undefined ? { title: req.sessionPatch.title } : {}),
                ...(req.sessionPatch.harnessId !== undefined ? { harnessId: req.sessionPatch.harnessId } : {}),
                ...(req.sessionPatch.harnessKind !== undefined ? { harnessKind: req.sessionPatch.harnessKind } : {}),
                ...(req.sessionPatch.nativeSessionId !== undefined
                  ? { nativeSessionId: req.sessionPatch.nativeSessionId }
                  : {}),
                ...(req.sessionPatch.participatingHarnesses !== undefined
                  ? { participatingHarnesses: req.sessionPatch.participatingHarnesses }
                  : {}),
                ...(req.sessionPatch.contextSyncMode !== undefined
                  ? { contextSyncMode: req.sessionPatch.contextSyncMode }
                  : {}),
                ...(req.sessionPatch.status !== undefined
                  ? { status: req.sessionPatch.status as Session['status'] }
                  : {}),
                ...(req.sessionPatch.model !== undefined ? { model: req.sessionPatch.model } : {}),
                ...(req.sessionPatch.actualModel !== undefined ? { actualModel: req.sessionPatch.actualModel } : {}),
                ...(req.sessionPatch.modelReroutedReason !== undefined
                  ? { modelReroutedReason: req.sessionPatch.modelReroutedReason }
                  : {}),
                ...(req.sessionPatch.reasoningEffort !== undefined
                  ? { reasoningEffort: req.sessionPatch.reasoningEffort as ReasoningEffort | null }
                  : {}),
                ...(req.sessionPatch.permissionMode !== undefined
                  ? { permissionMode: req.sessionPatch.permissionMode as PermissionMode }
                  : {}),
                ...(req.sessionPatch.usage !== undefined ? { usage: req.sessionPatch.usage } : {}),
                updatedAt: now,
              });
              if (req.sessionPatch.worktreeBranch !== undefined || req.sessionPatch.cwd !== undefined) {
                const sets: string[] = [];
                const vals: Array<string | null | number> = [];
                if (req.sessionPatch.worktreeBranch !== undefined) {
                  sets.push('worktree_branch = ?');
                  vals.push(req.sessionPatch.worktreeBranch);
                }
                if (req.sessionPatch.cwd !== undefined) {
                  sets.push('cwd = ?');
                  vals.push(req.sessionPatch.cwd);
                }
                sets.push('updated_at = ?', );
                vals.push(now, req.sessionId);
                tx.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
              }
            }

            if (req.runStart) {
              deps.store.startSessionRun({
                runId: req.runStart.runId,
                sessionId: req.runStart.sessionId,
                turnId: req.runStart.turnId,
                instanceId: req.runStart.instanceId,
                driverId: req.runStart.driverId,
                model: req.runStart.model ?? null,
                status: req.runStart.status as SessionRunStatus,
                failureClass: req.runStart.failureClass ?? null,
                usage: req.runStart.usage ?? null,
                startedAt: req.runStart.startedAt,
                endedAt: req.runStart.endedAt ?? null,
              });
            }

            if (req.runFinish) {
              deps.store.finishSessionRun(req.runFinish.runId, {
                status: req.runFinish.status as SessionRunStatus,
                failureClass: req.runFinish.failureClass ?? null,
                usage: req.runFinish.usage ?? null,
                endedAt: req.runFinish.endedAt ?? now,
              });
            }

            if (req.bindingUpsert) {
              upsertBindingWithResets(req.bindingUpsert);
            }

            if (req.settleRunningItemsStatus) {
              deps.store.settleRunningTurnItems(
                req.sessionId,
                req.settleRunningItemsStatus as TurnBlockStatus,
              );
            }

            const committedEvents: SessionCanonicalEventDto[] = [];
            for (const evInput of req.events ?? []) {
              const appended = deps.store.appendEvent(
                req.sessionId,
                evInput.type as CanonicalEventType,
                evInput.payload ?? {},
                evInput.turnId ?? null,
                evInput.createdAt ?? now,
              );
              committedEvents.push({
                sessionId: appended.sessionId,
                seq: appended.seq,
                type: appended.type,
                turnId: appended.turnId,
                payload: appended.payload,
                createdAt: appended.createdAt,
              });
            }

            const latestSession = deps.store.getSession(req.sessionId)!;
            const fallbackSeq = committedEvents.length > 0
              ? committedEvents[committedEvents.length - 1]!.seq
              : latestSession.lastSeq;

            for (const itemInput of req.turnItems ?? []) {
              const payload = itemInput.payload ?? {};
              const seq = typeof itemInput.seq === 'number' ? itemInput.seq : fallbackSeq;
              deps.store.upsertTurnItem({
                ...(itemInput as Omit<TurnBlockRecord, 'sessionId' | 'seq'>),
                sessionId: req.sessionId,
                seq,
              });
              if (!isSecretBlock(itemInput.blockType, payload) && (itemInput.textBody ?? '').trim()) {
                try {
                  tx.prepare('DELETE FROM session_search_fts WHERE item_id = ?').run(itemInput.itemId);
                  tx.prepare(
                    `INSERT INTO session_search_fts (session_id, item_id, turn_id, driver_id, title, body)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                  ).run(
                    req.sessionId,
                    itemInput.itemId,
                    itemInput.turnId ?? '',
                    itemInput.driverId,
                    itemInput.title ?? '',
                    itemInput.textBody,
                  );
                } catch {
                  // FTS indexing best-effort inside commit
                }
              }
            }

            if (req.turnReceipt) {
              deps.store.upsertSessionTurnReceipt({
                sessionId: req.turnReceipt.sessionId,
                requestId: req.turnReceipt.requestId,
                requestHash: req.turnReceipt.requestHash,
                turnId: req.turnReceipt.turnId,
                runId: req.turnReceipt.runId,
                status: req.turnReceipt.status,
                runtimeInstanceId: req.turnReceipt.runtimeInstanceId,
                runtimeRunId: req.turnReceipt.runtimeRunId,
                createdAt: req.turnReceipt.createdAt,
                updatedAt: req.turnReceipt.updatedAt,
              });
            }

            const changeSeq = recordChangeInTx(
              tx,
              'upsert_session',
              latestSession.id,
              latestSession.workspaceId,
              null,
              {
                title: latestSession.title,
                status: latestSession.status,
                harnessId: latestSession.harnessId,
                lastSeq: latestSession.lastSeq,
              },
              now,
            );

            return {
              session: toSessionDto(latestSession),
              committedEvents,
              latestSeq: latestSession.lastSeq,
              changeSeq,
            };
          });

          const out: SessionDataCommitBatchResult = {
            stream: streamRef(),
            session: batchResult.session,
            committedEvents: batchResult.committedEvents,
            latestSeq: batchResult.latestSeq,
            changeSeq: batchResult.changeSeq,
          };

          publishChannel({
            kind: batchResult.committedEvents.length > 0 ? 'events_committed' : 'session_changed',
            stream: streamRef(),
            changeSeq: batchResult.changeSeq,
            sessionId: req.sessionId,
            workspaceId: batchResult.session.workspaceId,
            ...(batchResult.committedEvents.length > 0 ? { events: batchResult.committedEvents } : {}),
          });

          return peerOk(out);
        },

        async listSessionRuns(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const runs = deps.store.listSessionRuns(req.sessionId, req.limit ?? 100);
          return peerOk({
            runs: runs.map((r): SessionRunRecordDto => ({
              runId: r.runId,
              sessionId: r.sessionId,
              turnId: r.turnId,
              instanceId: r.instanceId,
              driverId: r.driverId,
              model: r.model ?? null,
              status: r.status,
              failureClass: r.failureClass ?? null,
              usage: r.usage ?? null,
              startedAt: r.startedAt,
              endedAt: r.endedAt ?? null,
            })),
          });
        },

        async startSessionRun(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const saved = deps.store.startSessionRun({
            runId: req.run.runId,
            sessionId: req.run.sessionId,
            turnId: req.run.turnId,
            instanceId: req.run.instanceId,
            driverId: req.run.driverId,
            model: req.run.model ?? null,
            status: req.run.status as SessionRunStatus,
            failureClass: req.run.failureClass ?? null,
            usage: req.run.usage ?? null,
            startedAt: req.run.startedAt,
            endedAt: req.run.endedAt ?? null,
          });
          return peerOk({
            run: {
              ...saved,
              endedAt: saved.endedAt ?? null,
            },
          });
        },

        async finishSessionRun(req) {
          const denied = assertWritable();
          if (denied) return denied;
          deps.store.finishSessionRun(req.runId, {
            status: req.status as SessionRunStatus,
            failureClass: req.failureClass ?? null,
            usage: req.usage ?? null,
            endedAt: req.endedAt ?? Date.now(),
          });
          return peerOk({ updated: true });
        },

        async getTurnReceipt(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const existing = deps.store.getSessionTurnReceipt(req.sessionId, req.requestId);
          return peerOk({ receipt: existing });
        },

        async recordTurnReceipt(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const existing = deps.store.getSessionTurnReceipt(req.receipt.sessionId, req.receipt.requestId);
          if (existing && existing.requestHash && req.receipt.requestHash && existing.requestHash !== req.receipt.requestHash) {
            return peerOk({ receipt: existing, conflict: true });
          }
          const saved = deps.store.upsertSessionTurnReceipt(req.receipt);
          return peerOk({ receipt: saved, conflict: false });
        },

        async getHarnessBinding(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const binding = deps.store.getSessionBinding(req.sessionId, req.harnessId);
          return peerOk({ binding });
        },

        async listHarnessBindings(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const bindings = deps.store.listSessionBindings(req.sessionId);
          return peerOk({ bindings });
        },

        async upsertHarnessBinding(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const saved = upsertBindingWithResets(req.binding);
          return peerOk({ binding: saved });
        },

        async readSearchSnapshot(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const snap = deps.changeFeed.readSearchSnapshot(req);
          return peerOk({
            snapshotId: snap.snapshotId,
            stream: streamRef(),
            watermarkSeq: snap.watermarkSeq,
            cursor: {
              providerInstanceId: instanceId,
              streamId: 'sqlite-main',
              seq: snap.watermarkSeq,
            },
            items: snap.items,
            nextCursor: snap.nextCursor,
          });
        },

        async readCommittedChanges(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          const res = deps.changeFeed.readCommittedChanges(req);
          return peerOk({
            stream: streamRef(),
            changes: res.changes,
            latestSeq: res.latestSeq,
            cursor: {
              providerInstanceId: instanceId,
              streamId: 'sqlite-main',
              seq: res.latestSeq,
            },
            hasMore: res.hasMore,
          });
        },

        async getUsageAggregatesByInstance() {
          const disabled = assertActive();
          if (disabled) return disabled;
          const map = deps.store.getUsageAggregatesByInstance();
          const aggregates: SessionUsageAggregateDto[] = [...map.values()].map((agg) => ({
            harnessId: agg.harnessId,
            instanceId: agg.instanceId,
            sessionCount: agg.sessionCount,
            inputTokens: agg.inputTokens,
            outputTokens: agg.outputTokens,
            cachedTokens: agg.cachedTokens,
            costUsd: agg.costUsd,
            dailyBuckets: agg.dailyBuckets.map((b) => ({
              date: b.date,
              inputTokens: b.tokens,
              outputTokens: 0,
              cachedTokens: 0,
              costUsd: 0,
            })),
          }));
          return peerOk({ aggregates });
        },

        async getLatestCompletedTurnSeq(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk({ seq: deps.store.getLatestCompletedTurnSeq(req.sessionId) });
        },

        async lookupNativeMapping(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk(deps.historyImportAdapter.lookupNativeMapping(req));
        },

        async lookupReceipt(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk(deps.historyImportAdapter.lookupReceipt(req));
        },

        async resolveTargetWorkspace(req) {
          const disabled = assertActive();
          if (disabled) return disabled;
          return peerOk(deps.historyImportAdapter.resolveTargetWorkspace(req));
        },

        async commitNativeImport(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const res = await deps.historyImportAdapter.commitNativeImport({
            requestId: req.requestId,
            requestHash: req.requestHash,
            ref: req.ref,
            mode: req.mode,
            compatLegacySources: req.compatLegacySources,
            legacySource: req.legacySource,
            sourcePath: req.sourcePath,
            title: req.title,
            harnessKind: req.harnessKind,
            cwd: req.cwd,
            workspaceId: req.workspaceId,
            updatedAt: req.updatedAt,
            items: req.items,
            partial: req.partial,
            warnings: req.warnings,
            lockWarning: req.lockWarning,
            truncatedReason: req.truncatedReason,
          });
          if (res.ok) {
            const imported = deps.store.getSession(res.value.sessionId);
            if (imported) {
              txAccess.runImmediate((tx) => {
                upsertOwnerInTx(tx, 'session', imported.id, imported.workspaceId);
                upsertOwnerInTx(tx, 'workspace', imported.workspaceId, imported.workspaceId);
              });
              publishChannel({
                kind: 'session_changed',
                stream: streamRef(),
                changeSeq: readLatestChangeSeq(),
                sessionId: imported.id,
                workspaceId: imported.workspaceId,
              });
            }
          }
          return res;
        },

        async commitBundleImport(req) {
          const denied = assertWritable();
          if (denied) return denied;
          const res = await deps.historyImportAdapter.commitBundleImport({
            requestId: req.requestId,
            requestHash: req.requestHash,
            bundle: req.bundle as unknown as Parameters<HistoryImportAdapter['commitBundleImport']>[0]['bundle'],
            workspaceId: req.workspaceId,
            titleOverride: req.titleOverride,
          });
          if (res.ok) {
            const imported = deps.store.getSession(res.value.sessionId);
            if (imported) {
              txAccess.runImmediate((tx) => {
                upsertOwnerInTx(tx, 'session', imported.id, imported.workspaceId);
                upsertOwnerInTx(tx, 'workspace', imported.workspaceId, imported.workspaceId);
              });
              publishChannel({
                kind: 'session_changed',
                stream: streamRef(),
                changeSeq: readLatestChangeSeq(),
                sessionId: imported.id,
                workspaceId: imported.workspaceId,
              });
            }
          }
          return res;
        },

        async recoverCrashState() {
          const denied = assertWritable();
          if (denied) return denied;
          const out = txAccess.runImmediate((tx) => {
            const now = Date.now();
            const runningSess = tx
              .prepare("SELECT id, workspace_id FROM sessions WHERE status IN ('running', 'awaiting_approval')")
              .all() as Array<{ id: string; workspace_id: string }>;
            const settledItems = deps.store.settleRunningTurnItems(undefined, 'interrupted');
            const runsRes = tx
              .prepare("UPDATE session_runs SET status = 'interrupted', failure_class = 'process_exit', ended_at = ? WHERE status = 'running'")
              .run(now);
            const recoveredRuns = Number(runsRes.changes);
            tx.prepare("UPDATE session_turn_receipts SET status = 'unknown', updated_at = ? WHERE status = 'running'")
              .run(now);
            for (const row of runningSess) {
              deps.store.updateSession(row.id, { status: 'error' });
            }
            if (runningSess.length > 0 || recoveredRuns > 0 || settledItems > 0) {
              const latestSeq = readLatestChangeSeq();
              tx.markCommittedSeq(latestSeq);
            }
            return { recoveredRuns, recoveredItems: settledItems, touchedSessions: runningSess };
          });
          for (const row of out.touchedSessions) {
            publishChannel({
              kind: 'session_changed',
              stream: streamRef(),
              changeSeq: readLatestChangeSeq(),
              sessionId: row.id,
              workspaceId: row.workspace_id,
            });
          }
          return peerOk({
            recoveredRuns: out.recoveredRuns,
            recoveredItems: out.recoveredItems,
          });
        },
      };

      const legacyCompatService: LegacySessionDataCompatServiceV1 = {
        lookupNativeMapping: (params) => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          return deps.historyImportAdapter.lookupNativeMapping(params);
        },
        lookupReceipt: (params) => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          return deps.historyImportAdapter.lookupReceipt(params);
        },
        resolveTargetWorkspace: (params) => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          return deps.historyImportAdapter.resolveTargetWorkspace(params);
        },
        listWorkspaces: () => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          return deps.store.listWorkspaces().map(toWorkspaceDto);
        },
        commitNativeImport: async (params) => {
          const res = await dataService.commitNativeImport(
            params as unknown as Parameters<SessionDataServiceV1['commitNativeImport']>[0],
          );
          return res;
        },
        commitBundleImport: async (params) => {
          const res = await dataService.commitBundleImport(
            params as unknown as Parameters<SessionDataServiceV1['commitBundleImport']>[0],
          );
          return res;
        },
        readSearchSnapshot: (req = {}) => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          const snap = deps.changeFeed.readSearchSnapshot(req);
          return {
            snapshotId: snap.snapshotId,
            stream: streamIdentity,
            watermarkSeq: snap.watermarkSeq,
            cursor: {
              providerInstanceId: instanceId,
              streamId: 'sqlite-main',
              seq: snap.watermarkSeq,
            },
            items: snap.items,
            nextCursor: snap.nextCursor,
          };
        },
        readCommittedChanges: (req = {}) => {
          const disabled = assertActive();
          if (disabled && !disabled.ok) throw new Error(disabled.error.message);
          const res = deps.changeFeed.readCommittedChanges(req);
          return {
            stream: streamIdentity,
            changes: res.changes,
            latestSeq: res.latestSeq,
            cursor: {
              providerInstanceId: instanceId,
              streamId: 'sqlite-main',
              seq: res.latestSeq,
            },
            hasMore: res.hasMore,
          };
        },
      };

      ctx.provide(SESSION_DATA_CONTRACT, dataService, {
        version: SESSION_DATA_CONTRACT_VERSION,
        metadata: {
          role: 'session-data',
          engine: 'sqlite',
          streamId: 'sqlite-main',
        },
      });
      ctx.provide(LEGACY_SESSION_DATA_CONTRACT, legacyCompatService, {
        version: LEGACY_SESSION_DATA_CONTRACT_VERSION,
        metadata: {
          role: 'session-data-adapter',
          engine: 'sqlite',
          compatFor: SESSION_DATA_CONTRACT,
        },
      });

      ctx.effect(() => () => {
        writable = false;
        active = false;
      });
    },
  };
}
