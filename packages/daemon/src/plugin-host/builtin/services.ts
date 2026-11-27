import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonPersistedConfig } from '../../config.js';
import { type Attachment, type GitStatusSummary, type SessionCheckpointRecord } from '@harnessmate/protocol';
import {
  HARNESS_DRIVER_AGY_CONTRACT,
  HARNESS_DRIVER_CONTRACT,
  HARNESS_DRIVER_CONTRACT_VERSION,
  PEER_CONTRACTS,
  type GitCheckpointServiceV1,
  type GitWorkspaceServiceV1,
  type HandoffComposeEvent,
  type ServiceMethodResult,
  type SessionAttachmentsServiceV1,
  type TerminalRunnerServiceV1,
  type TerminalWorkspaceServiceV1,
  type WorkspaceFilesServiceV1,
  type WorkspaceRulesServiceV1,
} from '@harnessmate/plugin-api';
import {
  AttachmentService,
  discoverProjectRulesAndSkills,
  inferMimeType,
  readWorkspaceFilePreview,
  searchWorkspaceFiles,
} from '../../core/attachment-service.js';
import { WorkspaceTerminalRunner } from '../../core/terminal-service.js';
import { ApprovalCenterService } from '../../core/approval-center-service.js';
import { CheckpointError, CheckpointService } from '../../core/checkpoint-service.js';
import { resolveGitRepoLockKey } from '../../core/git-repo-lock.js';
import { toPublicGitStatusSummary } from '../../core/w1-service-helpers.js';
import type { FailoverCoordinator } from '../../core/failover-service.js';
import { HistoryImportAdapter } from '../../core/history-import-adapter.js';
import type { OrchestratorService } from '../../core/orchestrator-service.js';
import { SessionChangeFeedService } from '../../core/session-change-feed.js';
import type { SessionExplorerHooks } from '../../core/session-explorer-service.js';
import {
  SESSION_DATA_DEFAULT_PLUGIN_ID,
  createDefaultSessionDataPlugin,
} from '../../plugins/session-data-default/index.js';
import {
  SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
  createDefaultSessionRuntimePlugin,
  type SessionRuntimeDefaultController,
} from '../../plugins/session-runtime-default/index.js';
import {
  HARNESS_CODEX_PLUGIN_ID,
  createCodexDriverPlugin,
} from '../../plugins/harness-codex-default/index.js';
import {
  HARNESS_CLAUDE_PLUGIN_ID,
  createClaudeDriverPlugin,
} from '../../plugins/harness-claude-default/index.js';
import {
  HARNESS_ACP_PLUGIN_ID,
  createAcpDriverPlugin,
} from '../../plugins/harness-acp-default/index.js';
import {
  HARNESS_AGY_PLUGIN_ID,
  createAgyDriverPlugin,
} from '../../plugins/harness-agy-default/index.js';
import {
  SESSION_HANDOFF_DEFAULT_PLUGIN_ID,
  createSessionHandoffPlugin,
  handoffConfigSchema,
  handoffRedactionMap,
} from '../../plugins/session-handoff-default/index.js';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  createContextCompressionPlugin,
} from '../../plugins/context-compression-default/index.js';
import {
  SESSION_COLLABORATION_DEFAULT_PLUGIN_ID,
  createSessionCollaborationPlugin,
} from '../../plugins/session-collaboration-default/index.js';
import {
  ORCHESTRATOR_PLUGIN_ID,
  createOrchestratorPlugin,
} from '../../plugins/orchestrator-default/index.js';
import { createHostRuntimePorts } from '../../core/host-runtime-ports.js';
import type { AgyNativeFeatureFlags, NativeTurnSettlementSink } from '../../harnesses/agy/native/wiring/types.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { AgyAuthState } from '@harnessmate/protocol';
import { CommandOutputHub } from '../../core/command-output-hub.js';
import { DaemonEventBus } from '../../core/event-bus.js';
import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import {
  commitWorktreeChangesIfDirty,
  computeBranchDiffStat,
  createGitWorktree,
  deleteLocalBranch,
  discardFile,
  dryRunMerge,
  executeTrustedSetupScript,
  getFileDiff,
  getGitStatusSummary,
  getGitVersion,
  gitCommit,
  gitCreatePr,
  gitPull,
  gitPush,
  initGitRepo,
  inspectGitRepo,
  inspectSetupScript,
  listGitWorktrees,
  mergeBranchExplicit,
  removeGitWorktree,
  setSetupScriptTrust,
  workspaceTruthDigest,
} from '../../core/git-service.js';
import { HarnessCommandTools, listHarnessCommands } from '../../core/harness-commands.js';
import { registerSessionAssistance, type SessionAssistanceDependencies } from './session-assistance.js';
import { TerminalWorkspaceService } from '../../core/terminal-workspace-service.js';
import type { UsageService } from '../../core/usage-service.js';
import type { PluginCapabilities } from '../../plugins/plugin-capabilities.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import { createHarnessIntegrationPlugins, selectedHarnessService, usageContract } from './harness-integration.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../runtime/lifecycle.js';
import type { PluginEvents } from '../runtime/events.js';

