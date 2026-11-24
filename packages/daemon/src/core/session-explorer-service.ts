import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CanonicalEvent,
  DiscoveredCliSession,
  ForkSessionRequest,
  ForkSessionResult,
  ImportNativeSessionRequest,
  ImportSessionBundleRequest,
  MergeBackRequest,
  MergeBackResult,
  PortableSessionBundleV2,
  Session,
  SessionSearchResponse,
  SideChatMessage,
  SideChatPromoteRequest,
  SideChatRequest,
  TurnBlockRecord,
} from '@harnessmate/protocol';
import { PortableSessionBundleV2Schema } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import {
  clearScannerCache,
  findLocalSession,
  listNativeScanners,
  readJsonlHistoryDetailed,
  registerNativeScanner,
  scanLocalCliSessions,
  unregisterNativeScanner,
  type NativeSessionScanner,
} from '../harnesses/history-scanner.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import { redactHandoffTextSync } from './handoff-redactor.js';
import type { TaskLedgerService } from './task-ledger-service.js';

export interface SessionExplorerQueryOptions {
  q: string;
  workspaceId?: string;
  driverId?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
  offset?: number;
  forceLikeFallback?: boolean;
}

export interface SessionExplorerHooks {
  emitCanonical(
    sessionId: string,
    type: CanonicalEvent['type'],
    payload: Record<string, unknown>,
    turnId?: string | null,
  ): CanonicalEvent;
  createSession(req: {
    workspaceId: string;
    harnessId?: string;
    title?: string;
    model?: string | null;
    reasoningEffort?: Session['reasoningEffort'];
    permissionMode: Session['permissionMode'];
    nativeSessionId?: string | null;
    createWorktree?: boolean;
    worktreeBranch?: string;
    contextSyncMode?: Session['contextSyncMode'];
  }): Promise<Session>;
  addWorkspace(rootPath: string, name?: string): Promise<{ id: string; rootPath: string; name: string }>;
  tryNativeFork?: (session: Session, fromTurnSeq?: number) => Promise<string | null>;
  getTaskLedger?: () => TaskLedgerService | undefined;
  askSideChatModel?: (session: Session, prompt: string, harnessId?: string, model?: string | null) => Promise<string | null>;
  onSessionImported?: (session: Session, meta: Record<string, unknown>) => void;
}

const SECRET_RECEIPT_TEXT = '已安全提供凭据（内容已隐藏）';

/**
 * Redacts personal home paths (Windows `C:\Users\<user>\...`, macOS `/Users/<user>/...`, Linux `/home/<user>/...`)
 * in addition to secret tokens via `redactHandoffTextSync`.
 */
