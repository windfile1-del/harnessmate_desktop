import path from 'node:path';
import {
  PEER_CONTRACTS,
  PluginApiError,
  serviceResolutionErrorCode,
  type GitCheckpointServiceV1,
  type GitWorkspaceServiceV1,
  type PublicGitChangeEntry,
  type PublicGitStatusSummary,
  type ServiceMethodResult,
  type ServiceResolutionV1,
  type TerminalPathUsageEntry,
  type TerminalRunnerServiceV1,
  type TerminalWorkspaceServiceV1,
  type WorkspaceFilesServiceV1,
  type WorkspaceGitStatusLookupResult,
  type WorkspaceRulesServiceV1,
  type SessionAttachmentsServiceV1,
} from '@harnessmate/plugin-api';
import type {
  CheckpointRevertMode,
  CheckpointRevertResult,
  GitActionResult,
  GitDryRunMergeResult,
  GitFileDiffResult,
  GitStatusSummary,
  GitWorkspaceTruthDigest,
  GitWorktreeEntry,
  ManagedTerminalTab,
  SessionCheckpointRecord,
  SubagentDiffStat,
  TerminalContextChip,
  WorkspaceFileEntry,
  WorkspaceSetupScriptInfo,
} from '@harnessmate/protocol';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { GitService } from '../plugin-host/builtin/services.js';
import type { CheckpointDiffResult, CheckpointRevertHooks, CheckpointService } from './checkpoint-service.js';
import type { ProjectInstructionInfo, readWorkspaceFilePreview } from './attachment-service.js';
import {
  commitWorktreeChangesIfDirty,
  computeBranchDiffStat,
  deleteLocalBranch,
  mergeBranchExplicit,
} from './git-service.js';
import type { TerminalWorkspaceService } from './terminal-workspace-service.js';

export type WorkspaceFilePreview = ReturnType<typeof readWorkspaceFilePreview>;

export function toPublicGitStatusSummary(
  repoRoot: string | null,
  status: GitStatusSummary,
  gitCommonDir: string | null = null,
): PublicGitStatusSummary {
  const changes: PublicGitChangeEntry[] = status.changes.map((c) => {
    const code = c.status === 'untracked' ? '?' : (c.status[0]?.toUpperCase() ?? 'M');
    return {
      path: c.path,
      indexStatus: c.staged ? code : c.status === 'untracked' ? '?' : ' ',
      worktreeStatus: c.status === 'untracked' ? '?' : c.staged ? ' ' : code,
      untracked: c.status === 'untracked',
    };
  });
  return {
    isGitRepo: status.isGitRepo,
    repoRoot: status.isGitRepo ? repoRoot : null,
    gitCommonDir,
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    changes,
    stagedCount: status.changes.filter((c) => c.staged).length,
    unstagedCount: status.changes.filter((c) => !c.staged && c.status !== 'untracked').length,
    untrackedCount: status.changes.filter((c) => c.status === 'untracked').length,
    totalChanged: status.changes.length,
  };
}

export function unwrapPeerServiceResult<T>(raw: ServiceMethodResult<T> | T): T {
  if (raw && typeof raw === 'object' && 'ok' in raw && typeof (raw as { ok?: unknown }).ok === 'boolean') {
    const res = raw as ServiceMethodResult<T>;
    if (res.ok) return res.value;
    const codeMap: Record<string, string> = {
      invalid_request: 'E_INVALID_INPUT',
      permission_denied: 'E_PERMISSION_DENIED',
      not_found: 'E_NOT_FOUND',
      busy: 'E_WORKTREE_BUSY',
      conflict: 'E_CONFLICT',
      plugin_disabled: 'E_PLUGIN_DISABLED',
      git_required: 'E_NOT_GIT_REPO',
      not_supported: 'E_NOT_SUPPORTED',
    };
    const mapped = codeMap[res.error.code] ?? res.error.code;
    throw new PluginApiError(mapped as ConstructorParameters<typeof PluginApiError>[0], res.error.message);
  }
  return raw as T;
}

export function throwForUnavailableResolution(
  contract: string,
  resolution: ServiceResolutionV1,
): never {
  if (resolution.status === 'disabled') {
    throw new PluginApiError('E_PLUGIN_DISABLED', `能力 ${contract} 所属插件 (${resolution.instanceId}) 已停用`);
  }
  throw new PluginApiError(
    serviceResolutionErrorCode(resolution.status as Exclude<ServiceResolutionV1['status'], 'ready'>),
    `能力 ${contract} 当前不可用 (${resolution.status})`,
  );
}