export { handoffConfigSchema, handoffRedactionMap };

export const gitService = {
  status: getGitStatusSummary,
  inspect: inspectGitRepo,
  init: initGitRepo,
  version: getGitVersion,
  fileDiff: getFileDiff,
  discardFile,
  workspaceTruthDigest,
  worktree: createGitWorktree,
  createWorktree: createGitWorktree,
  listWorktrees: listGitWorktrees,
  removeWorktree: removeGitWorktree,
  dryRunMerge,
  commitWorktreeChangesIfDirty,
  computeBranchDiffStat,
  mergeBranchExplicit,
  deleteLocalBranch,
  inspectSetupScript,
  setSetupScriptTrust,
  executeTrustedSetupScript,
  commit: gitCommit,
  push: gitPush,
  pull: gitPull,
  createPr: gitCreatePr,
};
export type GitService = typeof gitService;

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr(err: unknown, fallbackCode = 'conflict'): ServiceMethodResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? String((err as { code: string }).code)
      : '';
  const codeMap: Record<string, string> = {
    E_NOT_FOUND: 'not_found',
    E_NOT_GIT_REPO: 'git_required',
    E_WORKTREE_BUSY: 'busy',
    E_SETUP_SCRIPT_UNTRUSTED: 'permission_denied',
    E_INVALID_INPUT: 'invalid_request',
    E_CHECKPOINT_NOT_FOUND: 'not_found',
    E_CHECKPOINT_MISSING: 'not_found',
    E_NATIVE_ROLLBACK_UNSUPPORTED: 'not_supported',
  };
  return { ok: false, error: { code: codeMap[rawCode] ?? (rawCode || fallbackCode), message } };
}

