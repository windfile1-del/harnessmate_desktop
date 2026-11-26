import type { FastifyInstance } from 'fastify';
import {
  CreateWorktreeRequestSchema,
  DryRunMergeRequestSchema,
  GitCommitRequestSchema,
  GitCreatePrRequestSchema,
  GitDiscardFileRequestSchema,
  GitPullRequestSchema,
  GitPushRequestSchema,
  RemoveWorktreeRequestSchema,
  TrustSetupScriptRequestSchema,
} from '@harnessmate/protocol';
import { GitOperationError } from '../../core/git-service.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import {
  httpStatusForPluginError,
  listAllTerminalsUsingPath,
  lookupOptionalGitStatus,
  releaseTerminalsUsingPath,
  resolveGitWorkspaceProvider,
} from '../../core/w1-service-helpers.js';

export interface GitWorktreesCompatDeps {
  store: HarnessMateStore;
  pluginManager: PluginManager;
  sessionManager: SessionManager;
}

export function registerGitWorktreesCompatRoutes(
  app: FastifyInstance,
  deps: GitWorktreesCompatDeps,
): void {
  const { store, pluginManager, sessionManager } = deps;

  // Optional W2-consumable Git status lookup DTO (never throws when Git plugin disabled)
  app.get('/api/v1/workspaces/:id/git/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    const q = (request.query ?? {}) as { sessionId?: string };
    const session = q.sessionId ? sessionManager.getSession(q.sessionId) : undefined;
    return lookupOptionalGitStatus(pluginManager, {
      workspaceId: workspace.id,
      sessionId: session?.id,
      cwd: session?.cwd ?? workspace.rootPath,
    });
  });

  app.get('/api/v1/sessions/:id/git', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { git, instanceId: provider.instanceId };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/sessions/:id/git/file-diff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { path?: string; staged?: string; instanceId?: string };
    if (!q.path) return reply.code(400).send({ error: 'Missing path parameter' });
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      return await provider.fileDiff(session.cwd, q.path, q.staged === '1' || q.staged === 'true');
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_GIT_DIFF_FAILED' : mapped.code),
      });
    }
  });

  app.get('/api/v1/sessions/:id/git/truth', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      const digest = await provider.workspaceTruthDigest(session.cwd);
      return { digest };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.post('/api/v1/sessions/:id/git/init', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      const result = await provider.init(session.cwd);
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { result, git };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_GIT_INIT_FAILED' : mapped.code),
      });
    }
  });

  app.post('/api/v1/sessions/:id/git/discard', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const parsed = GitDiscardFileRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid filePath' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      const result = await provider.discardFile(session.cwd, parsed.data.filePath);
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { result, git };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : undefined;
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({
        error: mapped.message,
        code: code ?? (mapped.code === 'E_INTERNAL' ? 'E_DISCARD_FAILED' : mapped.code),
      });
    }
  });

  app.post('/api/v1/sessions/:id/git/commit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = GitCommitRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid commit payload' });
    }
    try {
      const result = await provider.commit(session.cwd, parsed.data);
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { result, git };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_GIT_COMMIT_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/sessions/:id/git/push', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = GitPushRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid push payload' });
    try {
      const result = await provider.push(session.cwd, parsed.data);
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { result, git };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_GIT_PUSH_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/sessions/:id/git/pull', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = GitPullRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid pull payload' });
    try {
      const result = await provider.pull(session.cwd, parsed.data);
      const git = await provider.status(session.cwd, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      return { result, git };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_GIT_PULL_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/sessions/:id/git/pr', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = GitCreatePrRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid PR payload' });
    }
    try {
      const result = await provider.createPr(session.cwd, parsed.data);
      return { result };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_PR_CREATE_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  // ── Workspace Worktrees, Dry-Run Merge & .harnessmate/setup Trust ────

  app.get('/api/v1/workspaces/:id/worktrees', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, {
        workspaceId: workspace.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      const sessions = sessionManager.listSessions({ workspaceId: id, includeArchived: true });
      const worktrees = await provider.listWorktrees(
        workspace.rootPath,
        sessions.map((s) => ({ sessionId: s.id, cwd: s.cwd })),
      );
      const setupScript = await provider.inspectSetupScript(workspace.rootPath, store);
      const blockingTerminalsByPath: Record<string, Array<{
        terminalId: string;
        title: string;
        cwd: string;
        pid?: number;
        instanceId?: string;
      }>> = {};
      for (const wt of worktrees) {
        const blocking = await listAllTerminalsUsingPath(pluginManager, wt.path);
        if (blocking.length > 0) {
          blockingTerminalsByPath[wt.path] = blocking;
        }
      }
      return { worktrees, setupScript, blockingTerminalsByPath, instanceId: provider.instanceId };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.post('/api/v1/workspaces/:id/worktrees', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = CreateWorktreeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid worktree payload' });
    }
    try {
      const created = await provider.createWorktree(workspace.rootPath, parsed.data.branchName, {
        baseBranch: parsed.data.baseBranch,
      });
      const sessions = sessionManager.listSessions({ workspaceId: id, includeArchived: true });
      const worktrees = await provider.listWorktrees(
        workspace.rootPath,
        sessions.map((s) => ({ sessionId: s.id, cwd: s.cwd })),
      );
      return reply.code(201).send({ created, worktrees });
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_WORKTREE_CREATE_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.delete('/api/v1/workspaces/:id/worktrees', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const q = request.query as { worktreePath?: string; force?: string; releaseTerminals?: string };
    const rawBody =
      request.body && typeof request.body === 'object'
        ? request.body
        : {
            worktreePath: q.worktreePath,
            force: q.force === '1' || q.force === 'true',
            releaseTerminals: q.releaseTerminals === '1' || q.releaseTerminals === 'true',
          };
    const parsed = RemoveWorktreeRequestSchema.safeParse(rawBody);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid worktreePath' });

    // Query path usage across active terminal providers without implicit termination
    let blockingTerminals = await listAllTerminalsUsingPath(pluginManager, parsed.data.worktreePath);
    let releasedTerminals: { closedCount: number; terminalIds: string[] } | undefined;
    if (blockingTerminals.length > 0 && parsed.data.releaseTerminals === true) {
      releasedTerminals = await releaseTerminalsUsingPath(pluginManager, parsed.data.worktreePath, workspace.id);
      // Re-check path usage before deletion
      blockingTerminals = await listAllTerminalsUsingPath(pluginManager, parsed.data.worktreePath);
    }

    if (blockingTerminals.length > 0) {
      return reply.code(409).send({
        error: `Worktree 目录正被 ${blockingTerminals.length} 个运行中终端占用，请先关闭或一键释放占用终端后重试 (${blockingTerminals.map((t) => t.title).join(', ')})`,
        code: 'E_WORKTREE_BUSY',
        blockingTerminals,
      });
    }

    try {
      const result = await provider.removeWorktree(workspace.rootPath, parsed.data.worktreePath, {
        force: parsed.data.force,
      });
      const sessions = sessionManager.listSessions({ workspaceId: id, includeArchived: true });
      const worktrees = await provider.listWorktrees(
        workspace.rootPath,
        sessions.map((s) => ({ sessionId: s.id, cwd: s.cwd })),
      );
      return { result, worktrees, ...(releasedTerminals ? { releasedTerminals } : {}) };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_WORKTREE_REMOVE_FAILED';
      const status = code === 'E_WORKTREE_BUSY' ? 409 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/workspaces/:id/worktrees/dry-run-merge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = DryRunMergeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid merge pre-check payload' });
    }
    try {
      return await provider.dryRunMerge(workspace.rootPath, parsed.data.baseBranch, parsed.data.headBranch);
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_MERGE_PRECHECK_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.get('/api/v1/workspaces/:id/setup-script', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    try {
      const { provider } = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id });
      return { setupScript: await provider.inspectSetupScript(workspace.rootPath, store) };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.put('/api/v1/workspaces/:id/setup-script/trust', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const parsed = TrustSetupScriptRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid setup script trust payload' });
    try {
      const setupScript = await provider.setSetupScriptTrust(
        workspace.rootPath,
        store,
        parsed.data.sha256,
        parsed.data.trusted,
      );
      return { setupScript };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_SETUP_TRUST_FAILED';
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/workspaces/:id/setup-script/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = store.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    let provider;
    try {
      provider = resolveGitWorkspaceProvider(pluginManager, { workspaceId: workspace.id }).provider;
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(409).send({ error: mapped.message, code: mapped.code });
    }
    const body = (request.body ?? {}) as { worktreePath?: string };
    const targetDir = body.worktreePath?.trim() || workspace.rootPath;
    try {
      const result = await provider.executeTrustedSetupScript(workspace.rootPath, targetDir, store);
      return { result };
    } catch (err) {
      const code = err instanceof GitOperationError ? err.code : 'E_SETUP_EXEC_FAILED';
      const status = code === 'E_SETUP_SCRIPT_UNTRUSTED' ? 403 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });
}