export function httpStatusForPluginError(err: unknown, defaultStatus = 400): { status: number; code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? String((err as { code: string }).code)
      : 'E_INTERNAL';

  if (code === 'E_PLUGIN_DISABLED' || code === 'E_WORKTREE_BUSY' || code === 'E_CONFLICT' || code === 'E_SESSION_BUSY') {
    return { status: 409, code, message };
  }
  if (code === 'E_PERMISSION_DENIED' || code === 'E_SETUP_SCRIPT_UNTRUSTED' || code === 'E_PATH_OUT_OF_BOUNDS') {
    return { status: 403, code, message };
  }
  if (code === 'E_NOT_FOUND' || code === 'E_FILE_NOT_FOUND' || code === 'E_CHECKPOINT_NOT_FOUND' || code === 'E_CHECKPOINT_MISSING') {
    return { status: 404, code, message };
  }
  if (code === 'E_SERVICE_UNAVAILABLE' || code === 'E_STALE_RUN') {
    return { status: 409, code, message };
  }
  if (code === 'E_TIMEOUT') {
    return { status: 504, code, message };
  }
  return { status: defaultStatus, code, message };
}

export interface AdaptedGitWorkspaceProvider {
  instanceId: string;
  isLegacyDirect: boolean;
  status(cwd: string, scope?: { workspaceId?: string; sessionId?: string }): Promise<GitStatusSummary>;
  getStatusLookup(req: { workspaceId: string; sessionId?: string; cwd: string }): Promise<WorkspaceGitStatusLookupResult>;
  inspect(cwd: string, workspaceId?: string): Promise<{ isGitRepo: boolean; branch: string | null }>;
  fileDiff(cwd: string, filePath: string, staged?: boolean): Promise<GitFileDiffResult>;
  workspaceTruthDigest(cwd: string): Promise<GitWorkspaceTruthDigest>;
  init(cwd: string): Promise<GitActionResult>;
  discardFile(cwd: string, filePath: string): Promise<GitActionResult>;
  commit(cwd: string, opts: { message: string; files?: string[]; stageAll?: boolean }): Promise<GitActionResult>;
  push(cwd: string, opts?: { remote?: string; branch?: string; setUpstream?: boolean }): Promise<GitActionResult>;
  pull(cwd: string, opts?: { remote?: string; branch?: string }): Promise<GitActionResult>;
  createPr(cwd: string, opts: { title: string; body?: string; base?: string; draft?: boolean }): Promise<GitActionResult>;
  listWorktrees(repoRoot: string, sessions?: Array<{ sessionId: string; cwd: string }>): Promise<GitWorktreeEntry[]>;
  createWorktree(repoRoot: string, branchName: string, opts?: { baseBranch?: string }): Promise<{ worktreePath: string; branch: string }>;
  removeWorktree(repoRoot: string, worktreePath: string, opts?: { force?: boolean }): Promise<GitActionResult>;
  dryRunMerge(repoRoot: string, baseBranch: string, headBranch: string): Promise<GitDryRunMergeResult>;
  inspectSetupScript(repoRoot: string, store: HarnessMateStore): Promise<WorkspaceSetupScriptInfo>;
  setSetupScriptTrust(repoRoot: string, store: HarnessMateStore, expectedSha256: string, trusted: boolean): Promise<WorkspaceSetupScriptInfo>;
  executeTrustedSetupScript(repoRoot: string, targetDir: string, store: HarnessMateStore): Promise<GitActionResult>;
  commitWorktreeChangesIfDirty(worktreePath: string, message: string): Promise<{ committed: boolean; commitSha: string | null }>;
  computeBranchDiffStat(repoRoot: string, baseBranch: string, headBranch: string): Promise<SubagentDiffStat>;
  mergeBranchExplicit(
    repoRoot: string,
    baseBranch: string,
    headBranch: string,
    opts?: { commitMessage?: string },
  ): Promise<{ commitSha: string | null; dryRun: GitDryRunMergeResult }>;
  deleteLocalBranch(repoRoot: string, branchName: string): Promise<boolean>;
}

