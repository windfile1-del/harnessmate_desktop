import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CanonicalEvent,
  HarnessKind,
  PortableSessionBundleV2,
  Session,
  TurnBlockRecord,
  Workspace,
} from '@harnessmate/protocol';
import { PortableSessionBundleV2Schema } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type {
  ReadCommittedChangesRequest,
  ReadSearchSnapshotRequest,
  SessionChangeFeedService,
} from './session-change-feed.js';

export interface HistoryRefDto {
  sourceInstanceId: string;
  sourceId: string;
  nativeSessionId: string;
}

export interface HistoryItemDto {
  itemId?: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

export interface CommitNativeImportParams {
  requestId: string;
  requestHash: string;
  ref: HistoryRefDto;
  mode: 'attach' | 'mirror';
  compatLegacySources?: string[];
  legacySource?: string;
  sourcePath?: string;
  title?: string;
  harnessKind?: string;
  cwd?: string | null;
  workspaceId?: string;
  updatedAt?: number;
  items: HistoryItemDto[];
  partial?: boolean;
  warnings?: string[];
  lockWarning?: string;
  truncatedReason?: string;
}

export interface CommitBundleImportParams {
  requestId: string;
  requestHash: string;
  bundle: PortableSessionBundleV2;
  workspaceId?: string;
  titleOverride?: string;
}

export interface HistoryImportCommitResult {
  sessionId: string;
  disposition: 'created' | 'reused';
  partial: boolean;
  warnings: string[];
  lockWarning?: string;
  mode: 'attach' | 'mirror';
}

export interface HistoryImportAdapterHooks {
  addWorkspace?: (rootPath: string, name?: string) => Promise<Workspace>;
  onSessionImported?: (session: Session, meta: Record<string, unknown>) => void;
}

const DEFAULT_LEGACY_SOURCE_MAP: Readonly<Record<string, readonly string[]>> = {
  'codex:default': ['codex_cli', 'codex_desktop'],
  'claude:default': ['claude_cli'],
  'agy_cli:default': ['agy_cli'],
  'agy_desktop:default': ['agy_desktop'],
  'custom:default': ['custom'],
  codex_cli: ['codex_cli'],
  codex_desktop: ['codex_desktop'],
  claude_cli: ['claude_cli'],
  agy_cli: ['agy_cli'],
  agy_desktop: ['agy_desktop'],
  pi_cli: ['pi_cli'],
  opencode_cli: ['opencode_cli'],
  custom: ['custom'],
};

const VALID_LEGACY_SOURCES = new Set([
  'codex_cli',
  'codex_desktop',
  'claude_cli',
  'agy_cli',
  'agy_desktop',
  'pi_cli',
  'opencode_cli',
  'custom',
]);

export function compatLegacySourcesForSourceId(
  sourceId: string,
  extra?: readonly string[],
): string[] {
  const out = new Set<string>(DEFAULT_LEGACY_SOURCE_MAP[sourceId] ?? []);
  if (VALID_LEGACY_SOURCES.has(sourceId)) {
    out.add(sourceId);
  }
  for (const item of extra ?? []) {
    if (typeof item === 'string' && VALID_LEGACY_SOURCES.has(item)) {
      out.add(item);
    }
  }
  return [...out];
}

export function resolveLegacySourceName(
  sourceId: string,
  explicitLegacySource?: string,
): string | undefined {
  if (explicitLegacySource && VALID_LEGACY_SOURCES.has(explicitLegacySource)) {
    return explicitLegacySource;
  }
  const defaults = DEFAULT_LEGACY_SOURCE_MAP[sourceId];
  if (defaults && defaults.length > 0) {
    return defaults[0];
  }
  return undefined;
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

function isExistingLocalDirectory(dirPath: string | null | undefined): dirPath is string {
  if (!dirPath || !path.isAbsolute(dirPath)) return false;
  try {
    return fs.statSync(dirPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function normalizeHarnessKind(raw: string | undefined): HarnessKind {
  if (raw === 'codex' || raw === 'claude' || raw === 'agy' || raw === 'acp') {
    return raw;
  }
  return 'acp';
}

function inferHarnessKindFromSourceId(sourceId: string): string {
  if (sourceId.startsWith('codex')) return 'codex';
  if (sourceId.startsWith('claude')) return 'claude';
  if (sourceId.startsWith('agy')) return 'agy';
  return 'acp';
}

/**
 * Narrow daemon-side transaction adapter for `history.import.v1` and `SessionChangeFeedService`.
 * Preserves legacy `sessions`, `session_events`, `session_turn_items`, and `native_history_imports`
 * semantics inside a single SQLite `BEGIN IMMEDIATE` transaction.
 */
export class HistoryImportAdapter {
  constructor(
    private readonly store: HarnessMateStore,
    private readonly registry: HarnessRegistry,
    private readonly changeFeed: SessionChangeFeedService,
    private hooks?: HistoryImportAdapterHooks,
  ) {}

  attachHooks(hooks: HistoryImportAdapterHooks): void {
    this.hooks = hooks;
  }

  listWorkspaces(): Workspace[] {
    return this.store.listWorkspaces();
  }

  lookupNativeMapping(params: {
    sourceId: string;
    nativeSessionId: string;
    compatLegacySources?: string[];
  }): { existingSessionId: string | null; matchedVia: 'mapping' | 'legacy' | null } {
    const compat = compatLegacySourcesForSourceId(params.sourceId, params.compatLegacySources);
    const found = this.store.getImportedSessionBySourceId(
      params.sourceId,
      params.nativeSessionId,
      compat,
    );
    if (!found) {
      return { existingSessionId: null, matchedVia: null };
    }
    return { existingSessionId: found.session.id, matchedVia: found.matchedVia };
  }

  lookupReceipt(params: {
    requestId: string;
    requestHash: string;
  }):
    | { found: false }
    | { found: true; conflict: true }
    | { found: true; conflict: false; result: HistoryImportCommitResult } {
    const receipt = this.store.getHistoryImportReceipt(params.requestId);
    if (!receipt) return { found: false };
    if (receipt.requestHash !== params.requestHash) {
      return { found: true, conflict: true };
    }
    const session = this.store.getSession(receipt.sessionId);
    if (!session) {
      return { found: false };
    }
    return {
      found: true,
      conflict: false,
      result: {
        sessionId: session.id,
        disposition: 'reused',
        partial: receipt.partial,
        warnings: receipt.warnings,
        mode: session.importMode ?? 'attach',
      },
    };
  }

  resolveTargetWorkspace(params: {
    kind: 'native' | 'bundle';
    workspaceId?: string;
    cwd?: string | null;
    bundleCwd?: string | null;
  }): {
    targetWorkspaceId: string | null;
    targetWorkspacePath: string | null;
    hasLocalCwd: boolean;
    importable: boolean;
    reason?: string;
  } {
    if (params.kind === 'bundle') {
      const explicit = params.workspaceId ? this.store.getWorkspace(params.workspaceId) : null;
      if (explicit) {
        return {
          targetWorkspaceId: explicit.id,
          targetWorkspacePath: explicit.rootPath,
          hasLocalCwd: false,
          importable: true,
        };
      }
      const first = this.store.listWorkspaces()[0] ?? null;
      if (first) {
        return {
          targetWorkspaceId: first.id,
          targetWorkspacePath: first.rootPath,
          hasLocalCwd: false,
          importable: true,
        };
      }
      const fallbackDir =
        params.bundleCwd &&
        !params.bundleCwd.includes('<USER_HOME>') &&
        isExistingLocalDirectory(params.bundleCwd)
          ? path.resolve(params.bundleCwd)
          : os.tmpdir();
      const existingByPath = this.store.getWorkspaceByPath(fallbackDir);
      return {
        targetWorkspaceId: existingByPath?.id ?? null,
        targetWorkspacePath: fallbackDir,
        hasLocalCwd: false,
        importable: true,
      };
    }

    if (isExistingLocalDirectory(params.cwd)) {
      const resolved = path.resolve(params.cwd);
      const existingByPath = this.store.getWorkspaceByPath(resolved);
      return {
        targetWorkspaceId: existingByPath?.id ?? null,
        targetWorkspacePath: resolved,
        hasLocalCwd: true,
        importable: true,
      };
    }

    const fallbackWs = params.workspaceId ? this.store.getWorkspace(params.workspaceId) : null;
    if (fallbackWs) {
      return {
        targetWorkspaceId: fallbackWs.id,
        targetWorkspacePath: fallbackWs.rootPath,
        hasLocalCwd: false,
        importable: true,
      };
    }

    return {
      targetWorkspaceId: null,
      targetWorkspacePath: null,
      hasLocalCwd: false,
      importable: false,
      reason: '原工作目录不可用，请选择一个本地工作区',
    };
  }

  async commitNativeImport(
    params: CommitNativeImportParams,
  ): Promise<
    | { ok: true; value: HistoryImportCommitResult }
    | { ok: false; error: { code: 'invalid_request' | 'not_importable' | 'conflict'; message: string } }
  > {
    const mode = params.mode ?? 'attach';
    const compatLegacySources = compatLegacySourcesForSourceId(
      params.ref.sourceId,
      params.compatLegacySources,
    );
    const nonEmptyItems = params.items.filter((item) => item.text.trim().length > 0);
    if (nonEmptyItems.length === 0) {
      return {
        ok: false,
        error: { code: 'not_importable', message: '此会话没有可导入的文本消息' },
      };
    }

    const wsResolution = this.resolveTargetWorkspace({
      kind: 'native',
      workspaceId: params.workspaceId,
      cwd: params.cwd,
    });
    if (!wsResolution.importable || !wsResolution.targetWorkspacePath) {
      return {
        ok: false,
        error: {
          code: 'not_importable',
          message: wsResolution.reason ?? '原工作目录不可用，请选择一个本地工作区',
        },
      };
    }

    const inferredKind = normalizeHarnessKind(
      params.harnessKind ?? inferHarnessKindFromSourceId(params.ref.sourceId),
    );
    const adapter = this.registry.get(inferredKind) ?? this.registry.listAdapters()[0];
    const harnessId = adapter?.id ?? inferredKind;
    const harnessKind = adapter?.kind ?? inferredKind;

    // Resolve or initialize workspace outside the SQLite write lock if git inspection hook is attached.
    let preResolvedWorkspace: Workspace | null = wsResolution.targetWorkspaceId
      ? this.store.getWorkspace(wsResolution.targetWorkspaceId)
      : this.store.getWorkspaceByPath(wsResolution.targetWorkspacePath);
    if (!preResolvedWorkspace && wsResolution.hasLocalCwd && this.hooks?.addWorkspace) {
      preResolvedWorkspace = await this.hooks.addWorkspace(wsResolution.targetWorkspacePath);
    }

    const warnings = [...(params.warnings ?? [])];
    const partial = Boolean(params.partial);
    const lockWarning = mode === 'attach' ? params.lockWarning : undefined;
    if (lockWarning && !warnings.includes(lockWarning)) {
      warnings.push(lockWarning);
    }

    const txOutcome = this.store.runInImmediateTransaction<{
      conflict?: boolean;
      result: HistoryImportCommitResult;
      createdSession?: Session;
    }>(() => {
      const existingReceipt = this.store.getHistoryImportReceipt(params.requestId);
      if (existingReceipt) {
        if (existingReceipt.requestHash !== params.requestHash) {
          return {
            conflict: true,
            result: {
              sessionId: existingReceipt.sessionId,
              disposition: 'reused',
              partial: existingReceipt.partial,
              warnings: existingReceipt.warnings,
              mode,
            },
          };
        }
        const receiptSession = this.store.getSession(existingReceipt.sessionId);
        if (receiptSession) {
          return {
            result: {
              sessionId: receiptSession.id,
              disposition: 'reused',
              partial: existingReceipt.partial,
              warnings: existingReceipt.warnings,
              mode: receiptSession.importMode ?? mode,
            },
          };
        }
      }

      if (mode === 'attach') {
        const existing = this.store.getImportedSessionBySourceId(
          params.ref.sourceId,
          params.ref.nativeSessionId,
          compatLegacySources,
        );
        if (existing) {
          if (existing.matchedVia === 'legacy') {
            this.store.upsertHistoryImportMapping({
              sourceId: params.ref.sourceId,
              nativeSessionId: params.ref.nativeSessionId,
              sessionId: existing.session.id,
              legacySource: resolveLegacySourceName(params.ref.sourceId, params.legacySource) ?? null,
              sourceInstanceId: params.ref.sourceInstanceId,
              sourcePath: params.sourcePath ?? null,
              harnessKind,
              createdAt: existing.session.createdAt,
            });
          }
          this.store.recordHistoryImportReceipt({
            requestId: params.requestId,
            requestHash: params.requestHash,
            sessionId: existing.session.id,
            disposition: 'reused',
            partial: false,
            warnings: [],
            createdAt: Date.now(),
          });
          return {
            result: {
              sessionId: existing.session.id,
              disposition: 'reused',
              partial: false,
              warnings: [],
              mode: 'attach',
            },
          };
        }
      }

      const workspace =
        preResolvedWorkspace ??
        this.store.getWorkspaceByPath(wsResolution.targetWorkspacePath!) ??
        this.store.createWorkspace({
          id: `ws_${crypto.randomBytes(6).toString('hex')}`,
          name: path.basename(wsResolution.targetWorkspacePath!) || wsResolution.targetWorkspacePath!,
          rootPath: wsResolution.targetWorkspacePath!,
          isGitRepo: false,
          gitBranch: null,
          createdAt: Date.now(),
        });

      const now = Date.now();
      const sessionId = `sess_${crypto.randomBytes(6).toString('hex')}`;
      const baseTitle = params.title?.trim() || `${harnessKind.toUpperCase()} · ${params.ref.nativeSessionId.slice(0, 12)}`;
      const legacySource = resolveLegacySourceName(params.ref.sourceId, params.legacySource);

      const sessionDraft: Session = {
        id: sessionId,
        workspaceId: workspace.id,
        harnessId,
        harnessKind,
        nativeSessionId: mode === 'attach' ? params.ref.nativeSessionId : null,
        importMode: mode,
        importSource: legacySource ?? params.ref.sourceId,
        participatingHarnesses: [harnessId],
        contextSyncMode: 'auto',
        cwd: workspace.rootPath,
        worktreeBranch: null,
        title: mode === 'mirror' ? `[镜像] ${baseTitle}` : baseTitle,
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
        harnessId,
        harnessKind,
        imported: true,
        importMode: mode,
        originalNativeSessionId: params.ref.nativeSessionId,
      };
      const events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>> = [];
      const itemsToPersist: Array<Omit<TurnBlockRecord, 'sessionId' | 'seq'>> = [];

      let user: HistoryItemDto | undefined;
      let assistant: string[] = [];
      let assistantTs: number | undefined;
      let turn = 0;

      const flush = () => {
        if (!user && !assistant.length) return;
        const turnId = `import_${++turn}`;
        const createdAt = user?.timestamp || assistantTs || params.updatedAt || now;
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
            instanceId: harnessId,
            driverId: harnessKind,
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
            instanceId: harnessId,
            driverId: harnessKind,
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

      for (const msg of nonEmptyItems) {
        if (msg.role === 'user') {
          flush();
          user = msg;
        } else {
          assistant.push(msg.text);
          assistantTs = msg.timestamp || assistantTs;
        }
      }
      flush();

      const created = this.store.createSession({ ...sessionDraft, lastSeq: events.length });
      this.store.insertEventsBatchInTx(created.id, events, 0);

      let seqCursor = 1;
      for (const item of itemsToPersist) {
        this.store.upsertTurnItem({
          ...item,
          sessionId: created.id,
          seq: seqCursor++,
        });
      }

      if (partial || lockWarning) {
        const noticeParts: string[] = [];
        if (partial) {
          noticeParts.push(
            `外部历史文件存在截断或半截尾行（原因: ${params.truncatedReason ?? 'partial'}），已容错跳过并导入 ${nonEmptyItems.length} 条消息。`,
          );
        }
        if (lockWarning) noticeParts.push(lockWarning);
        this.store.upsertTurnItem({
          itemId: `${created.id}:import_notice`,
          schemaVersion: 2,
          sessionId: created.id,
          turnId: 'import_notice',
          seq: seqCursor++,
          instanceId: harnessId,
          driverId: harnessKind,
          blockType: 'system_notice',
          status: 'completed',
          title: '导入提示',
          textBody: noticeParts.join(' '),
          payload: {
            partial,
            truncatedReason: params.truncatedReason ?? null,
            lockWarning: lockWarning ?? null,
          },
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (mode === 'attach') {
        this.store.upsertHistoryImportMapping({
          sourceId: params.ref.sourceId,
          nativeSessionId: params.ref.nativeSessionId,
          sessionId: created.id,
          legacySource: legacySource ?? null,
          sourceInstanceId: params.ref.sourceInstanceId,
          sourcePath: params.sourcePath ?? null,
          harnessKind,
          createdAt: now,
        });
        if (legacySource) {
          this.store.insertLegacyNativeImportIgnore(
            legacySource,
            params.ref.nativeSessionId,
            created.id,
            params.sourcePath ?? null,
          );
        }
      }

      this.store.recordHistoryImportReceipt({
        requestId: params.requestId,
        requestHash: params.requestHash,
        sessionId: created.id,
        disposition: 'created',
        partial,
        warnings,
        createdAt: now,
      });

      const finalSession = this.store.getSession(created.id)!;
      return {
        createdSession: finalSession,
        result: {
          sessionId: finalSession.id,
          disposition: 'created',
          partial,
          warnings,
          ...(lockWarning ? { lockWarning } : {}),
          mode,
        },
      };
    });

    if (txOutcome.conflict) {
      return {
        ok: false,
        error: { code: 'conflict', message: `requestId ${params.requestId} 已绑定到不同的导入请求` },
      };
    }

    if (txOutcome.createdSession) {
      this.hooks?.onSessionImported?.(txOutcome.createdSession, {
        source: params.legacySource ?? params.ref.sourceId,
        sourceId: params.ref.sourceId,
        sourceInstanceId: params.ref.sourceInstanceId,
        originalNativeSessionId: params.ref.nativeSessionId,
        mode,
        partial,
        messageCount: nonEmptyItems.length,
      });
    }

    return { ok: true, value: txOutcome.result };
  }

  commitBundleImport(
    params: CommitBundleImportParams,
  ):
    | { ok: true; value: HistoryImportCommitResult }
    | { ok: false; error: { code: 'invalid_request' | 'conflict'; message: string } } {
    const parsedCheck = PortableSessionBundleV2Schema.safeParse(params.bundle);
    if (!parsedCheck.success) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: parsedCheck.error.issues[0]?.message ?? 'Invalid session bundle payload',
        },
      };
    }
    const parsed = parsedCheck.data;

    const txOutcome = this.store.runInImmediateTransaction<{
      conflict?: boolean;
      result: HistoryImportCommitResult;
      createdSession?: Session;
      itemCount?: number;
    }>(() => {
      const existingReceipt = this.store.getHistoryImportReceipt(params.requestId);
      if (existingReceipt) {
        if (existingReceipt.requestHash !== params.requestHash) {
          return {
            conflict: true,
            result: {
              sessionId: existingReceipt.sessionId,
              disposition: 'reused',
              partial: existingReceipt.partial,
              warnings: existingReceipt.warnings,
              mode: 'mirror',
            },
          };
        }
        const existingSession = this.store.getSession(existingReceipt.sessionId);
        if (existingSession) {
          return {
            result: {
              sessionId: existingSession.id,
              disposition: 'reused',
              partial: existingReceipt.partial,
              warnings: existingReceipt.warnings,
              mode: 'mirror',
            },
          };
        }
      }

      const wsInfo = this.resolveTargetWorkspace({
        kind: 'bundle',
        workspaceId: params.workspaceId,
        bundleCwd: parsed.session.cwd,
      });
      let workspace = wsInfo.targetWorkspaceId ? this.store.getWorkspace(wsInfo.targetWorkspaceId) : null;
      if (!workspace) {
        const targetDir = wsInfo.targetWorkspacePath ?? os.tmpdir();
        workspace =
          this.store.getWorkspaceByPath(targetDir) ??
          this.store.createWorkspace({
            id: `ws_${crypto.randomBytes(6).toString('hex')}`,
            name: path.basename(targetDir) || 'imported-workspace',
            rootPath: targetDir,
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
      const title = params.titleOverride?.trim() || parsed.session.title;

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

      const sortedEvents = [...parsed.events].sort((a, b) => a.seq - b.seq);
      for (const ev of sortedEvents) {
        this.store.appendEvent(created.id, ev.type, scrubSecretPayload(ev.payload), ev.turnId);
      }

      const sortedItems = [...parsed.items].sort((a, b) => a.seq - b.seq);
      for (const item of sortedItems) {
        const restoredId = `${created.id}:restored:${item.itemId}`;
        this.store.upsertTurnItem({
          ...item,
          itemId: restoredId,
          sessionId: created.id,
        });
      }

      if (parsed.taskState) {
        this.store.upsertTaskState({
          ...parsed.taskState,
          sessionId: created.id,
          updatedAt: Date.now(),
        });
      }

      this.store.appendEvent(created.id, 'session.imported', {
        source: 'json_bundle_v2',
        originalSessionId: parsed.session.originalId,
        redacted: parsed.redacted,
        itemCount: sortedItems.length,
      });

      this.store.recordHistoryImportReceipt({
        requestId: params.requestId,
        requestHash: params.requestHash,
        sessionId: created.id,
        disposition: 'created',
        partial: false,
        warnings: [],
        createdAt: now,
      });

      const finalSession = this.store.getSession(created.id)!;
      return {
        createdSession: finalSession,
        itemCount: sortedItems.length,
        result: {
          sessionId: finalSession.id,
          disposition: 'created',
          partial: false,
          warnings: [],
          mode: 'mirror',
        },
      };
    });

    if (txOutcome.conflict) {
      return {
        ok: false,
        error: { code: 'conflict', message: `requestId ${params.requestId} 已绑定到不同的导入请求` },
      };
    }

    if (txOutcome.createdSession) {
      this.hooks?.onSessionImported?.(txOutcome.createdSession, {
        source: 'json_bundle_v2',
        originalSessionId: parsed.session.originalId,
        mode: 'mirror',
        itemCount: txOutcome.itemCount ?? 0,
      });
    }

    return { ok: true, value: txOutcome.result };
  }

  createHostService() {
    return {
      lookupNativeMapping: (params: {
        sourceId: string;
        nativeSessionId: string;
        compatLegacySources?: string[];
      }) => this.lookupNativeMapping(params),
      lookupReceipt: (params: { requestId: string; requestHash: string }) =>
        this.lookupReceipt(params),
      resolveTargetWorkspace: (params: {
        kind: 'native' | 'bundle';
        workspaceId?: string;
        cwd?: string | null;
        bundleCwd?: string | null;
      }) => this.resolveTargetWorkspace(params),
      listWorkspaces: () => this.listWorkspaces(),
      commitNativeImport: (params: CommitNativeImportParams) =>
        this.commitNativeImport(params),
      commitBundleImport: (params: CommitBundleImportParams) =>
        this.commitBundleImport(params),
      readSearchSnapshot: (req: ReadSearchSnapshotRequest = {}) =>
        this.changeFeed.readSearchSnapshot(req),
      readCommittedChanges: (req: ReadCommittedChangesRequest = {}) =>
        this.changeFeed.readCommittedChanges(req),
    };
  }
}
