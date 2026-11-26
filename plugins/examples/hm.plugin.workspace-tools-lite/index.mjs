function ok(value) {
  return { ok: true, value };
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function toGitChange(line) {
  const indexStatus = line[0] ?? ' ';
  const worktreeStatus = line[1] ?? ' ';
  const rawPath = line.slice(3).trim();
  const arrow = rawPath.lastIndexOf(' -> ');
  const filePath = arrow >= 0 ? rawPath.slice(arrow + 4) : rawPath;
  return {
    path: filePath,
    indexStatus,
    worktreeStatus,
    untracked: indexStatus === '?' && worktreeStatus === '?',
  };
}

export function apply(ctx) {
  async function runCliCapture(command, args, opts = {}) {
    const proc = await ctx.runtime.spawnCli({
      command,
      args,
      ...(opts.workspaceId ? { cwdWorkspaceId: opts.workspaceId } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    const offOut = proc.onStdout((chunk) => {
      stdout += chunk;
    });
    const offErr = proc.onStderr((chunk) => {
      stderr += chunk;
    });
    const startedAt = Date.now();
    const result = await proc.wait();
    offOut();
    offErr();
    return {
      exitCode: typeof result.code === 'number' ? result.code : 1,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  async function inspectRepo(req) {
    const res = await runCliCapture('git', ['rev-parse', '--is-inside-work-tree', '--git-common-dir', '--abbrev-ref', 'HEAD'], {
      workspaceId: req.workspaceId,
      cwd: req.cwd,
    });
    if (res.exitCode !== 0) {
      return { isGitRepo: false, branch: null, repoRoot: null, gitCommonDir: null };
    }
    const lines = res.stdout.trim().split(/\r?\n/);
    const isGitRepo = lines[0]?.trim() === 'true';
    return {
      isGitRepo,
      branch: lines[2]?.trim() || null,
      repoRoot: req.cwd || null,
      gitCommonDir: lines[1]?.trim() || null,
    };
  }

  const gitWorkspaceService = {
    async getStatus(req) {
      try {
        const info = await inspectRepo(req);
        if (!info.isGitRepo) {
          return ok({
            available: true,
            reason: 'not_git_repo',
            instanceId: ctx.instanceId,
            status: {
              isGitRepo: false,
              repoRoot: null,
              gitCommonDir: null,
              branch: null,
              ahead: 0,
              behind: 0,
              changes: [],
              stagedCount: 0,
              unstagedCount: 0,
              untrackedCount: 0,
              totalChanged: 0,
            },
          });
        }
        const statusRes = await runCliCapture('git', ['status', '--porcelain=v1', '-b'], {
          workspaceId: req.workspaceId,
          cwd: req.cwd,
        });
        const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
        let branch = info.branch;
        if (lines[0]?.startsWith('## ')) {
          branch = lines[0].slice(3).split('...')[0]?.trim() || branch;
        }
        const changes = lines.filter((l) => !l.startsWith('## ')).map(toGitChange);
        return ok({
          available: true,
          instanceId: ctx.instanceId,
          status: {
            isGitRepo: true,
            repoRoot: req.cwd || null,
            gitCommonDir: info.gitCommonDir,
            branch,
            ahead: 0,
            behind: 0,
            changes,
            stagedCount: changes.filter((c) => c.indexStatus !== ' ' && !c.untracked).length,
            unstagedCount: changes.filter((c) => c.worktreeStatus !== ' ' && !c.untracked).length,
            untrackedCount: changes.filter((c) => c.untracked).length,
            totalChanged: changes.length,
          },
        });
      } catch (e) {
        return err('internal_error', e instanceof Error ? e.message : String(e));
      }
    },
    async inspect(req) {
      try {
        return ok(await inspectRepo(req));
      } catch (e) {
        return err('internal_error', e instanceof Error ? e.message : String(e));
      }
    },
    async getFileDiff(req) {
      const res = await runCliCapture('git', ['diff', '--', req.filePath], { cwd: req.cwd });
      return ok({ filePath: req.filePath, unifiedDiff: res.stdout, additions: 0, deletions: 0, isBinary: false });
    },
    async getTruthDigest(req) {
      const st = await gitWorkspaceService.getStatus({ workspaceId: req.workspaceId ?? '', cwd: req.cwd });
      return ok({ summary: st.ok ? `Workspace Tools Lite (${st.value.status?.branch ?? 'no-branch'})` : 'unavailable' });
    },
    async initRepo(req) {
      const res = await runCliCapture('git', ['init'], { cwd: req.cwd });
      return res.exitCode === 0 ? ok({ ok: true, message: 'Initialized via workspace-tools-lite' }) : err('internal_error', res.stderr);
    },
    async discardFile(req) {
      const res = await runCliCapture('git', ['checkout', '--', req.filePath], { cwd: req.cwd });
      return res.exitCode === 0 ? ok({ ok: true, message: 'Discarded' }) : err('internal_error', res.stderr);
    },
    async commit(req) {
      if (req.stageAll !== false) {
        await runCliCapture('git', ['add', '-A'], { cwd: req.cwd });
      }
      const res = await runCliCapture('git', ['commit', '-m', req.message], { cwd: req.cwd });
      return res.exitCode === 0 ? ok({ ok: true, message: res.stdout.trim() || 'Committed' }) : err('conflict', res.stderr);
    },
    async push(req) {
      const res = await runCliCapture('git', ['push', ...(req.remote ? [req.remote] : []), ...(req.branch ? [req.branch] : [])], { cwd: req.cwd });
      return res.exitCode === 0 ? ok({ ok: true, message: res.stdout.trim() || 'Pushed' }) : err('internal_error', res.stderr);
    },
    async pull(req) {
      const res = await runCliCapture('git', ['pull', ...(req.remote ? [req.remote] : []), ...(req.branch ? [req.branch] : [])], { cwd: req.cwd });
      return res.exitCode === 0 ? ok({ ok: true, message: res.stdout.trim() || 'Pulled' }) : err('internal_error', res.stderr);
    },
    async createPr() {
      return err('not_supported', 'Workspace Tools Lite 不支持远程 PR 创建');
    },
    async listWorktrees(req) {
      const res = await runCliCapture('git', ['worktree', 'list', '--porcelain'], { cwd: req.repoRoot, workspaceId: req.workspaceId });
      if (res.exitCode !== 0) return ok({ worktrees: [] });
      const blocks = res.stdout.trim().split(/\r?\n\r?\n/).filter(Boolean);
      const worktrees = blocks.map((block, index) => {
        const lines = block.split(/\r?\n/);
        const wtPath = lines.find((l) => l.startsWith('worktree '))?.slice(9).trim() ?? '';
        const headSha = lines.find((l) => l.startsWith('HEAD '))?.slice(5).trim() ?? '';
        const branchRef = lines.find((l) => l.startsWith('branch '))?.slice(7).trim() ?? null;
        return {
          path: wtPath,
          branch: branchRef ? branchRef.replace(/^refs\/heads\//, '') : null,
          headSha,
          isMain: index === 0,
          dirtyCount: 0,
          isLocked: lines.some((l) => l.startsWith('locked')),
        };
      });
      return ok({ worktrees });
    },
    async createWorktree(req) {
      const targetPath = `${req.repoRoot}/.harnessmate-lite-wt-${req.branchName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      const args = ['worktree', 'add', '-b', req.branchName, targetPath, ...(req.baseBranch ? [req.baseBranch] : [])];
      const res = await runCliCapture('git', args, { cwd: req.repoRoot, workspaceId: req.workspaceId });
      if (res.exitCode !== 0) return err('conflict', res.stderr || 'Failed to create worktree');
      return ok({ worktreePath: targetPath, branch: req.branchName });
    },
    async removeWorktree(req) {
      const args = ['worktree', 'remove', ...(req.force ? ['--force'] : []), req.worktreePath];
      const res = await runCliCapture('git', args, { cwd: req.repoRoot });
      if (res.exitCode !== 0) return err('conflict', res.stderr || 'Failed to remove worktree');
      return ok({ ok: true, message: 'Removed via workspace-tools-lite' });
    },
    async dryRunMerge() {
      return err('not_supported', 'Workspace Tools Lite 不提供 merge-tree 预检');
    },
    async getSetupScriptInfo() {
      return ok({ exists: false, relativePath: null, sha256: null, trusted: false, content: null });
    },
    async setSetupScriptTrust() {
      return ok({ exists: false, relativePath: null, sha256: null, trusted: false, content: null });
    },
    async runSetupScript() {
      return err('permission_denied', 'Workspace Tools Lite 不允许执行 .harnessmate/setup');
    },
  };

  async function listWorkspaceFilesRecursive(workspaceId, rel = '', out = [], depth = 0) {
    if (!workspaceId || depth > 4 || out.length >= 200) return out;
    let entries = [];
    try {
      entries = await ctx.fs.list(workspaceId, rel);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (out.length >= 200) break;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory) {
        await listWorkspaceFilesRecursive(workspaceId, entry.relativePath, out, depth + 1);
      } else {
        out.push({
          relativePath: entry.relativePath,
          path: entry.relativePath,
          name: entry.name,
          sizeBytes: entry.sizeBytes ?? 0,
        });
      }
    }
    return out;
  }

  const filesService = {
    async search(req) {
      if (!req.workspaceId) return err('invalid_request', '缺少 workspaceId');
      const all = await listWorkspaceFilesRecursive(req.workspaceId);
      const q = (req.query || '').trim().toLowerCase();
      const filtered = q ? all.filter((f) => f.relativePath.toLowerCase().includes(q)) : all;
      return ok({ files: filtered.slice(0, req.limit ?? 120) });
    },
    async read(req) {
      if (!req.workspaceId) return err('invalid_request', '缺少 workspaceId');
      try {
        const content = await ctx.fs.read(req.workspaceId, req.path);
        const stat = await ctx.fs.stat(req.workspaceId, req.path);
        return ok({
          path: req.path,
          relativePath: stat.relativePath || req.path,
          sizeBytes: stat.sizeBytes ?? Buffer.byteLength(content, 'utf8'),
          lineCount: content ? content.split(/\r?\n/).length : 0,
          content,
          truncated: false,
          isBinary: false,
          previewable: true,
        });
      } catch (e) {
        return err('invalid_request', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const rulesService = {
    async discover(req) {
      if (!req.workspaceId) return err('invalid_request', '缺少 workspaceId');
      const instructions = [];
      for (const candidate of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
        try {
          const stat = await ctx.fs.stat(req.workspaceId, candidate);
          if (!stat.isDirectory) {
            instructions.push({
              name: candidate,
              relativePath: stat.relativePath,
              kind: 'rules',
              sizeBytes: stat.sizeBytes,
              source: 'workspace-tools-lite',
            });
          }
        } catch {
          // ignore missing rule file
        }
      }
      try {
        const skills = await ctx.fs.list(req.workspaceId, '.agents/skills');
        for (const s of skills) {
          if (!s.isDirectory) continue;
          try {
            const skillStat = await ctx.fs.stat(req.workspaceId, `${s.relativePath}/SKILL.md`);
            instructions.push({
              name: s.name,
              relativePath: skillStat.relativePath,
              kind: 'skill',
              sizeBytes: skillStat.sizeBytes,
              source: 'workspace-tools-lite',
            });
          } catch {
            // ignore folder without SKILL.md
          }
        }
      } catch {
        // ignore missing .agents/skills
      }
      await ctx.storage.workspace.set(req.workspaceId, 'lastRulesCount', instructions.length).catch(() => {});
      return ok({ instructions });
    },
  };

  const runnerService = {
    async run(req) {
      const cmd = (req.command || '').trim();
      if (cmd === 'node --version' || cmd === 'node -v') {
        const res = await runCliCapture('node', ['--version'], { workspaceId: req.workspaceId, cwd: req.cwd });
        return ok({ ...res, output: `${res.stdout}${res.stderr}`, timedOut: false, backend: 'node-spawn' });
      }
      if (cmd.startsWith('git ')) {
        const parts = cmd.slice(4).trim().split(/\s+/).filter(Boolean);
        const res = await runCliCapture('git', parts, { workspaceId: req.workspaceId, cwd: req.cwd });
        return ok({ ...res, output: `${res.stdout}${res.stderr}`, timedOut: false, backend: 'git-spawn' });
      }
      const res = await runCliCapture('node', ['-e', 'process.stdout.write("lite-runner:" + process.argv.slice(1).join(" "))', cmd], {
        workspaceId: req.workspaceId,
        cwd: req.cwd,
      });
      return ok({ ...res, output: `${res.stdout}${res.stderr}`, timedOut: false, backend: 'node-spawn' });
    },
  };

  ctx.provide('git.workspace.v1', gitWorkspaceService, {
    version: '1.0.0',
    metadata: { title: 'Workspace Tools Lite · Git' },
  });
  ctx.provide('workspace.files.v1', filesService, {
    version: '1.0.0',
    metadata: { title: 'Workspace Tools Lite · Files' },
  });
  ctx.provide('workspace.rules.v1', rulesService, {
    version: '1.0.0',
    metadata: { title: 'Workspace Tools Lite · Rules' },
  });
  ctx.provide('terminal.runner.v1', runnerService, {
    version: '1.0.0',
    metadata: { title: 'Workspace Tools Lite · Runner' },
  });

  ctx.routes.register('/status', () => ({
    status: 200,
    body: { ok: true, instanceId: ctx.instanceId, provider: 'user.workspace-tools-lite' },
  }));
  ctx.routes.register('/git-status', async (req) => ({
    status: 200,
    body: await gitWorkspaceService.getStatus({
      workspaceId: req.query?.workspaceId || '',
      cwd: req.query?.cwd,
    }),
  }));
  ctx.routes.register('/files', async (req) => ({
    status: 200,
    body: await filesService.search({
      workspaceId: req.query?.workspaceId,
      cwd: req.query?.cwd || '',
      query: req.query?.q,
    }),
  }));
  ctx.routes.register('/rules', async (req) => ({
    status: 200,
    body: await rulesService.discover({
      workspaceId: req.query?.workspaceId,
      cwd: req.query?.cwd || '',
    }),
  }));
}