export function adaptGitWorkspaceService(
  instanceId: string,
  peerService: Partial<GitWorkspaceServiceV1> | undefined,
  legacyService: GitService | undefined,
  store?: HarnessMateStore,
): AdaptedGitWorkspaceProvider {
  if (legacyService && !peerService) {
    return {
      instanceId,
      isLegacyDirect: true,
      status: (cwd) => legacyService.status(cwd),
      getStatusLookup: async (req) => {
        const s = await legacyService.status(req.cwd);
        return {
          available: true,
          ...(s.isGitRepo ? {} : { reason: 'not_git_repo' as const }),
          instanceId,
          status: toPublicGitStatusSummary(req.cwd, s),
        };
      },
      inspect: (cwd) => legacyService.inspect(cwd),
      fileDiff: (cwd, filePath, staged = false) => legacyService.fileDiff(cwd, filePath, staged),
      workspaceTruthDigest: (cwd) => legacyService.workspaceTruthDigest(cwd),
      init: (cwd) => legacyService.init(cwd),
      discardFile: (cwd, filePath) => legacyService.discardFile(cwd, filePath),
      commit: (cwd, opts) => legacyService.commit(cwd, opts),
      push: (cwd, opts) => legacyService.push(cwd, opts),
      pull: (cwd, opts) => legacyService.pull(cwd, opts),
      createPr: (cwd, opts) => legacyService.createPr(cwd, opts),
      listWorktrees: (repoRoot, sessions) => legacyService.listWorktrees(repoRoot, sessions),
      createWorktree: (repoRoot, branchName, opts) => legacyService.createWorktree(repoRoot, branchName, opts),
      removeWorktree: (repoRoot, worktreePath, opts) => legacyService.removeWorktree(repoRoot, worktreePath, opts),
      dryRunMerge: (repoRoot, baseBranch, headBranch) => legacyService.dryRunMerge(repoRoot, baseBranch, headBranch),
      inspectSetupScript: async (repoRoot, s) => legacyService.inspectSetupScript(repoRoot, s),
      setSetupScriptTrust: async (repoRoot, s, expectedSha, trusted) =>
        legacyService.setSetupScriptTrust(repoRoot, s, expectedSha, trusted),
      executeTrustedSetupScript: (repoRoot, targetDir, s) =>
        legacyService.executeTrustedSetupScript(repoRoot, targetDir, s),
      commitWorktreeChangesIfDirty: (worktreePath, message) =>
        legacyService.commitWorktreeChangesIfDirty(worktreePath, message),
      computeBranchDiffStat: (repoRoot, baseBranch, headBranch) =>
        legacyService.computeBranchDiffStat(repoRoot, baseBranch, headBranch),
      mergeBranchExplicit: (repoRoot, baseBranch, headBranch, opts) =>
        legacyService.mergeBranchExplicit(repoRoot, baseBranch, headBranch, opts),
      deleteLocalBranch: (repoRoot, branchName) => legacyService.deleteLocalBranch(repoRoot, branchName),
    };
  }

  const peer = peerService as GitWorkspaceServiceV1;
  return {
    instanceId,
    isLegacyDirect: false,
    status: async (cwd, scope) => {
      if (legacyService) return legacyService.status(cwd);
      const res = unwrapPeerServiceResult(
        await peer.getStatus({
          workspaceId: scope?.workspaceId ?? '',
          sessionId: scope?.sessionId,
          cwd,
        }),
      );
      return (res.status as GitStatusSummary | null) ?? {
        isGitRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        changes: [],
        diff: '',
      };
    },
    getStatusLookup: async (req) =>
      unwrapPeerServiceResult(await peer.getStatus(req)),
    inspect: async (cwd, workspaceId) => {
      const res = unwrapPeerServiceResult(await peer.inspect({ cwd, workspaceId }));
      return { isGitRepo: res.isGitRepo, branch: res.branch };
    },
    fileDiff: async (cwd, filePath, staged = false) => {
      if (legacyService) return legacyService.fileDiff(cwd, filePath, staged);
      const raw = unwrapPeerServiceResult(
        await (peer.getFileDiff as (req: Record<string, unknown>) => Promise<ServiceMethodResult<Record<string, unknown>>>)({
          cwd,
          filePath,
          staged,
        }),
      );
      return raw as unknown as GitFileDiffResult;
    },
    workspaceTruthDigest: async (cwd) => {
      if (legacyService) return legacyService.workspaceTruthDigest(cwd);
      const raw = unwrapPeerServiceResult(await peer.getTruthDigest({ cwd }));
      return raw as unknown as GitWorkspaceTruthDigest;
    },
    init: async (cwd) =>
      legacyService
        ? legacyService.init(cwd)
        : (unwrapPeerServiceResult(await peer.initRepo({ cwd })) as unknown as GitActionResult),
    discardFile: async (cwd, filePath) =>
      legacyService
        ? legacyService.discardFile(cwd, filePath)
        : (unwrapPeerServiceResult(await peer.discardFile({ cwd, filePath })) as unknown as GitActionResult),
    commit: async (cwd, opts) =>
      legacyService
        ? legacyService.commit(cwd, opts)
        : (unwrapPeerServiceResult(
            await peer.commit({ cwd, message: opts.message, stageAll: opts.stageAll, files: opts.files }),
          ) as unknown as GitActionResult),
    push: async (cwd, opts) =>
      legacyService
        ? legacyService.push(cwd, opts)
        : (unwrapPeerServiceResult(await peer.push({ cwd, ...opts })) as unknown as GitActionResult),
    pull: async (cwd, opts) =>
      legacyService
        ? legacyService.pull(cwd, opts)
        : (unwrapPeerServiceResult(await peer.pull({ cwd, ...opts })) as unknown as GitActionResult),
    createPr: async (cwd, opts) =>
      legacyService
        ? legacyService.createPr(cwd, opts)
        : (unwrapPeerServiceResult(
            await peer.createPr({ cwd, title: opts.title, body: opts.body, baseBranch: opts.base, draft: opts.draft }),
          ) as unknown as GitActionResult),
    listWorktrees: async (repoRoot, sessions) => {
      if (legacyService) return legacyService.listWorktrees(repoRoot, sessions);
      const raw = unwrapPeerServiceResult(
        await (peer.listWorktrees as (req: Record<string, unknown>) => Promise<ServiceMethodResult<{ worktrees: GitWorktreeEntry[] }>>)({
          repoRoot,
          sessions,
        }),
      );
      return (raw.worktrees ?? []) as GitWorktreeEntry[];
    },
    createWorktree: async (repoRoot, branchName, opts) =>
      legacyService
        ? legacyService.createWorktree(repoRoot, branchName, opts)
        : unwrapPeerServiceResult(await peer.createWorktree({ repoRoot, branchName, baseBranch: opts?.baseBranch })),
    removeWorktree: async (repoRoot, worktreePath, opts) =>
      legacyService
        ? legacyService.removeWorktree(repoRoot, worktreePath, opts)
        : (unwrapPeerServiceResult(
            await peer.removeWorktree({ repoRoot, worktreePath, force: opts?.force }),
          ) as unknown as GitActionResult),
    dryRunMerge: async (repoRoot, baseBranch, headBranch) => {
      if (legacyService) return legacyService.dryRunMerge(repoRoot, baseBranch, headBranch);
      const raw = unwrapPeerServiceResult(
        await (peer.dryRunMerge as (req: Record<string, unknown>) => Promise<ServiceMethodResult<Record<string, unknown>>>)({
          repoRoot,
          baseBranch,
          headBranch,
          sourceBranch: headBranch,
          targetBranch: baseBranch,
        }),
      );
      return raw as unknown as GitDryRunMergeResult;
    },
    inspectSetupScript: async (repoRoot, s) => {
      if (legacyService) return legacyService.inspectSetupScript(repoRoot, s);
      const raw = unwrapPeerServiceResult(await peer.getSetupScriptInfo({ repoRoot }));
      return {
        exists: raw.exists,
        relativePath: raw.relativePath,
        scriptPath: raw.scriptPath ?? (raw.relativePath ? path.resolve(repoRoot, raw.relativePath) : null),
        sha256: raw.sha256,
        trusted: raw.trusted,
        trustedAt: raw.trustedAt ?? null,
        content: raw.content ?? null,
      };
    },
    setSetupScriptTrust: async (repoRoot, s, expectedSha256, trusted) => {
      if (legacyService) return legacyService.setSetupScriptTrust(repoRoot, s, expectedSha256, trusted);
      const raw = unwrapPeerServiceResult(
        await (peer.setSetupScriptTrust as (req: Record<string, unknown>) => Promise<ServiceMethodResult<WorkspaceSetupScriptInfo>>)({
          repoRoot,
          expectedSha256,
          trusted,
        }),
      );
      return raw as unknown as WorkspaceSetupScriptInfo;
    },
    executeTrustedSetupScript: async (repoRoot, targetDir, s) => {
      if (legacyService) return legacyService.executeTrustedSetupScript(repoRoot, targetDir, s);
      if (store && s !== store) {
        // Store passed explicitly
      }
      const raw = unwrapPeerServiceResult(await peer.runSetupScript({ repoRoot, targetDir }));
      return raw as unknown as GitActionResult;
    },
    commitWorktreeChangesIfDirty: (worktreePath, message) =>
      legacyService
        ? legacyService.commitWorktreeChangesIfDirty(worktreePath, message)
        : commitWorktreeChangesIfDirty(worktreePath, message),
    computeBranchDiffStat: (repoRoot, baseBranch, headBranch) =>
      legacyService
        ? legacyService.computeBranchDiffStat(repoRoot, baseBranch, headBranch)
        : computeBranchDiffStat(repoRoot, baseBranch, headBranch),
    mergeBranchExplicit: (repoRoot, baseBranch, headBranch, opts) =>
      legacyService
        ? legacyService.mergeBranchExplicit(repoRoot, baseBranch, headBranch, opts)
        : mergeBranchExplicit(repoRoot, baseBranch, headBranch, opts),
    deleteLocalBranch: (repoRoot, branchName) =>
      legacyService ? legacyService.deleteLocalBranch(repoRoot, branchName) : deleteLocalBranch(repoRoot, branchName),
  };
}

