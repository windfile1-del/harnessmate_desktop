function ok(value) {
  return { ok: true, value };
}

function err(code, message) {
  return { ok: false, error: { code, message } };
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function apply(ctx) {
  const terminals = new Map();
  let seq = 0;

  async function spawnNodeLoop(workspaceId, cwd) {
    const loopScript = [
      'process.stdin.setEncoding("utf8");',
      'process.stdout.write("lite-term ready\\n");',
      'process.stdin.on("data", (chunk) => {',
      '  const line = chunk.trim();',
      '  if (!line) return;',
      '  if (line === "__EXIT__") { process.exit(0); }',
      '  process.stdout.write("lite-echo:" + line + "\\n");',
      '});',
    ].join(' ');
    return ctx.runtime.spawnCli({
      command: 'node',
      args: ['-e', loopScript],
      ...(workspaceId ? { cwdWorkspaceId: workspaceId } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }

  async function createEntry(req) {
    const terminalId = `lite_term_${++seq}`;
    const proc = await spawnNodeLoop(req.workspaceId, req.cwd);
    const entry = {
      terminalId,
      workspaceId: req.workspaceId,
      cwd: req.cwd,
      title: req.title || `Lite 终端 #${seq}`,
      pid: proc.pid,
      status: 'running',
      exitCode: null,
      snapshot: '',
      proc,
      createdAt: Date.now(),
    };
    proc.onStdout((chunk) => {
      entry.snapshot += chunk;
      if (entry.snapshot.length > 65536) {
        entry.snapshot = entry.snapshot.slice(-65536);
      }
    });
    proc.onStderr((chunk) => {
      entry.snapshot += chunk;
    });
    proc.onExit((info) => {
      entry.status = 'exited';
      entry.exitCode = typeof info?.code === 'number' ? info.code : 0;
    });
    terminals.set(terminalId, entry);
    return entry;
  }

  function toTab(entry) {
    return {
      terminalId: entry.terminalId,
      workspaceId: entry.workspaceId,
      title: entry.title,
      cwd: entry.cwd,
      backend: 'pipe',
      status: entry.status,
      pid: entry.pid ?? null,
      exitCode: entry.exitCode,
      ringBufferBytes: Buffer.byteLength(entry.snapshot, 'utf8'),
      createdAt: entry.createdAt,
    };
  }

  const service = {
    async listTerminals(req) {
      const targetCwd = req.cwd ? normalizePath(req.cwd) : '';
      const list = [];
      for (const entry of terminals.values()) {
        if (entry.workspaceId !== req.workspaceId) continue;
        if (targetCwd && normalizePath(entry.cwd) !== targetCwd) continue;
        list.push(toTab(entry));
      }
      return ok({ terminals: list, ptyAvailable: false });
    },
    async openTerminal(req) {
      const entry = await createEntry(req);
      return ok({ terminal: toTab(entry) });
    },
    async writeInput(req) {
      const entry = terminals.get(req.terminalId);
      if (!entry) return err('not_found', `终端不存在: ${req.terminalId}`);
      await entry.proc.writeStdin(req.data);
      return ok({ ok: true });
    },
    async resizeTerminal(req) {
      if (!terminals.has(req.terminalId)) return err('not_found', `终端不存在: ${req.terminalId}`);
      return ok({ ok: true });
    },
    async interruptTerminal(req) {
      const entry = terminals.get(req.terminalId);
      if (!entry) return err('not_found', `终端不存在: ${req.terminalId}`);
      await entry.proc.writeStdin('^C\n');
      return ok({ ok: true });
    },
    async restartTerminal(req) {
      const existing = terminals.get(req.terminalId);
      if (!existing) return err('not_found', `终端不存在: ${req.terminalId}`);
      await existing.proc.kill('SIGTERM').catch(() => {});
      const next = await spawnNodeLoop(existing.workspaceId, existing.cwd);
      existing.proc = next;
      existing.pid = next.pid;
      existing.status = 'running';
      existing.exitCode = null;
      existing.snapshot = '';
      next.onStdout((chunk) => {
        existing.snapshot += chunk;
      });
      next.onExit((info) => {
        existing.status = 'exited';
        existing.exitCode = typeof info?.code === 'number' ? info.code : 0;
      });
      return ok({ terminal: toTab(existing) });
    },
    async closeTerminal(req) {
      const existing = terminals.get(req.terminalId);
      if (!existing) return ok({ closed: false });
      terminals.delete(req.terminalId);
      await existing.proc.kill('SIGKILL').catch(() => {});
      return ok({ closed: true });
    },
    async buildContextChip(req) {
      const entry = terminals.get(req.terminalId);
      if (!entry) return err('not_found', `终端不存在: ${req.terminalId}`);
      const content = (req.selectedText || entry.snapshot || '').slice(-4000);
      return ok({
        chip: {
          chipId: `chip_${entry.terminalId}_${Date.now()}`,
          terminalId: entry.terminalId,
          title: entry.title,
          cwd: entry.cwd,
          excerpt: content,
          lineCount: content ? content.split(/\r?\n/).length : 0,
        },
      });
    },
    async pathUsage(req) {
      const target = normalizePath(req.targetPath);
      const busy = [];
      for (const entry of terminals.values()) {
        if (entry.status !== 'running') continue;
        const c = normalizePath(entry.cwd);
        if (c === target || c.startsWith(`${target}/`)) {
          busy.push({
            terminalId: entry.terminalId,
            title: entry.title,
            cwd: entry.cwd,
            pid: entry.pid,
            instanceId: ctx.instanceId,
          });
        }
      }
      return ok({ busy: busy.length > 0, terminals: busy });
    },
    async releasePath(req) {
      const target = normalizePath(req.targetPath);
      const released = [];
      for (const [id, entry] of [...terminals.entries()]) {
        const c = normalizePath(entry.cwd);
        if (c === target || c.startsWith(`${target}/`)) {
          terminals.delete(id);
          await entry.proc.kill('SIGKILL').catch(() => {});
          released.push(id);
        }
      }
      return ok({ closedCount: released.length, terminalIds: released });
    },
    async getOutputSnapshot(req) {
      const entry = terminals.get(req.terminalId);
      if (!entry) return err('not_found', `终端不存在: ${req.terminalId}`);
      return ok({
        snapshot: entry.snapshot,
        truncated: false,
        status: entry.status,
        exitCode: entry.exitCode,
      });
    },
  };

  ctx.provide('terminal.workspace.v1', service, {
    version: '1.0.0',
    metadata: { title: 'Terminal Lite' },
  });

  ctx.routes.register('/status', () => ({
    status: 200,
    body: { ok: true, instanceId: ctx.instanceId, count: terminals.size },
  }));
}