export function redactExportText(text: string): {
  text: string;
  redactedCount: number;
  categories: string[];
} {
  if (!text) return { text, redactedCount: 0, categories: [] };
  const secretPass = redactHandoffTextSync(text);
  let out = secretPass.text;
  let count = secretPass.redactedCount;
  const categories = new Set<string>(secretPass.categories);

  const pathPatterns: RegExp[] = [
    /[A-Za-z]:\\Users\\[^\\/\s"'`<>|]+/g,
    /[A-Za-z]:\/Users\/[^\\/\s"'`<>|]+/g,
    /\/Users\/[^/\s"'`<>|]+/g,
    /\/home\/[^/\s"'`<>|]+/g,
  ];
  const homeDir = os.homedir();
  if (homeDir && homeDir.length >= 4) {
    const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pathPatterns.unshift(new RegExp(escapedHome, 'gi'));
  }

  for (const pattern of pathPatterns) {
    pattern.lastIndex = 0;
    let matched = 0;
    out = out.replace(pattern, () => {
      matched += 1;
      return '<USER_HOME>';
    });
    if (matched > 0) {
      count += matched;
      categories.add('user_home_path');
    }
  }

  return { text: out, redactedCount: count, categories: [...categories] };
}

function redactUnknownDeep(
  value: unknown,
  stats: { count: number; categories: Set<string> },
): unknown {
  if (typeof value === 'string') {
    const res = redactExportText(value);
    stats.count += res.redactedCount;
    for (const c of res.categories) stats.categories.add(c);
    return res.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownDeep(item, stats));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Never export any accidental secret value key
      if (/^secretValue$/i.test(k)) {
        out[k] = '[REDACTED:secret_request]';
        stats.count += 1;
        stats.categories.add('secret_request');
        continue;
      }
      out[k] = redactUnknownDeep(v, stats);
    }
    return out;
  }
  return value;
}

function scrubSecretPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (/secretValue/i.test(k)) continue;
    if (k === 'approval' && v && typeof v === 'object') {
      const appr = { ...(v as Record<string, unknown>) };
      if (appr.kind === 'secret_request') {
        appr.comment = null;
        appr.input = {};
      }
      out[k] = appr;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class SessionExplorerService {
  private readonly sideChats = new Map<string, SideChatMessage[]>();
  private readonly indexQueue: Array<{
    sessionId: string;
    itemId: string;
    turnId: string | null;
    driverId: string;
    title: string;
    body: string;
  }> = [];
  private indexFlushScheduled = false;
  private backfillRunning = false;
  private disposed = false;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private hooks?: SessionExplorerHooks,
  ) {}

  attachHooks(hooks: SessionExplorerHooks): void {
    this.hooks = hooks;
  }

  dispose(): void {
    this.disposed = true;
    this.indexQueue.length = 0;
  }

  // ── FTS5 Global Search & Low-Priority Async Indexing ─────────────────

  query(opts: SessionExplorerQueryOptions): SessionSearchResponse {
    const start = Date.now();
    const { hits, fallbackUsed } = this.store.searchSessionFtsV2(opts);
    return {
      hits,
      fallbackUsed,
      tookMs: Math.max(0, Date.now() - start),
    };
  }

  /**
   * Queues an item for asynchronous FTS5 indexing on the next tick so hot streaming paths
   * (`*.delta`) and turn completion are never blocked by synchronous FTS writes.
   */
  enqueueIndexItem(entry: {
    sessionId: string;
    itemId: string;
    turnId: string | null;
    driverId: string;
    title: string;
    body: string;
  }): void {
    if (!entry.body.trim()) return;
    this.indexQueue.push(entry);
    if (!this.indexFlushScheduled && !this.disposed) {
      this.indexFlushScheduled = true;
      setImmediate(() => this.flushIndexQueue());
    }
  }

  flushIndexQueue(): number {
    this.indexFlushScheduled = false;
    let indexed = 0;
    while (this.indexQueue.length > 0 && !this.disposed) {
      const batch = this.indexQueue.splice(0, 20);
      for (const item of batch) {
        try {
          this.store.indexSearchItem(item);
          indexed += 1;
        } catch {
          // FTS indexing errors are isolated
        }
      }
      if (this.indexQueue.length > 0) {
        this.indexFlushScheduled = true;
        setImmediate(() => this.flushIndexQueue());
        break;
      }
    }
    return indexed;
  }

  indexSessionTurn(sessionId: string, turnId: string): number {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    const items = this.store.listTurnItems(sessionId, { turnId, limit: 100 });
    let queued = 0;
    for (const item of items) {
      if (item.blockType === 'secret_request') continue;
      if (
        item.blockType === 'runtime_request' &&
        (item.payload as { kind?: string })?.kind === 'secret_request'
      ) {
        continue;
      }
      const text = item.textBody?.trim();
      if (!text) continue;
      this.enqueueIndexItem({
        sessionId: session.id,
        itemId: item.itemId,
        turnId: item.turnId,
        driverId: item.driverId,
        title: session.title,
        body: text,
      });
      queued += 1;
    }
    return queued;
  }

  /**
   * Background low-priority backfill: indexes lagging `session_turn_items` in batches of 20,
   * yielding the event loop between batches so startup and active turns are never blocked.
   */
  async rebuildBacklogIndex(batchSize = 20): Promise<{ indexedCount: number }> {
    if (this.backfillRunning || this.disposed) {
      return { indexedCount: 0 };
    }
    this.backfillRunning = true;
    let totalIndexed = 0;
    try {
      while (!this.disposed) {
        const missing = this.store.listUnindexedTurnItems(batchSize);
        if (missing.length === 0) break;
        for (const item of missing) {
          try {
            this.store.indexSearchItem({
              sessionId: item.sessionId,
              itemId: item.itemId,
              turnId: item.turnId,
              driverId: item.driverId,
              title: item.sessionTitle,
              body: item.textBody,
            });
            totalIndexed += 1;
          } catch {
            // ignore corrupt single row
          }
        }
        // Yield event loop between batches
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.backfillRunning = false;
    }
    return { indexedCount: totalIndexed };
  }

  // ── External CLI Discovery, Custom Scanners & Safe Import ────────────

  registerScanner(scanner: NativeSessionScanner): () => void {
    return registerNativeScanner(scanner);
  }

  unregisterScanner(scannerId: string): boolean {
    return unregisterNativeScanner(scannerId);
  }

  listScanners(): NativeSessionScanner[] {
    return listNativeScanners();
  }

  async discoverExternal(opts?: {
    limit?: number;
    forceRefresh?: boolean;
  }): Promise<{ sessions: DiscoveredCliSession[]; hasMore: boolean }> {
    const limit = Math.min(1000, Math.max(1, opts?.limit ?? 20));
    if (opts?.forceRefresh) clearScannerCache();
    const found = await scanLocalCliSessions(limit + 1, { forceRefresh: opts?.forceRefresh });
    const counts = new Map<string, number>();
    const sessions = found
      .filter((item) => {
        const source = item.scannerId ?? item.source ?? item.harnessKind;
        const count = (counts.get(source) ?? 0) + 1;
        counts.set(source, count);
        return count <= limit;
      })
      .map((item) => {
        const imported = item.source
          ? this.store.getImportedSession(item.source, item.nativeSessionId)
          : null;
        return {
          ...item,
          alreadyImportedSessionId: imported?.id ?? null,
        };
      });
    return {
      sessions,
      hasMore: limit < 1000 && found.length > sessions.length,
    };
  }

  async importExternal(
    req: ImportNativeSessionRequest,
    resolvedNative?: DiscoveredCliSession,
  ): Promise<{
    session: Session;
    partial: boolean;
    lockWarning?: string;
    mode: 'mirror' | 'attach';
  }> {
    const mode = req.mode ?? 'attach';
    if (mode === 'attach') {
      const existing = this.store.getImportedSession(req.source, req.nativeSessionId);
      if (existing) {
        return { session: existing, partial: false, mode };
      }
    }

    const kind =
      resolvedNative?.harnessKind ??
      (req.source.startsWith('codex_')
        ? 'codex'
        : req.source.startsWith('agy_')
          ? 'agy'
          : req.source.startsWith('claude_')
            ? 'claude'
            : 'acp');

    const native =
      resolvedNative ?? (await findLocalSession(kind, req.nativeSessionId, req.source, req.scannerId));
    if (!native) {
      throw new Error('找不到此原生会话');
    }

    const fallbackWs = req.workspaceId ? this.store.getWorkspace(req.workspaceId) : null;
    let hasLocalCwd = false;
    if (native.cwd && path.isAbsolute(native.cwd)) {
      try {
        hasLocalCwd = fs.statSync(native.cwd, { throwIfNoEntry: false })?.isDirectory() ?? false;
      } catch {
        hasLocalCwd = false;
      }
    }
    const cwd = hasLocalCwd ? native.cwd! : fallbackWs?.rootPath;
    if (!cwd) throw new Error('原工作目录不可用，请选择一个本地工作区');

    const adapter = this.registry.get(native.harnessKind) ?? this.registry.listAdapters()[0];
    if (!adapter) throw new Error('原生会话对应的 Harness 尚未注册');

    const readRes = await readJsonlHistoryDetailed(native);
    if (!readRes.messages.some((m) => m.text.trim())) {
      throw new Error('此会话没有可导入的文本消息');
    }

    const workspace = hasLocalCwd
      ? await (this.hooks
          ? this.hooks.addWorkspace(cwd)
          : Promise.resolve(this.store.getWorkspaceByPath(cwd) ?? this.store.createWorkspace({
              id: `ws_${crypto.randomBytes(6).toString('hex')}`,
              name: path.basename(cwd) || cwd,
              rootPath: cwd,
              isGitRepo: false,
              gitBranch: null,
              createdAt: Date.now(),
            })))
      : fallbackWs!;

    const now = Date.now();
    const sessionId = `sess_${crypto.randomBytes(6).toString('hex')}`;
    const lockWarning =
      mode === 'attach' && readRes.fileLockedWarning
        ? '检测到该原生会话文件刚刚被外部 CLI 写入，接管续跑可能触发并发写入竞争，建议先确认外部终端已退出或改用只读镜像模式。'
        : undefined;

    const sessionDraft: Session = {
      id: sessionId,
      workspaceId: workspace.id,
      harnessId: adapter.id,
      harnessKind: adapter.kind,
      nativeSessionId: mode === 'attach' ? native.nativeSessionId : null,
      importMode: mode,
      importSource: native.scannerId ?? native.source ?? req.source,
      participatingHarnesses: [adapter.id],
      contextSyncMode: 'auto',
      cwd: workspace.rootPath,
      worktreeBranch: null,
      title: mode === 'mirror' ? `[镜像] ${native.title}` : native.title,
      status: 'idle',
      model: null,
      actualModel: null,
      modelReroutedReason: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const attribution = {
      harnessId: adapter.id,
      harnessKind: adapter.kind,
      imported: true,
      importMode: mode,
      originalNativeSessionId: native.nativeSessionId,
    };
    const events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>> = [];
    const itemsToPersist: Array<Omit<TurnBlockRecord, 'sessionId' | 'seq'>> = [];

    let user: { text: string; timestamp?: number } | undefined;
    let assistant: string[] = [];
    let assistantTs: number | undefined;
    let turn = 0;

    const flush = () => {
      if (!user && !assistant.length) return;
      const turnId = `import_${++turn}`;
      const createdAt = user?.timestamp || assistantTs || native.updatedAt || now;
      if (user) {
        events.push({
          type: 'message.user',
          turnId,
          createdAt,
          payload: { ...attribution, text: user.text },
        });
        itemsToPersist.push({
          itemId: `${sessionId}:${turnId}:user`,
          schemaVersion: 2,
          turnId,
          instanceId: adapter.id,
          driverId: adapter.kind,
          blockType: 'user_message',
          status: 'completed',
          title: 'User',
          textBody: user.text,
          payload: { imported: true },
          outputOmitted: false,
          omittedBytes: 0,
          createdAt,
          updatedAt: createdAt,
        });
      }
      if (assistant.length) {
        const joined = assistant.join('\n\n');
        const ts = assistantTs || createdAt;
        events.push({
          type: 'message.assistant.completed',
          turnId,
          createdAt: ts,
          payload: { ...attribution, text: joined },
        });
        itemsToPersist.push({
          itemId: `${sessionId}:${turnId}:assistant`,
          schemaVersion: 2,
          turnId,
          instanceId: adapter.id,
          driverId: adapter.kind,
          blockType: 'assistant_text',
          status: 'completed',
          title: 'Assistant',
          textBody: joined,
          payload: { imported: true },
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: ts,
          updatedAt: ts,
        });
      }
      events.push({
        type: 'turn.completed',
        turnId,
        createdAt: assistantTs || createdAt,
        payload: { ...attribution, stopReason: 'imported_history' },
      });
      user = undefined;
      assistant = [];
      assistantTs = undefined;
    };

    for (const msg of readRes.messages) {
      if (!msg.text.trim()) continue;
      if (msg.role === 'user') {
        flush();
        user = msg;
      } else {
        assistant.push(msg.text);
        assistantTs = msg.timestamp || assistantTs;
      }
    }
    flush();

    let created: Session;
    if (mode === 'attach') {
      created = this.store.importSession(sessionDraft, req.source, native.sourcePath, events);
    } else {
      created = this.store.createSession(sessionDraft);
      for (const ev of events) {
        this.store.appendEvent(created.id, ev.type, ev.payload, ev.turnId);
      }
      created = this.store.getSession(created.id)!;
    }

    // Materialize TurnBlocks + FTS5 index
    let seqCursor = 1;
    for (const item of itemsToPersist) {
      const record: TurnBlockRecord = {
        ...item,
        sessionId: created.id,
        seq: seqCursor++,
      };
      this.store.upsertTurnItem(record);
      this.store.indexSearchItem({
        sessionId: created.id,
        itemId: record.itemId,
        turnId: record.turnId,
        driverId: record.driverId,
        title: created.title,
        body: record.textBody,
      });
    }

    if (readRes.partial || lockWarning) {
      const noticeParts: string[] = [];
      if (readRes.partial) {
        noticeParts.push(
          `外部历史文件存在截断或半截尾行（原因: ${readRes.truncatedReason ?? 'partial'}），已容错跳过并导入 ${readRes.messages.length} 条消息。`,
        );
      }
      if (lockWarning) noticeParts.push(lockWarning);
      const noticeText = noticeParts.join(' ');
      this.store.upsertTurnItem({
        itemId: `${created.id}:import_notice`,
        schemaVersion: 2,
        sessionId: created.id,
        turnId: 'import_notice',
        seq: seqCursor++,
        instanceId: adapter.id,
        driverId: adapter.kind,
        blockType: 'system_notice',
        status: 'completed',
        title: '导入提示',
        textBody: noticeText,
        payload: { partial: readRes.partial, truncatedReason: readRes.truncatedReason ?? null, lockWarning: lockWarning ?? null },
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    this.hooks?.onSessionImported?.(created, {
      source: req.source,
      scannerId: native.scannerId ?? req.scannerId ?? req.source,
      originalNativeSessionId: native.nativeSessionId,
      mode,
      partial: readRes.partial,
      messageCount: readRes.messages.length,
    });

    return {
      session: this.store.getSession(created.id)!,
      partial: readRes.partial,
      lockWarning,
      mode,
    };
  }

  // ── Session Fork & Merge Back ────────────────────────────────────────

  async forkSession(sessionId: string, req: ForkSessionRequest): Promise<ForkSessionResult> {
    const source = this.store.getSession(sessionId);
    if (!source) throw new Error(`Session not found: ${sessionId}`);

    const targetHarnessId = req.targetHarnessId || source.harnessId;
    const targetAdapter = this.registry.get(targetHarnessId);
    if (!targetAdapter) throw new Error(`Target harness not registered: ${targetHarnessId}`);

    const cutoffSeq = req.fromTurnSeq !== undefined ? Math.min(req.fromTurnSeq, source.lastSeq) : source.lastSeq;
    const sameHarness = targetAdapter.id === source.harnessId;
    const supportsNativeFork = Boolean(
      sameHarness &&
      source.nativeSessionId &&
      (targetAdapter.capabilitiesV2?.supportsNativeFork || targetAdapter.capabilities.sessionFork),
    );

    let forkedNativeId: string | null = null;
    let modeUsed: 'native' | 'portable' = 'portable';
    if (supportsNativeFork && this.hooks?.tryNativeFork) {
      try {
        forkedNativeId = await this.hooks.tryNativeFork(source, cutoffSeq);
        if (forkedNativeId) {
          modeUsed = 'native';
        }
      } catch {
        forkedNativeId = null;
        modeUsed = 'portable';
      }
    }

    const title = req.title?.trim() || `分支 · ${source.title}`;
    const notice =
      modeUsed === 'native'
        ? `已通过 ${targetAdapter.displayName} 原生分叉创建子会话（起点 seq #${cutoffSeq}）。`
        : `目标驱动 ${targetAdapter.displayName} 未启用原生分叉，已无缝降级为便携分叉（继承至 seq #${cutoffSeq} 的上下文与任务账本）。`;

    // Create child session (reusing SessionManager.createSession for optional worktree creation!)
    const createdBase = this.hooks
      ? await this.hooks.createSession({
          workspaceId: source.workspaceId,
          harnessId: targetAdapter.id,
          title,
          model: req.targetModel !== undefined ? req.targetModel : source.model,
          reasoningEffort: source.reasoningEffort,
          permissionMode: source.permissionMode,
          nativeSessionId: forkedNativeId,
          createWorktree: req.createWorktree,
          worktreeBranch: req.worktreeBranch,
          contextSyncMode: source.contextSyncMode,
        })
      : this.store.createSession({
          id: `sess_${crypto.randomBytes(6).toString('hex')}`,
          workspaceId: source.workspaceId,
          harnessId: targetAdapter.id,
          harnessKind: targetAdapter.kind,
          nativeSessionId: forkedNativeId,
          parentSessionId: source.id,
          forkedFromTurnSeq: cutoffSeq,
          forkMode: modeUsed,
          participatingHarnesses: [targetAdapter.id],
          contextSyncMode: source.contextSyncMode,
          cwd: source.cwd,
          worktreeBranch: null,
          title,
          status: 'idle',
          model: req.targetModel !== undefined ? req.targetModel : source.model,
          actualModel: null,
          modelReroutedReason: null,
          reasoningEffort: source.reasoningEffort,
          permissionMode: source.permissionMode,
          lastSeq: 0,
          usage: null,
          pendingApprovalCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

    // Persist parent linkage metadata on the child session
    this.store.updateSessionForkMeta(createdBase.id, {
      parentSessionId: source.id,
      forkedFromTurnSeq: cutoffSeq,
      forkMode: modeUsed,
    });

    // Clone events & turn items up to cutoffSeq (excluding any secret payloads)
    const sourceEvents = this.store.getEventsAfter(source.id, 0, 2000).filter((e) => e.seq <= cutoffSeq);
    for (const ev of sourceEvents) {
      if (ev.type === 'session.status') continue;
      this.store.appendEvent(createdBase.id, ev.type, scrubSecretPayload(ev.payload), ev.turnId);
    }

    const sourceItems = this.store.listTurnItems(source.id, { limit: 2000 }).filter((it) => it.seq <= cutoffSeq);
    for (const it of sourceItems) {
      const clonedItem: TurnBlockRecord = {
        ...it,
        itemId: `${createdBase.id}:fork:${it.itemId}`,
        sessionId: createdBase.id,
      };
      this.store.upsertTurnItem(clonedItem);
      if (clonedItem.textBody.trim() && clonedItem.blockType !== 'secret_request') {
        this.enqueueIndexItem({
          sessionId: createdBase.id,
          itemId: clonedItem.itemId,
          turnId: clonedItem.turnId,
          driverId: clonedItem.driverId,
          title,
          body: clonedItem.textBody,
        });
      }
    }

    // Clone Task State Ledger
    const sourceLedger = this.store.getTaskState(source.id);
    if (sourceLedger) {
      this.store.upsertTaskState({
        ...sourceLedger,
        sessionId: createdBase.id,
        updatedAt: Date.now(),
      });
    }

    // Inject fork provenance system notice
    const forkEv = this.hooks
      ? this.hooks.emitCanonical(createdBase.id, 'session.forked', {
          parentSessionId: source.id,
          forkedFromTurnSeq: cutoffSeq,
          modeUsed,
          notice,
          worktreeBranch: createdBase.worktreeBranch ?? null,
        })
      : this.store.appendEvent(createdBase.id, 'session.forked', {
          parentSessionId: source.id,
          forkedFromTurnSeq: cutoffSeq,
          modeUsed,
          notice,
          worktreeBranch: createdBase.worktreeBranch ?? null,
        });

    this.store.upsertTurnItem({
      itemId: `${createdBase.id}:fork_notice`,
      schemaVersion: 2,
      sessionId: createdBase.id,
      turnId: `fork_${forkEv.seq}`,
      seq: forkEv.seq,
      instanceId: targetAdapter.id,
      driverId: targetAdapter.kind,
      blockType: 'system_notice',
      status: 'completed',
      title: modeUsed === 'native' ? '原生会话分叉' : '便携会话分叉',
      textBody: notice,
      payload: {
        parentSessionId: source.id,
        forkedFromTurnSeq: cutoffSeq,
        modeUsed,
      },
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: forkEv.createdAt,
      updatedAt: forkEv.createdAt,
    });

    const finalChild = this.store.getSession(createdBase.id)!;
    return {
      session: finalChild,
      modeUsed,
      notice,
      worktreePath: finalChild.worktreeBranch ? finalChild.cwd : null,
    };
  }

  mergeBack(childSessionId: string, req: MergeBackRequest): MergeBackResult {
    const child = this.store.getSession(childSessionId);
    if (!child) throw new Error(`Child session not found: ${childSessionId}`);
    if (!child.parentSessionId) {
      throw new Error('该会话不是分叉子会话，无法执行合并回父会话 (merge_back)');
    }
    const parent = this.store.getSession(child.parentSessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${child.parentSessionId}`);
    }

    const forkCutoff = child.forkedFromTurnSeq ?? 0;
    const childItems = this.store.listTurnItems(child.id, { limit: 2000 });
    const deltaItems = childItems.filter(
      (it) =>
        !it.itemId.includes(':fork:') &&
        it.itemId !== `${child.id}:fork_notice` &&
        it.blockType !== 'system_notice',
    );
    const childEvents = this.store.getEventsAfter(child.id, 0, 2000);

    const userPrompts: string[] = [];
    const conclusions: string[] = [];
    for (const item of deltaItems) {
      if (item.blockType === 'user_message' && item.textBody.trim()) {
        userPrompts.push(item.textBody.trim().slice(0, 240));
      } else if (item.blockType === 'assistant_text' && item.textBody.trim()) {
        conclusions.push(item.textBody.trim().slice(0, 1200));
      }
    }
    if (userPrompts.length === 0 && conclusions.length === 0) {
      // Fallback to raw events after fork_notice / forkCutoff
      const forkNoticeIdx = childEvents.findIndex((e) => e.type === 'session.forked');
      const postEvents = forkNoticeIdx >= 0 ? childEvents.slice(forkNoticeIdx + 1) : childEvents.filter((e) => e.seq > forkCutoff);
      for (const ev of postEvents) {
        if (ev.type === 'message.user' && typeof ev.payload.text === 'string') {
          userPrompts.push(ev.payload.text.trim().slice(0, 240));
        } else if (ev.type === 'message.assistant.completed' && typeof ev.payload.text === 'string') {
          conclusions.push(ev.payload.text.trim().slice(0, 1200));
        }
      }
    }

    const childLedger = this.store.getTaskState(child.id);
    const parentLedger = this.store.getTaskState(parent.id);
    const parentFiles = new Set(parentLedger?.touchedFiles ?? []);
    const deltaTouchedFiles = (childLedger?.touchedFiles ?? []).filter((f) => !parentFiles.has(f));
    const deltaDecisions = (childLedger?.decisions ?? []).filter(
      (d) => !(parentLedger?.decisions ?? []).includes(d),
    );
    const deltaVerifications = (childLedger?.verifications ?? []).slice(-5);

    const lines: string[] = [
      `## 分叉子会话回流摘要 (fork_delta_summary)`,
      `- **来源分支**: ${child.title} (\`${child.id}\`, 引擎: \`${child.harnessId}\`)`,
      `- **分叉起点**: seq #${forkCutoff}`,
    ];
    if (req.summaryOverride?.trim()) {
      lines.push('', '### 审阅结论', req.summaryOverride.trim());
    } else {
      if (userPrompts.length > 0) {
        lines.push('', '### 分支探索目标', ...userPrompts.slice(-4).map((p) => `- ${p}`));
      }
      if (conclusions.length > 0) {
        lines.push('', '### 分支最终结论', conclusions[conclusions.length - 1]!);
      } else {
        lines.push('', '### 分支最终结论', '（子会话暂无新增助手回复）');
      }
    }
    if (req.includeTouchedFiles !== false && deltaTouchedFiles.length > 0) {
      lines.push('', '### 新增变更文件', ...deltaTouchedFiles.map((f) => `- \`${f}\``));
    }
    if (deltaDecisions.length > 0) {
      lines.push('', '### 新增决策', ...deltaDecisions.map((d) => `- ${d}`));
    }
    if (req.includeVerifications !== false && deltaVerifications.length > 0) {
      lines.push(
        '',
        '### 验证证据',
        ...deltaVerifications.map((v) => `- [${v.status}] \`${v.command}\`${v.summary ? ` — ${v.summary}` : ''}`),
      );
    }

    const forkDeltaSummary = lines.join('\n');

    const mergeEv = this.hooks
      ? this.hooks.emitCanonical(parent.id, 'session.merged_back', {
          parentSessionId: parent.id,
          childSessionId: child.id,
          childTitle: child.title,
          forkDeltaSummary,
          touchedFiles: deltaTouchedFiles,
        })
      : this.store.appendEvent(parent.id, 'session.merged_back', {
          parentSessionId: parent.id,
          childSessionId: child.id,
          childTitle: child.title,
          forkDeltaSummary,
          touchedFiles: deltaTouchedFiles,
        });

    const itemId = `${parent.id}:merge_back:${child.id}:${mergeEv.seq}`;
    this.store.upsertTurnItem({
      itemId,
      schemaVersion: 2,
      sessionId: parent.id,
      turnId: `merge_${mergeEv.seq}`,
      seq: mergeEv.seq,
      instanceId: child.harnessId,
      driverId: child.harnessKind,
      blockType: 'handoff_card',
      status: 'completed',
      title: `分叉回流 · ${child.title}`,
      textBody: forkDeltaSummary,
      payload: {
        kind: 'fork_delta_summary',
        parentSessionId: parent.id,
        childSessionId: child.id,
        childTitle: child.title,
        driver: 'fork_merge_back',
        sourceHarnesses: [child.harnessId],
        touchedFiles: deltaTouchedFiles,
        accepted: true,
      },
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: mergeEv.createdAt,
      updatedAt: mergeEv.createdAt,
    });

    this.enqueueIndexItem({
      sessionId: parent.id,
      itemId,
      turnId: `merge_${mergeEv.seq}`,
      driverId: child.harnessKind,
      title: parent.title,
      body: forkDeltaSummary,
    });

    // Also update parent task ledger with newly touched files & decisions
    if (parentLedger && (deltaTouchedFiles.length > 0 || deltaDecisions.length > 0)) {
      this.store.upsertTaskState({
        ...parentLedger,
        touchedFiles: [...new Set([...parentLedger.touchedFiles, ...deltaTouchedFiles])],
        decisions: [...new Set([...parentLedger.decisions, ...deltaDecisions])],
        version: parentLedger.version + 1,
        updatedAt: Date.now(),
      });
    }

    return {
      parentSessionId: parent.id,
      childSessionId: child.id,
      forkDeltaSummary,
      itemId,
      eventSeq: mergeEv.seq,
      touchedFiles: deltaTouchedFiles,
    };
  }

  // ── Ephemeral Side Chat (Zero Main-Timeline Pollution) ───────────────

  getSideChat(sessionId: string): SideChatMessage[] {
    return [...(this.sideChats.get(sessionId) ?? [])];
  }

  clearSideChat(sessionId: string): void {
    this.sideChats.delete(sessionId);
  }

  async sendSideChat(
    sessionId: string,
    req: SideChatRequest,
  ): Promise<{ messages: SideChatMessage[]; reply: SideChatMessage }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const list = this.sideChats.get(sessionId) ?? [];
    const targetHarnessId = req.harnessId || session.harnessId;
    const now = Date.now();
    const userMsg: SideChatMessage = {
      id: `sc_${crypto.randomBytes(5).toString('hex')}`,
      role: 'user',
      text: req.text.trim(),
      harnessId: targetHarnessId,
      model: req.model ?? session.model,
      createdAt: now,
    };
    list.push(userMsg);

    const ledger = this.store.getTaskState(sessionId);
    const contextLines = [
      `[Side Chat Read-Only Context]`,
      `Workspace: ${session.cwd}`,
      ledger?.objective ? `Objective: ${ledger.objective}` : '',
      ledger?.touchedFiles.length ? `Touched Files: ${ledger.touchedFiles.slice(-8).join(', ')}` : '',
      ledger?.pinnedFacts.length ? `Pinned Constraints: ${ledger.pinnedFacts.join(' | ')}` : '',
      `Question: ${userMsg.text}`,
    ].filter(Boolean);

    let replyText: string | null = null;
    if (this.hooks?.askSideChatModel) {
      try {
        replyText = await this.hooks.askSideChatModel(
          session,
          contextLines.join('\n'),
          targetHarnessId,
          req.model,
        );
      } catch {
        replyText = null;
      }
    }

    if (!replyText) {
      const ctxSummary = [
        `工作区 \`${path.basename(session.cwd)}\``,
        ledger?.objective ? `当前目标「${ledger.objective}」` : null,
        ledger?.touchedFiles.length ? `近期改动 ${ledger.touchedFiles.length} 个文件` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      replyText = `（Side Chat 只读参考 · ${targetHarnessId}）已读取 ${ctxSummary || session.title} 的上下文，且未污染主会话时间线。针对「${userMsg.text.slice(0, 120)}」，可继续在此追问或点击「升级为正式分叉」以开启独立代码执行分支。`;
    }

    const assistantMsg: SideChatMessage = {
      id: `sc_${crypto.randomBytes(5).toString('hex')}`,
      role: 'assistant',
      text: replyText,
      harnessId: targetHarnessId,
      model: req.model ?? session.model,
      createdAt: Date.now(),
    };
    list.push(assistantMsg);
    this.sideChats.set(sessionId, list.slice(-40));
    return { messages: [...list], reply: assistantMsg };
  }

  async promoteSideChatToFork(
    sessionId: string,
    req?: SideChatPromoteRequest,
  ): Promise<ForkSessionResult> {
    const source = this.store.getSession(sessionId);
    if (!source) throw new Error(`Session not found: ${sessionId}`);
    const history = this.getSideChat(sessionId);

    const forked = await this.forkSession(sessionId, {
      title: req?.title || `侧栏升级 · ${source.title}`,
      targetHarnessId: req?.targetHarnessId,
      createWorktree: req?.createWorktree,
    });

    // Seed the promoted fork session with the Side Chat Q&A turns
    let idx = 0;
    for (const msg of history) {
      const turnId = `sidechat_${++idx}`;
      const ev = this.store.appendEvent(
        forked.session.id,
        msg.role === 'user' ? 'message.user' : 'message.assistant.completed',
        {
          text: msg.text,
          harnessId: msg.harnessId ?? forked.session.harnessId,
          promotedFromSideChat: true,
        },
        turnId,
      );
      this.store.upsertTurnItem({
        itemId: `${forked.session.id}:sidechat:${msg.id}`,
        schemaVersion: 2,
        sessionId: forked.session.id,
        turnId,
        seq: ev.seq,
        instanceId: msg.harnessId ?? forked.session.harnessId,
        driverId: forked.session.harnessKind,
        blockType: msg.role === 'user' ? 'user_message' : 'assistant_text',
        status: 'completed',
        title: msg.role === 'user' ? 'Side Chat User' : 'Side Chat Assistant',
        textBody: msg.text,
        payload: { promotedFromSideChat: true },
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: msg.createdAt,
        updatedAt: msg.createdAt,
      });
    }

    this.clearSideChat(sessionId);
    return {
      ...forked,
      session: this.store.getSession(forked.session.id)!,
    };
  }

  // ── Multi-Format Export (Markdown + Portable JSON Bundle v2) & Import ─

  exportSession(
    sessionId: string,
    format: 'markdown' | 'json_bundle',
    opts?: { redact?: boolean },
  ):
    | { format: 'markdown'; filename: string; markdown: string; redacted: boolean; redactedCount: number; redactionCategories: string[] }
    | { format: 'json_bundle'; filename: string; bundle: PortableSessionBundleV2 } {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const redact = Boolean(opts?.redact);
    const safeTitle = session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 48) || session.id;
    const events = this.store.getEventsAfter(sessionId, 0, 5000);
    const items = this.store.listTurnItems(sessionId, { limit: 5000 });
    const ledger = this.store.getTaskState(sessionId);

    if (format === 'markdown') {
      const stats = { count: 0, categories: new Set<string>() };
      const maybeRedact = (s: string) => {
        if (!redact) return s;
        const r = redactExportText(s);
        stats.count += r.redactedCount;
        for (const c of r.categories) stats.categories.add(c);
        return r.text;
      };

      const lines: string[] = [
        `# ${maybeRedact(session.title)}`,
        '',
        `- **Active Harness**: ${session.harnessId} (${session.harnessKind})`,
        `- **Collaborating Harnesses**: ${(session.participatingHarnesses ?? [session.harnessId]).join(', ')}`,
        `- **Model**: ${session.actualModel || session.model || 'default'}`,
        `- **Workspace**: \`${maybeRedact(session.cwd)}\``,
        `- **Redacted**: ${redact ? 'yes' : 'no'}`,
        `- **Exported**: ${new Date().toISOString()}`,
        '',
      ];
      if (ledger && (ledger.objective || ledger.steps.length > 0 || ledger.pinnedFacts.length > 0)) {
        const ledgerSvc = this.hooks?.getTaskLedger?.();
        if (ledgerSvc) {
          lines.push(maybeRedact(ledgerSvc.renderLedgerMarkdown(ledger, session)), '---', '');
        } else {
          lines.push(`## Objective\n\n${maybeRedact(ledger.objective)}`, '', '---', '');
        }
      } else {
        lines.push('---', '');
      }

      let assistantBuf = '';
      let currentActor = session.harnessId;
      const flushAssistant = () => {
        if (assistantBuf.trim()) {
          lines.push(`### Assistant (${currentActor})`, '', maybeRedact(assistantBuf.trim()), '');
          assistantBuf = '';
        }
      };

      for (const ev of events) {
        if (typeof ev.payload.harnessId === 'string') {
          currentActor = ev.payload.harnessId;
        }
        if (ev.type === 'message.user') {
          flushAssistant();
          lines.push('### User', '', maybeRedact(String(ev.payload.text ?? '')), '');
        } else if (ev.type === 'message.assistant.delta') {
          assistantBuf += String(ev.payload.text ?? '');
        } else if (ev.type === 'message.assistant.completed') {
          const t = String(ev.payload.text ?? '');
          if (t.length >= assistantBuf.length) assistantBuf = t;
        } else if (ev.type === 'tool.call.started') {
          flushAssistant();
          lines.push(`> **Tool**: \`${String(ev.payload.toolName ?? 'tool')}\` — ${maybeRedact(String(ev.payload.summary ?? ''))}`, '');
        } else if (ev.type === 'approval.resolved' && ev.payload.kind === 'secret_request') {
          flushAssistant();
          lines.push(`> **Secret Request**: ${SECRET_RECEIPT_TEXT}`, '');
        } else if (ev.type === 'session.merged_back') {
          flushAssistant();
          lines.push(maybeRedact(String(ev.payload.forkDeltaSummary ?? '')), '');
        } else if (ev.type === 'turn.completed') {
          flushAssistant();
        }
      }
      flushAssistant();

      return {
        format: 'markdown',
        filename: `${safeTitle}.md`,
        markdown: lines.join('\n'),
        redacted: redact,
        redactedCount: stats.count,
        redactionCategories: [...stats.categories],
      };
    }

    // Portable JSON Bundle v2
    const stats = { count: 0, categories: new Set<string>() };
    const cleanText = (s: string) => {
      if (!redact) return s;
      const r = redactExportText(s);
      stats.count += r.redactedCount;
      for (const c of r.categories) stats.categories.add(c);
      return r.text;
    };

    const sanitizedEvents = events.map((ev) => {
      const scrubbed = scrubSecretPayload(ev.payload);
      return {
        seq: ev.seq,
        type: ev.type,
        turnId: ev.turnId,
        createdAt: ev.createdAt,
        payload: (redact ? redactUnknownDeep(scrubbed, stats) : scrubbed) as Record<string, unknown>,
      };
    });

    const sanitizedItems: TurnBlockRecord[] = items.map((item) => {
      const isSecret =
        item.blockType === 'secret_request' ||
        (item.blockType === 'runtime_request' && (item.payload as { kind?: string })?.kind === 'secret_request');
      const baseText = isSecret ? SECRET_RECEIPT_TEXT : item.textBody;
      const basePayload = scrubSecretPayload(item.payload ?? {});
      return {
        ...item,
        title: cleanText(item.title),
        textBody: cleanText(baseText),
        payload: (redact ? redactUnknownDeep(basePayload, stats) : basePayload) as Record<string, unknown>,
      };
    });

    const sanitizedTaskState = ledger
      ? {
          objective: cleanText(ledger.objective),
          steps: ledger.steps.map((st) => ({ ...st, title: cleanText(st.title) })),
          decisions: ledger.decisions.map(cleanText),
          touchedFiles: ledger.touchedFiles.map(cleanText),
          verifications: ledger.verifications.map((v) => ({
            ...v,
            command: cleanText(v.command),
            summary: v.summary ? cleanText(v.summary) : undefined,
          })),
          blockers: ledger.blockers.map(cleanText),
          pinnedFacts: ledger.pinnedFacts.map(cleanText),
          ...(ledger.failedAttempts
            ? {
                failedAttempts: ledger.failedAttempts.map((fa) => ({
                  ...fa,
                  summary: cleanText(fa.summary),
                  failureReason: cleanText(fa.failureReason),
                })),
              }
            : {}),
          rollingSummary: cleanText(ledger.rollingSummary),
          summarizedUpToSeq: ledger.summarizedUpToSeq,
          version: ledger.version,
          ledgerFilePath: ledger.ledgerFilePath ? cleanText(ledger.ledgerFilePath) : null,
          updatedAt: ledger.updatedAt,
        }
      : null;

    const bundle: PortableSessionBundleV2 = {
      bundleVersion: 2,
      exportedAt: Date.now(),
      redacted: redact,
      redactionCategories: [...stats.categories],
      redactedCount: stats.count,
      session: {
        originalId: session.id,
        title: cleanText(session.title),
        harnessId: session.harnessId,
        harnessKind: session.harnessKind,
        model: session.model,
        actualModel: session.actualModel ?? null,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
        cwd: cleanText(session.cwd),
        participatingHarnesses: session.participatingHarnesses ?? [session.harnessId],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      taskState: sanitizedTaskState,
      items: sanitizedItems,
      events: sanitizedEvents,
    };

    return {
      format: 'json_bundle',
      filename: `${safeTitle}.bundle.v2.json`,
      bundle,
    };
  }

  async importSessionBundle(req: ImportSessionBundleRequest): Promise<Session> {
    const parsed = PortableSessionBundleV2Schema.parse(req.bundle);
    let workspace = req.workspaceId ? this.store.getWorkspace(req.workspaceId) : null;
    if (!workspace) {
      const existingList = this.store.listWorkspaces();
      workspace = existingList[0] ?? null;
    }
    if (!workspace) {
      const fallbackDir =
        parsed.session.cwd &&
        !parsed.session.cwd.includes('<USER_HOME>') &&
        fs.existsSync(parsed.session.cwd)
          ? parsed.session.cwd
          : os.tmpdir();
      workspace = this.store.createWorkspace({
        id: `ws_${crypto.randomBytes(6).toString('hex')}`,
        name: path.basename(fallbackDir) || 'imported-workspace',
        rootPath: fallbackDir,
        isGitRepo: false,
        gitBranch: null,
        createdAt: Date.now(),
      });
    }

    const adapter =
      this.registry.get(parsed.session.harnessId) ??
      this.registry.get(parsed.session.harnessKind) ??
      this.registry.listAdapters()[0];
    const harnessId = adapter?.id ?? parsed.session.harnessId;
    const harnessKind = adapter?.kind ?? parsed.session.harnessKind;
    const now = Date.now();
    const newSessionId = `sess_${crypto.randomBytes(6).toString('hex')}`;
    const title = req.titleOverride?.trim() || parsed.session.title;

    const created = this.store.createSession({
      id: newSessionId,
      workspaceId: workspace.id,
      harnessId,
      harnessKind,
      nativeSessionId: null,
      importMode: 'mirror',
      importSource: 'json_bundle_v2',
      participatingHarnesses: parsed.session.participatingHarnesses.length
        ? parsed.session.participatingHarnesses
        : [harnessId],
      contextSyncMode: 'auto',
      cwd: workspace.rootPath,
      worktreeBranch: null,
      title,
      status: 'idle',
      model: parsed.session.model ?? null,
      actualModel: parsed.session.actualModel ?? null,
      modelReroutedReason: null,
      reasoningEffort: parsed.session.reasoningEffort ?? null,
      permissionMode: parsed.session.permissionMode ?? 'manual',
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: parsed.session.createdAt || now,
      updatedAt: now,
    });

    // Restore events in exact order
    const sortedEvents = [...parsed.events].sort((a, b) => a.seq - b.seq);
    for (const ev of sortedEvents) {
      this.store.appendEvent(created.id, ev.type, scrubSecretPayload(ev.payload), ev.turnId);
    }

    // Restore TurnBlocks in exact order + index into FTS5
    const sortedItems = [...parsed.items].sort((a, b) => a.seq - b.seq);
    for (const item of sortedItems) {
      const restoredId = `${created.id}:restored:${item.itemId}`;
      const record: TurnBlockRecord = {
        ...item,
        itemId: restoredId,
        sessionId: created.id,
      };
      this.store.upsertTurnItem(record);
      if (record.textBody.trim() && record.blockType !== 'secret_request') {
        this.store.indexSearchItem({
          sessionId: created.id,
          itemId: record.itemId,
          turnId: record.turnId,
          driverId: record.driverId,
          title,
          body: record.textBody,
        });
      }
    }

    if (parsed.taskState) {
      this.store.upsertTaskState({
        ...parsed.taskState,
        sessionId: created.id,
        updatedAt: Date.now(),
      });
    }

    this.hooks?.emitCanonical(created.id, 'session.imported', {
      source: 'json_bundle_v2',
      originalSessionId: parsed.session.originalId,
      redacted: parsed.redacted,
      itemCount: sortedItems.length,
    });

    return this.store.getSession(created.id)!;
  }
}