export function resolveGitWorkspaceProvider(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { resolution: ServiceResolutionV1; provider: AdaptedGitWorkspaceProvider } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.gitWorkspace, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'ready') {
    const peer = pluginManager.host.getServiceByInstance<GitWorkspaceServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.gitWorkspace,
    );
    const legacy = pluginManager.host.getServiceByInstance<GitService>(resolution.instanceId, 'git');
    if (peer || legacy) {
      return {
        resolution,
        provider: adaptGitWorkspaceService(resolution.instanceId, peer, legacy),
      };
    }
  } else if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.gitWorkspace, resolution);
  }

  // Fallback for direct legacy 'git' registration without peer metadata
  const directGit = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<GitService>(opts.explicitInstanceId, 'git')
    : pluginManager.host.get<GitService>('git');
  if (directGit) {
    const instId = opts?.explicitInstanceId ?? 'core.git-inspector';
    return {
      resolution: {
        contract: PEER_CONTRACTS.gitWorkspace,
        versionRange: '^1.0.0',
        candidates: [{ instanceId: instId, pluginId: instId, version: '1.0.0' }],
        instanceId: instId,
        source: 'composition',
        status: 'ready',
      },
      provider: adaptGitWorkspaceService(instId, undefined, directGit),
    };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.gitWorkspace, resolution);
}