function createGitWorkspacePeerService(store: HarnessMateStore, instanceId = 'git'): GitWorkspaceServiceV1 {
  return {
    async getStatus(req) {
      const targetCwd = req.cwd || (req.sessionId ? store.getSession(req.sessionId)?.cwd : undefined) || (req.workspaceId ? store.getWorkspace(req.workspaceId)?.rootPath : undefined) || '';
      if (!targetCwd) {
        return peerOk({ available: false, reason: 'unavailable', instanceId, status: null });
      }
      try {
        const status = await getGitStatusSummary(targetCwd);
        const commonDirKey = status.isGitRepo ? await resolveGitRepoLockKey(targetCwd) : null;
        return peerOk({
          available: true,
          ...(status.isGitRepo ? {} : { reason: 'not_git_repo' as const }),
          instanceId,
          status: toPublicGitStatusSummary(
            targetCwd,
            status,
            commonDirKey?.replace(/^git:/, '') ?? null,
          ),
        });
      } catch (err) {
        return peerErr(err);
      }
    },
    async inspect(req) {
      try {
        const info = await inspectGitRepo(req.cwd);
        const commonDirKey = info.isGitRepo ? await resolveGitRepoLockKey(req.cwd) : null;
        return peerOk({
          isGitRepo: info.isGitRepo,
          branch: info.branch,
          repoRoot: info.isGitRepo ? req.cwd : null,
          gitCommonDir: commonDirKey?.replace(/^git:/, '') ?? null,
        });
      } catch (err) {
        return peerErr(err);
      }
    },
    async getFileDiff(req) {
      try {
        const staged = Boolean((req as { staged?: boolean }).staged);
        return peerOk((await getFileDiff(req.cwd, req.filePath, staged)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async getTruthDigest(req) {
      try {
        return peerOk((await workspaceTruthDigest(req.cwd)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async initRepo(req) {
      try {
        return peerOk((await initGitRepo(req.cwd)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async discardFile(req) {
      try {
        return peerOk((await discardFile(req.cwd, req.filePath)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async commit(req) {
      try {
        return peerOk((await gitCommit(req.cwd, req)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async push(req) {
      try {
        return peerOk((await gitPush(req.cwd, req)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async pull(req) {
      try {
        return peerOk((await gitPull(req.cwd, req)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async createPr(req) {
      try {
        return peerOk((await gitCreatePr(req.cwd, {
          title: req.title,
          body: req.body,
          base: req.baseBranch,
          draft: req.draft,
        })) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async listWorktrees(req) {
      try {
        const sessions = (req as { sessions?: Array<{ sessionId: string; cwd: string }> }).sessions
          ?? (req.workspaceId
            ? store.listSessions({ workspaceId: req.workspaceId, includeArchived: true }).map((s) => ({
                sessionId: s.id,
                cwd: s.cwd,
              }))
            : []);
        const worktrees = await listGitWorktrees(req.repoRoot, sessions);
        return peerOk({
          worktrees: worktrees.map((w) => ({
            path: w.path,
            branch: w.branch,
            headSha: w.headSha ?? '',
            isMain: w.isMain,
            dirtyCount: w.dirtyCount,
            isLocked: Boolean(w.locked),
            linkedSessionIds: w.linkedSessionIds,
          })),
        });
      } catch (err) {
        return peerErr(err);
      }
    },
    async createWorktree(req) {
      try {
        return peerOk(await createGitWorktree(req.repoRoot, req.branchName, { baseBranch: req.baseBranch }));
      } catch (err) {
        return peerErr(err);
      }
    },
    async removeWorktree(req) {
      try {
        return peerOk((await removeGitWorktree(req.repoRoot, req.worktreePath, { force: req.force })) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async dryRunMerge(req) {
      try {
        const r = req as { repoRoot: string; baseBranch?: string; targetBranch?: string; headBranch?: string; sourceBranch?: string };
        return peerOk((await dryRunMerge(
          r.repoRoot,
          r.baseBranch ?? r.targetBranch ?? 'main',
          r.headBranch ?? r.sourceBranch ?? '',
        )) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async getSetupScriptInfo(req) {
      try {
        return peerOk(inspectSetupScript(req.repoRoot, store));
      } catch (err) {
        return peerErr(err);
      }
    },
    async setSetupScriptTrust(req) {
      try {
        const current = inspectSetupScript(req.repoRoot, store);
        const expectedSha = (req as { expectedSha256?: string }).expectedSha256 ?? current.sha256 ?? '';
        return peerOk(setSetupScriptTrust(req.repoRoot, store, expectedSha, req.trusted));
      } catch (err) {
        return peerErr(err);
      }
    },
    async runSetupScript(req) {
      try {
        return peerOk((await executeTrustedSetupScript(req.repoRoot, req.targetDir, store)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
  };
}

function createGitCheckpointPeerService(store: HarnessMateStore, checkpointSvc: CheckpointService): GitCheckpointServiceV1 {
  return {
    async list(req) {
      return peerOk({ checkpoints: checkpointSvc.list(req.sessionId, req.limit) as unknown as Record<string, unknown>[] });
    },
    async get(req) {
      return peerOk({ checkpoint: (checkpointSvc.get(req.checkpointId) as unknown as Record<string, unknown> | null) });
    },
    async capture(req) {
      try {
        const rec = await checkpointSvc.capture({
          sessionId: req.sessionId,
          cwd: req.cwd,
          turnSeq: req.turnSeq,
          phase: req.phase as SessionCheckpointRecord['phase'],
          skipIfUnchangedFromTreeSha: (req as { skipIfUnchangedFromTreeSha?: string | null }).skipIfUnchangedFromTreeSha,
          compareAgainstTreeSha: (req as { compareAgainstTreeSha?: string | null }).compareAgainstTreeSha,
        });
        return peerOk({ checkpoint: rec as unknown as Record<string, unknown> | null });
      } catch (err) {
        return peerErr(err);
      }
    },
    async diff(req) {
      try {
        return peerOk((await checkpointSvc.diff(req)) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async revert(req) {
      try {
        const res = await checkpointSvc.revert({
          sessionId: req.sessionId,
          cwd: req.cwd,
          checkpointId: req.checkpointId,
          targetTurnSeq: (req as { targetTurnSeq?: number }).targetTurnSeq,
          mode: req.mode as 'native_and_files' | 'files_only' | 'fork_new_branch',
          hooks: { supportsNativeRollback: false },
        });
        return peerOk(res as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async gc(req) {
      try {
        return peerOk((await checkpointSvc.gcCheckpoints({
          sessionId: req.sessionId,
          cwd: req.cwd,
          keepLast: (req as { keepLast?: number; keepLatestTurns?: number }).keepLast ?? (req as { keepLatestTurns?: number }).keepLatestTurns,
          olderThanDays: (req as { olderThanDays?: number }).olderThanDays,
        })) as unknown as Record<string, unknown>);
      } catch (err) {
        return peerErr(err);
      }
    },
    async deleteSession(req) {
      try {
        const removed = store.deleteCheckpointRecords(req.sessionId);
        return peerOk({ removed });
      } catch (err) {
        return peerErr(err);
      }
    },
  };
}

async function lookupOptionalGitStatusFromCtx(
  ctx: { get<T>(name: string): T | undefined },
  cwd: string,
): Promise<GitStatusSummary | undefined> {
  try {
    const peer = ctx.get<GitWorkspaceServiceV1>(PEER_CONTRACTS.gitWorkspace);
    if (peer && typeof peer.getStatus === 'function') {
      const res = await peer.getStatus({ workspaceId: '', cwd });
      if (res && typeof res === 'object' && 'ok' in res && res.ok && res.value.available && res.value.status) {
        return res.value.status as unknown as GitStatusSummary;
      }
      return undefined;
    }
  } catch {
    // Graceful fallback when optional Git peer unavailable
  }
  try {
    return await ctx.get<GitService>('git')?.status(cwd);
  } catch {
    return undefined;
  }
}
export type NativeCommandsService = { list: typeof listHarnessCommands; tools: HarnessCommandTools };
export interface FailoverService {
  retryInput(sessionId: string): { text: string; attachments?: Attachment[] } | undefined;
  getPolicy?: FailoverCoordinator['getPolicy'];
  setPolicy?: FailoverCoordinator['setPolicy'];
  recordFailure?: FailoverCoordinator['recordFailure'];
  recommendFailover?: FailoverCoordinator['recommendFailover'];
  recordAutoSwitch?: FailoverCoordinator['recordAutoSwitch'];
  checkQuotaResets?: FailoverCoordinator['checkQuotaResets'];
}

export function createBuiltinPlugins(store: HarnessMateStore, registry: HarnessRegistry, config: DaemonPersistedConfig,
  assistance: Omit<SessionAssistanceDependencies, 'store'>,
  events: () => PluginEvents,
  overrides: readonly HarnessAdapter[] = [],
  collectIsolatedSections?: (event: HandoffComposeEvent) => Promise<Array<{ id: string; source: string; order: number; text: string }>>,
  terminalWorkspace?: TerminalWorkspaceService,
  agyProfilesDir?: string,
  historyImportAdapter?: HistoryImportAdapter,
  attachmentsDir?: string,
  getCapabilities?: () => PluginCapabilities,
  getPluginManager?: () => PluginManager,
  runtimeBridge?: {
    eventBus: import('../../core/event-bus.js').DaemonEventBus;
    changeFeed?: SessionChangeFeedService;
    commandOutputHub?: CommandOutputHub;
    initialNativeFeatureFlags?: Partial<AgyNativeFeatureFlags>;
    getSessionManager?: () => SessionManager | undefined;
    onConfigSave?: () => void;
    onAuthStateChanged?: (state: AgyAuthState) => void;
    onUsageCacheInvalidate?: (harnessId: string) => void;
    getPendingSettlementSink?: () => NativeTurnSettlementSink | undefined;
    getApprovalCenter?: () => ApprovalCenterService;
    getOrchestrator?: () => OrchestratorService | undefined;
    onAnnotatePendingApproval?: (session: Session, approval: ApprovalRequest) => Promise<void>;
    onAttachCompressorHooks?: () => void;
    onRuntimeControllerReady?: (controller: SessionRuntimeDefaultController | null) => void;
    emitCanonical?: (
      sessionId: string,
      type: import('@harnessmate/protocol').CanonicalEvent['type'],
      payload: Record<string, unknown>,
      turnId?: string | null,
    ) => import('@harnessmate/protocol').CanonicalEvent;
    createSession?: SessionExplorerHooks['createSession'];
    addWorkspace?: SessionExplorerHooks['addWorkspace'];
    tryNativeFork?: SessionExplorerHooks['tryNativeFork'];
    onSessionImported?: SessionExplorerHooks['onSessionImported'];
    sendTurn?: (
      sessionId: string,
      text: string,
      opts?: { omitHandoff?: boolean; literalText?: boolean },
    ) => Promise<{ turnId: string }>;
    interruptSession?: (sessionId: string) => Promise<void>;
    disposeSessionHandles?: (sessionId: string) => Promise<void>;
  }) {
  const resolvedAgyProfilesDir =
    agyProfilesDir ?? path.join(os.homedir(), '.harnessmate-desktop', 'agy-profiles');
  const plugins = new Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>>();
  plugins.set(
    HARNESS_CODEX_PLUGIN_ID,
    createCodexDriverPlugin({ registry, config, overrides }),
  );
  plugins.set(
    HARNESS_CLAUDE_PLUGIN_ID,
    createClaudeDriverPlugin({ registry, config, overrides }),
  );
  plugins.set(
    HARNESS_AGY_PLUGIN_ID,
    createAgyDriverPlugin({
      store,
      registry,
      config,
      profilesRootDir: resolvedAgyProfilesDir,
      overrides,
      initialNativeFeatureFlags: runtimeBridge?.initialNativeFeatureFlags,
      getSessionManager: runtimeBridge?.getSessionManager,
      getPluginManager,
      onConfigSave: runtimeBridge?.onConfigSave,
      onAuthStateChanged: runtimeBridge?.onAuthStateChanged,
      onUsageCacheInvalidate: runtimeBridge?.onUsageCacheInvalidate,
      getPendingSettlementSink: runtimeBridge?.getPendingSettlementSink,
    }),
  );
  plugins.set(
    HARNESS_ACP_PLUGIN_ID,
    createAcpDriverPlugin({ registry, config }),
  );
  plugins.set('core.git-inspector', {
    provides: [PEER_CONTRACTS.gitWorkspace, PEER_CONTRACTS.gitCheckpoint, 'git', 'checkpoints'],
    apply: (ctx) => {
      const checkpointSvc = new CheckpointService(store);
      const gitPeer = createGitWorkspacePeerService(store, ctx.instanceId ?? 'git');
      const ckptPeer = createGitCheckpointPeerService(store, checkpointSvc);
      ctx.provide('git', gitService);
      ctx.provide('checkpoints', checkpointSvc);
      ctx.provide(PEER_CONTRACTS.gitWorkspace, gitPeer, {
        version: '1.0.0',
        metadata: { title: 'Git Diff 与 Worktree 隔离插件' },
      });
      ctx.provide(PEER_CONTRACTS.gitCheckpoint, ckptPeer, {
        version: '1.0.0',
        metadata: { title: 'Git 检查点与原子回滚' },
      });
      ctx.routes?.register('/status', () => ({
        status: 200,
        body: { ok: true, instanceId: ctx.instanceId ?? 'core.git-inspector', pluginId: 'core.git-inspector' },
      }));
      ctx.routes?.register('/git-status', async (req) => ({
        status: 200,
        body: await gitPeer.getStatus(((req.body ?? req.query) as { workspaceId: string; sessionId?: string; cwd?: string })),
      }));
      ctx.routes?.register('/inspect', async (req) => ({
        status: 200,
        body: await gitPeer.inspect((req.body ?? req.query) as { cwd: string; workspaceId?: string }),
      }));
      ctx.routes?.register('/worktrees', async (req) => ({
        status: 200,
        body: await gitPeer.listWorktrees((req.body ?? req.query) as { repoRoot: string; workspaceId?: string }),
      }));
      ctx.routes?.register('/checkpoints', async (req) => ({
        status: 200,
        body: await ckptPeer.list((req.body ?? req.query) as { sessionId: string; limit?: number }),
      }));
    },
  });
  registerSessionAssistance(plugins, { ...assistance, store });
  plugins.set(
    SESSION_HANDOFF_DEFAULT_PLUGIN_ID,
    createSessionHandoffPlugin({
      store,
      registry,
      assistance,
      events,
      lookupGitStatus: (ctx, cwd) => lookupOptionalGitStatusFromCtx(ctx, cwd),
      collectIsolatedSections,
      getPluginManager,
    }),
  );
  for (const [id, plugin] of createHarnessIntegrationPlugins(store, registry, config.binaryOverrides, getCapabilities, getPluginManager)) {
    plugins.set(id, plugin);
  }
  plugins.set('core.harness-commands', {
    provides: ['native-commands'],
    apply(ctx) {
      ctx.provide('native-commands', {
        list: listHarnessCommands,
        tools: new HarnessCommandTools((session) => getPluginManager
          ? selectedHarnessService<UsageService>(getPluginManager(), usageContract, { sessionId: session.id })
          : ctx.get<UsageService>('usage'), config.binaryOverrides, registry),
      } satisfies NativeCommandsService);
    },
  });
  const resolvedChangeFeed = runtimeBridge?.changeFeed ?? new SessionChangeFeedService(store);
  const resolvedImportAdapter = historyImportAdapter
    ?? new HistoryImportAdapter(store, registry, resolvedChangeFeed);
  plugins.set(
    SESSION_DATA_DEFAULT_PLUGIN_ID,
    createDefaultSessionDataPlugin({
      store,
      historyImportAdapter: resolvedImportAdapter,
      changeFeed: resolvedChangeFeed,
    }),
  );
  if (runtimeBridge && getPluginManager) {
    const ports = createHostRuntimePorts({
      store,
      registry,
      eventBus: runtimeBridge.eventBus,
      getPluginManager,
      getPluginCapabilities: getCapabilities,
      getApprovalCenter: runtimeBridge.getApprovalCenter,
      getOrchestrator: runtimeBridge.getOrchestrator,
      onAnnotatePendingApproval: runtimeBridge.onAnnotatePendingApproval,
      onAttachCompressorHooks: runtimeBridge.onAttachCompressorHooks,
    });
    const hub = runtimeBridge.commandOutputHub ?? new CommandOutputHub();
    plugins.set(
      SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
      createDefaultSessionRuntimePlugin({
        getPluginManager,
        ...ports,
        commandOutputHub: hub,
        resolveHistorySourceMetadata: (sessionId, nativeSessionId) => {
          if (!nativeSessionId) return null;
          const meta = store.getNativeHistory(sessionId, nativeSessionId);
          return meta ? { source: meta.source, sourcePath: meta.sourcePath ?? undefined } : null;
        },
        onControllerReady: runtimeBridge.onRuntimeControllerReady,
      }),
    );
  } else {
    const bus = runtimeBridge?.eventBus ?? new DaemonEventBus();
    const hub = runtimeBridge?.commandOutputHub ?? new CommandOutputHub();
    const mgrGetter = getPluginManager ?? (() => {
      throw new Error('PluginManager is required by session-runtime-default');
    });
    const ports = createHostRuntimePorts({
      store,
      registry,
      eventBus: bus,
      getPluginManager: mgrGetter,
      getPluginCapabilities: getCapabilities,
    });
    plugins.set(
      SESSION_RUNTIME_DEFAULT_PLUGIN_ID,
      createDefaultSessionRuntimePlugin({
        getPluginManager: mgrGetter,
        ...ports,
        commandOutputHub: hub,
      }),
    );
  }
  plugins.set(
    SESSION_COLLABORATION_DEFAULT_PLUGIN_ID,
    createSessionCollaborationPlugin({
      store,
      registry,
      getPluginManager,
      bridge: {
        emitCanonical: runtimeBridge?.emitCanonical,
        createSession: runtimeBridge?.createSession,
        addWorkspace: runtimeBridge?.addWorkspace,
        tryNativeFork: runtimeBridge?.tryNativeFork,
        onSessionImported: runtimeBridge?.onSessionImported,
      },
    }),
  );
  plugins.set('hm.plugin.approval-center', {
    provides: ['approval-center'],
    apply(ctx) {
      const approvalCenter = new ApprovalCenterService(store);
      ctx.provide('approval-center', approvalCenter);
    },
  });
  plugins.set(
    ORCHESTRATOR_PLUGIN_ID,
    createOrchestratorPlugin({
      store,
      registry,
      getPluginManager,
      bridge: {
        emitCanonical: runtimeBridge?.emitCanonical,
        publishAttention: runtimeBridge?.eventBus
          ? (item) => runtimeBridge.eventBus.publishAttention(item)
          : undefined,
        sendTurn: runtimeBridge?.sendTurn,
        interruptSession: runtimeBridge?.interruptSession,
        disposeSessionHandles: runtimeBridge?.disposeSessionHandles,
      },
    }),
  );
  plugins.set(
    CONTEXT_COMPRESSION_PLUGIN_ID,
    createContextCompressionPlugin({
      store,
      registry,
      emitCanonical: runtimeBridge?.emitCanonical,
      getPluginManager,
    }),
  );
  plugins.set('core.terminal-runner', {
    provides: [
      PEER_CONTRACTS.terminalRunner,
      PEER_CONTRACTS.workspaceFiles,
      PEER_CONTRACTS.workspaceRules,
      'terminal',
      'files',
      'rules',
    ],
    apply(ctx) {
      const runner = new WorkspaceTerminalRunner();
      ctx.effect(() => () => {
        void runner.dispose().catch(() => {});
      });

      const runnerPeer: TerminalRunnerServiceV1 = {
        async run(req) {
          try {
            const res = await runner.run(req.cwd, req.command, req.timeoutMs);
            const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
            return peerOk({
              exitCode: res.exitCode,
              stdout: res.stdout,
              stderr: res.stderr,
              output: combined,
              durationMs: res.durationMs,
              timedOut: res.timedOut,
              backend: process.platform === 'win32' ? 'powershell' : 'sh',
            });
          } catch (err) {
            return peerErr(err);
          }
        },
      };

      const filesPeer: WorkspaceFilesServiceV1 = {
        async search(req) {
          try {
            const files = searchWorkspaceFiles(req.cwd, req.query ?? '', req.limit ?? 120);
            return peerOk({
              files: files.map((f) => ({
                ...f,
                path: f.fullPath,
              })),
            });
          } catch (err) {
            return peerErr(err);
          }
        },
        async read(req) {
          try {
            const preview = readWorkspaceFilePreview(req.cwd, req.path);
            return peerOk({
              ...preview,
              path: path.resolve(req.cwd, preview.relativePath),
              lineCount: preview.content ? preview.content.split(/\r?\n/).length : 0,
              isBinary: false,
              previewable: true,
            });
          } catch (err) {
            return peerErr(err, 'invalid_request');
          }
        },
      };

      ctx.provide('terminal', {
        runCommand: (req: { cwd: string; command: string; timeoutMs?: number }) =>
          runner.run(req.cwd, req.command, req.timeoutMs),
      });
      ctx.provide('files', {
        search: (cwd: string, query?: string, limit?: number) => searchWorkspaceFiles(cwd, query ?? '', limit ?? 120),
        read: (cwd: string, filePath: string) => readWorkspaceFilePreview(cwd, filePath),
      });
      ctx.provide(PEER_CONTRACTS.terminalRunner, runnerPeer, {
        version: '1.0.0',
        metadata: { title: '工作区单次命令执行器' },
      });
      ctx.provide(PEER_CONTRACTS.workspaceFiles, filesPeer, {
        version: '1.0.0',
        metadata: { title: '工作区文件搜索与读取' },
      });

      ctx.routes?.register('/status', () => ({
        status: 200,
        body: {
          ok: true,
          instanceId: ctx.instanceId ?? 'core.terminal-runner',
          activeCommands: runner.activeCount(),
        },
      }));
      ctx.routes?.register('/run', async (req) => ({
        status: 200,
        body: await runnerPeer.run((req.body ?? {}) as { cwd: string; command: string; timeoutMs?: number }),
      }));
      ctx.routes?.register('/files', async (req) => ({
        status: 200,
        body: await filesPeer.search((req.body ?? req.query) as { cwd: string; query?: string; limit?: number }),
      }));
      ctx.routes?.register('/file-read', async (req) => ({
        status: 200,
        body: await filesPeer.read((req.body ?? req.query) as { cwd: string; path: string }),
      }));
    },
  });

  plugins.set('core.workspace-rules', {
    provides: [PEER_CONTRACTS.workspaceRules, 'rules'],
    apply(ctx) {
      const rulesPeer: WorkspaceRulesServiceV1 = {
        async discover(req) {
          try {
            const instructions = discoverProjectRulesAndSkills(req.cwd);
            return peerOk({ instructions: instructions as unknown as Array<Record<string, unknown>> });
          } catch (err) {
            return peerErr(err);
          }
        },
      };

      ctx.provide('rules', {
        discoverRules: (cwd: string) => discoverProjectRulesAndSkills(cwd),
      });
      ctx.provide(PEER_CONTRACTS.workspaceRules, rulesPeer, {
        version: '1.0.0',
        metadata: { title: '项目规则与 Skills 发现' },
      });
      ctx.routes?.register('/status', () => ({
        status: 200,
        body: { ok: true, instanceId: ctx.instanceId ?? 'core.workspace-rules' },
      }));
      ctx.routes?.register('/rules', async (req) => ({
        status: 200,
        body: await rulesPeer.discover((req.body ?? req.query) as { cwd: string }),
      }));
    },
  });

  plugins.set('core.attachments', {
    provides: [PEER_CONTRACTS.sessionAttachments, 'attachments'],
    apply(ctx) {
      const baseRoot = attachmentsDir ?? path.join(os.tmpdir(), 'harnessmate-attachments');
      const instanceRoot =
        !ctx.instanceId || ctx.instanceId === 'core.attachments'
          ? baseRoot
          : path.join(baseRoot, '__instances', ctx.instanceId.replace(/[^a-z0-9._-]/gi, '_'));
      const svc = new AttachmentService(instanceRoot);

      const peer: SessionAttachmentsServiceV1 = {
        async save(req) {
          try {
            const isBase64 = Boolean(req.base64 && req.base64.trim());
            const attachment = svc.saveSessionAttachment(req.sessionId, {
              name: req.name,
              kind: req.mimeType.startsWith('image/') ? 'image' : 'file_ref',
              mimeType: req.mimeType,
              ...(isBase64 ? { dataBase64: req.base64 } : {}),
            });
            return peerOk({ attachment: attachment as unknown as Record<string, unknown> });
          } catch (err) {
            return peerErr(err);
          }
        },
        async resolveRead(req) {
          const resolved = svc.resolveAttachmentFile(req.sessionId, req.filename);
          if (!resolved) {
            return { ok: false, error: { code: 'not_found', message: 'Attachment not found' } };
          }
          const stat = fs.statSync(resolved);
          return peerOk({
            filePath: resolved,
            mimeType: inferMimeType(resolved),
            sizeBytes: stat.size,
            legacy: instanceRoot === baseRoot,
          });
        },
      };

      ctx.provide('attachments', svc);
      ctx.provide(PEER_CONTRACTS.sessionAttachments, peer, {
        version: '1.0.0',
        metadata: { title: '会话附件存储与流式读取', rootDir: instanceRoot },
      });
      ctx.routes?.register('/status', () => ({
        status: 200,
        body: { ok: true, instanceId: ctx.instanceId ?? 'core.attachments', rootDir: instanceRoot },
      }));
      ctx.routes?.register('/save', async (req) => ({
        status: 200,
        body: await peer.save((req.body ?? {}) as { sessionId: string; name: string; mimeType: string; base64: string }),
      }));
    },
  });

  plugins.set('hm.plugin.terminal-workspace', {
    provides: [PEER_CONTRACTS.terminalWorkspace, 'terminal-workspace'],
    apply(ctx) {
      const svc =
        ctx.instanceId === 'hm.plugin.terminal-workspace' && terminalWorkspace
          ? terminalWorkspace
          : new TerminalWorkspaceService(store);
      svc.attachGitService(() => ctx.get<GitService>('git'));
      svc.attachWorktreeLister(async (repoRoot) => {
        try {
          const peer = ctx.get<GitWorkspaceServiceV1>(PEER_CONTRACTS.gitWorkspace);
          if (peer && typeof peer.listWorktrees === 'function') {
            const res = await peer.listWorktrees({ repoRoot });
            if (res.ok) return res.value.worktrees.map((w) => ({ path: w.path }));
          }
        } catch {
          // Fall back to direct git service
        }
        const legacy = ctx.get<GitService>('git');
        if (legacy) {
          const list = await legacy.listWorktrees(repoRoot);
          return list.map((w) => ({ path: w.path }));
        }
        return [];
      });
      svc.setPluginActive(true);

      const peer: TerminalWorkspaceServiceV1 = {
        async listTerminals(req) {
          try {
            return peerOk({
              terminals: svc.listTerminals(req.workspaceId, req.cwd) as unknown as Record<string, unknown>[],
              ptyAvailable: svc.isPtyAvailable(),
            });
          } catch (err) {
            return peerErr(err);
          }
        },
        async openTerminal(req) {
          try {
            const opened = await svc.openTerminal(req.workspaceId, {
              cwd: req.cwd,
              title: req.title,
              cols: req.cols,
              rows: req.rows,
            });
            return peerOk({ terminal: opened.terminal as unknown as Record<string, unknown> });
          } catch (err) {
            return peerErr(err);
          }
        },
        async writeInput(req) {
          try {
            svc.writeInput(req.terminalId, req.data);
            return peerOk({ ok: true });
          } catch (err) {
            return peerErr(err);
          }
        },
        async resizeTerminal(req) {
          try {
            svc.resizeTerminal(req.terminalId, req.cols, req.rows);
            return peerOk({ ok: true });
          } catch (err) {
            return peerErr(err);
          }
        },
        async interruptTerminal(req) {
          try {
            await svc.interruptTerminal(req.terminalId);
            return peerOk({ ok: true });
          } catch (err) {
            return peerErr(err);
          }
        },
        async restartTerminal(req) {
          try {
            const terminal = await svc.restartTerminal(req.terminalId);
            return peerOk({ terminal: terminal as unknown as Record<string, unknown> });
          } catch (err) {
            return peerErr(err);
          }
        },
        async closeTerminal(req) {
          try {
            const closed = await svc.closeTerminal(req.terminalId);
            return peerOk({ closed });
          } catch (err) {
            return peerErr(err);
          }
        },
        async buildContextChip(req) {
          try {
            const chip = svc.createContextChip(req.terminalId, req);
            return peerOk({ chip: chip as unknown as Record<string, unknown> });
          } catch (err) {
            return peerErr(err);
          }
        },
        async pathUsage(req) {
          const matches = svc.listTerminalsUsingPath(req.targetPath);
          return peerOk({
            busy: matches.length > 0,
            terminals: matches.map((t) => ({
              terminalId: t.terminalId,
              title: t.title,
              cwd: t.cwd,
              pid: t.pid ?? undefined,
              instanceId: ctx.instanceId ?? 'hm.plugin.terminal-workspace',
            })),
          });
        },
        async releasePath(req) {
          const res = await svc.releaseTerminalsUnderPath(req.targetPath);
          return peerOk({ closedCount: res.releasedCount, terminalIds: res.terminalIds });
        },
        async getOutputSnapshot(req) {
          const snap = svc.getSnapshot(req.terminalId);
          const tab = svc.getTerminal(req.terminalId);
          if (!snap || !tab) {
            return { ok: false, error: { code: 'not_found', message: `终端不存在: ${req.terminalId}` } };
          }
          return peerOk({
            snapshot: snap.text,
            truncated: snap.truncated,
            status: tab.status,
            exitCode: tab.exitCode ?? null,
          });
        },
      };

      ctx.provide('terminal-workspace', svc);
      ctx.provide(PEER_CONTRACTS.terminalWorkspace, peer, {
        version: '1.0.0',
        metadata: { title: '集成交互终端与上下文胶囊' },
      });

      ctx.routes?.register('/status', () => ({
        status: 200,
        body: {
          ok: true,
          instanceId: ctx.instanceId ?? 'hm.plugin.terminal-workspace',
          ptyAvailable: svc.isPtyAvailable(),
          activeCount: svc.listTerminals().filter((t) => t.status === 'running').length,
        },
      }));
      ctx.routes?.register('/list', async (req) => ({
        status: 200,
        body: await peer.listTerminals((req.body ?? req.query) as { workspaceId: string; cwd?: string }),
      }));
      ctx.routes?.register('/open', async (req) => ({
        status: 200,
        body: await peer.openTerminal((req.body ?? {}) as { workspaceId: string; cwd: string }),
      }));
      ctx.routes?.register('/path-usage', async (req) => ({
        status: 200,
        body: await peer.pathUsage((req.body ?? req.query) as { targetPath: string }),
      }));
      ctx.routes?.register('/release-path', async (req) => ({
        status: 200,
        body: await peer.releasePath((req.body ?? {}) as { targetPath: string; workspaceId?: string }),
      }));
      ctx.routes?.register('/context-chip', async (req) => ({
        status: 200,
        body: await peer.buildContextChip((req.body ?? {}) as { terminalId: string }),
      }));
      ctx.routes?.register('/snapshot', async (req) => ({
        status: 200,
        body: await peer.getOutputSnapshot((req.body ?? req.query) as { terminalId: string }),
      }));

      ctx.effect(() => () => {
        void svc.onPluginDisabled().catch(() => {});
      });
    },
  });
  return plugins;
}