export function resolveOptionalGitWorkspaceProvider(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): AdaptedGitWorkspaceProvider | null {
  try {
    return resolveGitWorkspaceProvider(pluginManager, opts).provider;
  } catch {
    return null;
  }
}

export async function lookupOptionalGitStatus(
  pluginManager: PluginManager,
  req: { workspaceId: string; sessionId?: string; cwd?: string },
): Promise<WorkspaceGitStatusLookupResult> {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.gitWorkspace, {
    workspaceId: req.workspaceId,
    sessionId: req.sessionId,
    allowSingleCandidate: true,
  });
  if (resolution.status !== 'ready') {
    const legacy = resolution.status === 'unconfigured' ? pluginManager.host.get<GitService>('git') : undefined;
    if (legacy && req.cwd) {
      try {
        const s = await legacy.status(req.cwd);
        return {
          available: true,
          ...(s.isGitRepo ? {} : { reason: 'not_git_repo' as const }),
          instanceId: 'core.git-inspector',
          status: toPublicGitStatusSummary(req.cwd, s),
        };
      } catch {
        // fall through to unavailable DTO
      }
    }
    return {
      available: false,
      reason:
        resolution.status === 'disabled'
          ? 'disabled'
          : resolution.status === 'unconfigured'
            ? 'unconfigured'
            : 'unavailable',
      instanceId: null,
      status: null,
    };
  }

  try {
    const { provider } = resolveGitWorkspaceProvider(pluginManager, {
      workspaceId: req.workspaceId,
      sessionId: req.sessionId,
      explicitInstanceId: resolution.instanceId,
    });
    const cwd = req.cwd ?? '';
    return await provider.getStatusLookup({
      workspaceId: req.workspaceId,
      sessionId: req.sessionId,
      cwd,
    });
  } catch {
    return {
      available: false,
      reason: 'unavailable',
      instanceId: null,
      status: null,
    };
  }
}

export interface AdaptedGitCheckpointProvider {
  instanceId: string;
  list(sessionId: string, limit?: number): Promise<SessionCheckpointRecord[]>;
  get(checkpointId: string): Promise<SessionCheckpointRecord | null>;
  capture(params: {
    sessionId: string;
    cwd: string;
    turnSeq: number;
    phase: SessionCheckpointRecord['phase'];
    skipIfUnchangedFromTreeSha?: string | null;
    compareAgainstTreeSha?: string | null;
  }): Promise<SessionCheckpointRecord | null>;
  diff(params: {
    sessionId: string;
    cwd: string;
    fromCheckpointId?: string;
    toCheckpointId?: string;
    fromSeq?: number;
    toSeq?: number;
  }): Promise<CheckpointDiffResult>;
  revert(params: {
    sessionId: string;
    cwd: string;
    targetTurnSeq?: number;
    checkpointId?: string;
    mode: CheckpointRevertMode;
    hooks: CheckpointRevertHooks;
  }): Promise<CheckpointRevertResult>;
  gcCheckpoints(params: {
    sessionId: string;
    cwd: string;
    keepLast?: number;
    olderThanDays?: number;
  }): Promise<{ deletedCount: number; deletedRefs: string[] }>;
}

export function resolveGitCheckpointProvider(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { resolution: ServiceResolutionV1; provider: AdaptedGitCheckpointProvider } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.gitCheckpoint, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });

  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.gitCheckpoint, resolution);
  }

  if (resolution.status === 'ready') {
    const legacy = pluginManager.host.getServiceByInstance<CheckpointService>(
      resolution.instanceId,
      'checkpoints',
    );
    if (legacy) {
      return {
        resolution,
        provider: {
          instanceId: resolution.instanceId,
          list: async (sessionId, limit) => legacy.list(sessionId, limit),
          get: async (checkpointId) => legacy.get(checkpointId),
          capture: (params) => legacy.capture(params),
          diff: (params) => legacy.diff(params),
          revert: (params) => legacy.revert(params),
          gcCheckpoints: (params) => legacy.gcCheckpoints(params),
        },
      };
    }
    const peer = pluginManager.host.getServiceByInstance<GitCheckpointServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.gitCheckpoint,
    );
    if (peer) {
      return {
        resolution,
        provider: {
          instanceId: resolution.instanceId,
          list: async (sessionId, limit) => {
            const res = unwrapPeerServiceResult(await peer.list({ sessionId, limit }));
            return (res.checkpoints ?? []) as unknown as SessionCheckpointRecord[];
          },
          get: async (checkpointId) => {
            const res = unwrapPeerServiceResult(await peer.get({ checkpointId }));
            return (res.checkpoint ?? null) as unknown as SessionCheckpointRecord | null;
          },
          capture: async (params) => {
            const res = unwrapPeerServiceResult(
              await (peer.capture as (req: Record<string, unknown>) => Promise<ServiceMethodResult<{ checkpoint: Record<string, unknown> | null }>>)(
                params,
              ),
            );
            return (res.checkpoint ?? null) as unknown as SessionCheckpointRecord | null;
          },
          diff: async (params) =>
            unwrapPeerServiceResult(
              await (peer.diff as (req: Record<string, unknown>) => Promise<ServiceMethodResult<Record<string, unknown>>>)(
                params,
              ),
            ) as unknown as CheckpointDiffResult,
          revert: async (params) => {
            const raw = unwrapPeerServiceResult(
              await (peer.revert as (req: Record<string, unknown>) => Promise<ServiceMethodResult<Record<string, unknown>>>)({
                sessionId: params.sessionId,
                cwd: params.cwd,
                checkpointId: params.checkpointId,
                targetTurnSeq: params.targetTurnSeq,
                mode: params.mode,
              }),
            ) as unknown as CheckpointRevertResult;
            return raw;
          },
          gcCheckpoints: async (params) =>
            unwrapPeerServiceResult(
              await (peer.gc as (req: Record<string, unknown>) => Promise<ServiceMethodResult<Record<string, unknown>>>)(
                params,
              ),
            ) as unknown as { deletedCount: number; deletedRefs: string[] },
        },
      };
    }
  }

  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<CheckpointService>(opts.explicitInstanceId, 'checkpoints')
    : pluginManager.host.get<CheckpointService>('checkpoints');
  if (direct) {
    const instId = opts?.explicitInstanceId ?? 'core.git-inspector';
    return {
      resolution: {
        contract: PEER_CONTRACTS.gitCheckpoint,
        versionRange: '^1.0.0',
        candidates: [{ instanceId: instId, pluginId: instId, version: '1.0.0' }],
        instanceId: instId,
        source: 'composition',
        status: 'ready',
      },
      provider: {
        instanceId: instId,
        list: async (sessionId, limit) => direct.list(sessionId, limit),
        get: async (checkpointId) => direct.get(checkpointId),
        capture: (params) => direct.capture(params),
        diff: (params) => direct.diff(params),
        revert: (params) => direct.revert(params),
        gcCheckpoints: (params) => direct.gcCheckpoints(params),
      },
    };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.gitCheckpoint, resolution);
}

export async function listAllTerminalsUsingPath(
  pluginManager: PluginManager,
  targetPath: string,
): Promise<TerminalPathUsageEntry[]> {
  const seenInstances = new Set<string>();
  const collected: TerminalPathUsageEntry[] = [];

  for (const prov of pluginManager.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace)) {
    if (seenInstances.has(prov.instanceId)) continue;
    seenInstances.add(prov.instanceId);
    const legacySvc = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    try {
      if (legacySvc && typeof legacySvc.listTerminalsUsingPath === 'function') {
        for (const t of legacySvc.listTerminalsUsingPath(targetPath)) {
          collected.push({
            terminalId: t.terminalId,
            title: t.title,
            cwd: t.cwd,
            pid: t.pid ?? undefined,
            instanceId: prov.instanceId,
          });
        }
        continue;
      }
      const peerSvc = pluginManager.host.getServiceByInstance<TerminalWorkspaceServiceV1>(
        prov.instanceId,
        PEER_CONTRACTS.terminalWorkspace,
      );
      if (peerSvc && typeof peerSvc.pathUsage === 'function') {
        const res = unwrapPeerServiceResult(await peerSvc.pathUsage({ targetPath }));
        for (const t of res.terminals ?? []) {
          collected.push({ ...t, instanceId: t.instanceId ?? prov.instanceId });
        }
      }
    } catch {
      // Best-effort aggregation across active providers
    }
  }

  for (const prov of pluginManager.host.listServiceProviders('terminal-workspace')) {
    if (seenInstances.has(prov.instanceId)) continue;
    seenInstances.add(prov.instanceId);
    const svc = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (!svc || typeof svc.listTerminalsUsingPath !== 'function') continue;
    for (const t of svc.listTerminalsUsingPath(targetPath)) {
      collected.push({
        terminalId: t.terminalId,
        title: t.title,
        cwd: t.cwd,
        pid: t.pid ?? undefined,
        instanceId: prov.instanceId,
      });
    }
  }

  return collected;
}

export async function releaseTerminalsUsingPath(
  pluginManager: PluginManager,
  targetPath: string,
  workspaceId?: string,
): Promise<{ closedCount: number; terminalIds: string[] }> {
  const seenInstances = new Set<string>();
  let closedCount = 0;
  const terminalIds: string[] = [];

  for (const prov of pluginManager.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace)) {
    if (seenInstances.has(prov.instanceId)) continue;
    seenInstances.add(prov.instanceId);
    const legacySvc = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (legacySvc && typeof legacySvc.releaseTerminalsUnderPath === 'function') {
      const r = await legacySvc.releaseTerminalsUnderPath(targetPath);
      closedCount += r.releasedCount;
      terminalIds.push(...r.terminalIds);
      continue;
    }
    const peerSvc = pluginManager.host.getServiceByInstance<TerminalWorkspaceServiceV1>(
      prov.instanceId,
      PEER_CONTRACTS.terminalWorkspace,
    );
    if (peerSvc && typeof peerSvc.releasePath === 'function') {
      const r = unwrapPeerServiceResult(await peerSvc.releasePath({ targetPath, workspaceId }));
      closedCount += r.closedCount;
      terminalIds.push(...(r.terminalIds ?? []));
    }
  }

  for (const prov of pluginManager.host.listServiceProviders('terminal-workspace')) {
    if (seenInstances.has(prov.instanceId)) continue;
    seenInstances.add(prov.instanceId);
    const svc = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (!svc || typeof svc.releaseTerminalsUnderPath !== 'function') continue;
    const r = await svc.releaseTerminalsUnderPath(targetPath);
    closedCount += r.releasedCount;
    terminalIds.push(...r.terminalIds);
  }

  return { closedCount, terminalIds };
}

export interface LegacyFileOpsService {
  search?(cwd: string, query: string, limit?: number): WorkspaceFileEntry[] | Promise<WorkspaceFileEntry[]>;
  read?(cwd: string, filePath: string): WorkspaceFilePreview | Promise<WorkspaceFilePreview>;
  discoverRules?(cwd: string): ProjectInstructionInfo[] | Promise<ProjectInstructionInfo[]>;
  runCommand?(req: { sessionId?: string; workspaceId?: string; cwd: string; command: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
}

export function resolveTerminalWorkspaceService(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): {
  resolution: ServiceResolutionV1;
  instanceId: string;
  peer?: TerminalWorkspaceServiceV1;
  legacy?: TerminalWorkspaceService;
} {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.terminalWorkspace, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.terminalWorkspace, resolution);
  }
  if (resolution.status === 'ready') {
    const legacy = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      resolution.instanceId,
      'terminal-workspace',
    );
    const peer = pluginManager.host.getServiceByInstance<TerminalWorkspaceServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.terminalWorkspace,
    );
    if (legacy || peer) {
      return { resolution, instanceId: resolution.instanceId, peer, legacy };
    }
  }
  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(opts.explicitInstanceId, 'terminal-workspace')
    : pluginManager.host.get<TerminalWorkspaceService>('terminal-workspace');
  if (direct) {
    const instId = opts?.explicitInstanceId ?? 'hm.plugin.terminal-workspace';
    return {
      resolution: {
        contract: PEER_CONTRACTS.terminalWorkspace,
        versionRange: '^1.0.0',
        candidates: [{ instanceId: instId, pluginId: instId, version: '1.0.0' }],
        instanceId: instId,
        source: 'composition',
        status: 'ready',
      },
      instanceId: instId,
      legacy: direct,
    };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.terminalWorkspace, resolution);
}

export function resolveTerminalProviderForTerminalId(
  pluginManager: PluginManager,
  terminalId: string,
): { instanceId: string; peer?: TerminalWorkspaceServiceV1; legacy?: TerminalWorkspaceService } | null {
  for (const prov of pluginManager.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace)) {
    const legacy = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (legacy?.getTerminal(terminalId)) {
      const peer = pluginManager.host.getServiceByInstance<TerminalWorkspaceServiceV1>(
        prov.instanceId,
        PEER_CONTRACTS.terminalWorkspace,
      );
      return { instanceId: prov.instanceId, peer, legacy };
    }
  }
  for (const prov of pluginManager.host.listServiceProviders('terminal-workspace')) {
    const legacy = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (legacy?.getTerminal(terminalId)) {
      return { instanceId: prov.instanceId, legacy };
    }
  }
  return null;
}

export async function resolveTerminalProviderForTerminalIdAsync(
  pluginManager: PluginManager,
  terminalId: string,
): Promise<{ instanceId: string; peer?: TerminalWorkspaceServiceV1; legacy?: TerminalWorkspaceService } | null> {
  const syncFound = resolveTerminalProviderForTerminalId(pluginManager, terminalId);
  if (syncFound) return syncFound;
  for (const prov of pluginManager.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace)) {
    const legacy = pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(
      prov.instanceId,
      'terminal-workspace',
    );
    if (legacy) continue;
    const peer = pluginManager.host.getServiceByInstance<TerminalWorkspaceServiceV1>(
      prov.instanceId,
      PEER_CONTRACTS.terminalWorkspace,
    );
    if (!peer || typeof peer.getOutputSnapshot !== 'function') continue;
    try {
      const snap = await peer.getOutputSnapshot({ terminalId });
      if (snap && snap.ok) {
        return { instanceId: prov.instanceId, peer };
      }
    } catch {
      // probe next provider
    }
  }
  return null;
}

export function resolveTerminalRunnerService(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { instanceId: string; peer?: TerminalRunnerServiceV1; legacy?: LegacyFileOpsService } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.terminalRunner, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.terminalRunner, resolution);
  }
  if (resolution.status === 'ready') {
    const peer = pluginManager.host.getServiceByInstance<TerminalRunnerServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.terminalRunner,
    );
    const legacy = pluginManager.host.getServiceByInstance<LegacyFileOpsService>(resolution.instanceId, 'terminal');
    if (peer || legacy) {
      return { instanceId: resolution.instanceId, peer, legacy };
    }
  }
  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<LegacyFileOpsService>(opts.explicitInstanceId, 'terminal')
    : pluginManager.host.get<LegacyFileOpsService>('terminal');
  if (direct) {
    return { instanceId: opts?.explicitInstanceId ?? 'core.terminal-runner', legacy: direct };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.terminalRunner, resolution);
}

export function resolveWorkspaceFilesService(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { instanceId: string; peer?: WorkspaceFilesServiceV1; legacy?: LegacyFileOpsService } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.workspaceFiles, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.workspaceFiles, resolution);
  }
  if (resolution.status === 'ready') {
    const peer = pluginManager.host.getServiceByInstance<WorkspaceFilesServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.workspaceFiles,
    );
    const legacy = pluginManager.host.getServiceByInstance<LegacyFileOpsService>(resolution.instanceId, 'files');
    if (peer || legacy) {
      return { instanceId: resolution.instanceId, peer, legacy };
    }
  }
  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<LegacyFileOpsService>(opts.explicitInstanceId, 'files')
    : pluginManager.host.get<LegacyFileOpsService>('files');
  if (direct) {
    return { instanceId: opts?.explicitInstanceId ?? 'core.terminal-runner', legacy: direct };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.workspaceFiles, resolution);
}

export function resolveWorkspaceRulesService(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { instanceId: string; peer?: WorkspaceRulesServiceV1; legacy?: LegacyFileOpsService } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.workspaceRules, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.workspaceRules, resolution);
  }
  if (resolution.status === 'ready') {
    const peer = pluginManager.host.getServiceByInstance<WorkspaceRulesServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.workspaceRules,
    );
    const legacy = pluginManager.host.getServiceByInstance<LegacyFileOpsService>(resolution.instanceId, 'rules');
    if (peer || legacy) {
      return { instanceId: resolution.instanceId, peer, legacy };
    }
  }
  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<LegacyFileOpsService>(opts.explicitInstanceId, 'rules')
    : pluginManager.host.get<LegacyFileOpsService>('rules');
  if (direct) {
    return { instanceId: opts?.explicitInstanceId ?? 'core.workspace-rules', legacy: direct };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.workspaceRules, resolution);
}

export function resolveSessionAttachmentsService(
  pluginManager: PluginManager,
  opts?: { workspaceId?: string; sessionId?: string; explicitInstanceId?: string },
): { instanceId: string; peer?: SessionAttachmentsServiceV1; legacy?: Record<string, unknown> } {
  const resolution = pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionAttachments, {
    workspaceId: opts?.workspaceId,
    sessionId: opts?.sessionId,
    explicitInstanceId: opts?.explicitInstanceId,
    allowSingleCandidate: true,
  });
  if (resolution.status === 'disabled') {
    throwForUnavailableResolution(PEER_CONTRACTS.sessionAttachments, resolution);
  }
  if (resolution.status === 'ready') {
    const peer = pluginManager.host.getServiceByInstance<SessionAttachmentsServiceV1>(
      resolution.instanceId,
      PEER_CONTRACTS.sessionAttachments,
    );
    const legacy = pluginManager.host.getServiceByInstance<Record<string, unknown>>(
      resolution.instanceId,
      'attachments',
    );
    if (peer || legacy) {
      return { instanceId: resolution.instanceId, peer, legacy };
    }
  }
  const direct = opts?.explicitInstanceId
    ? pluginManager.host.getServiceByInstance<Record<string, unknown>>(opts.explicitInstanceId, 'attachments')
    : pluginManager.host.get<Record<string, unknown>>('attachments');
  if (direct) {
    return { instanceId: opts?.explicitInstanceId ?? 'core.attachments', legacy: direct };
  }
  throwForUnavailableResolution(PEER_CONTRACTS.sessionAttachments, resolution);
}

export type { ManagedTerminalTab, TerminalContextChip };
