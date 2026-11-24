import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  CanonicalEvent,
  HarnessCapabilities,
  HarnessInfo,
  ManagedTerminalTab,
  TerminalContextChip,
  WsServerFrame,
} from '@harnessmate/protocol';
import {
  DEFAULT_RING_BUFFER_BYTES,
  MAX_CONTEXT_CHIP_BYTES,
  TERMINAL_WORKSPACE_PLUGIN_ID,
  TerminalRingBuffer,
  TerminalWorkspaceService,
  stripAnsi,
  stripAnsiAndClip,
  type TerminalBackend,
} from '../src/core/terminal-workspace-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../src/harnesses/types.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];
const openStores: HarnessMateStore[] = [];
const activeServices: TerminalWorkspaceService[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function getSqliteTotalBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) {
      total += fs.statSync(file).size;
    }
  }
  return total;
}

function createFakeBackendFactory() {
  const instances: Array<{
    emitData: (chunk: string) => void;
    emitExit: (code: number | null) => void;
    written: string[];
    resizes: Array<{ cols: number; rows: number }>;
    killed: boolean;
    interrupted: number;
  }> = [];

  const factory = () => {
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(code: number | null) => void>();
    const tracker = {
      written: [] as string[],
      resizes: [] as Array<{ cols: number; rows: number }>,
      killed: false,
      interrupted: 0,
      emitData(chunk: string) {
        for (const listener of dataListeners) listener(chunk);
      },
      emitExit(code: number | null) {
        for (const listener of exitListeners) listener(code);
      },
    };
    instances.push(tracker);

    const backend: TerminalBackend = {
      kind: 'pty',
      pid: 90_000 + instances.length,
      shell: 'mock-pty',
      write(data: string) {
        tracker.written.push(data);
      },
      resize(cols: number, rows: number) {
        tracker.resizes.push({ cols, rows });
      },
      interrupt() {
        tracker.interrupted += 1;
      },
      async kill() {
        tracker.killed = true;
      },
      onData(listener) {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    };
    return backend;
  };

  return { factory, instances };
}

function createMockHarness(id = 'mock-terminal-harness') {
  const receivedTurnInputs: TurnInput[] = [];
  const capabilities: HarnessCapabilities = {
    streaming: true,
    interactiveApproval: false,
    reasoningEfforts: ['medium'],
    permissionModes: ['manual', 'accept_edits'],
    sessionResume: false,
    sessionFork: false,
    imageInput: false,
    subagents: false,
  };

  const adapter: HarnessAdapter = {
    id,
    kind: 'codex',
    driverId: 'codex',
    displayName: 'Mock Terminal Harness',
    description: 'Captures TurnInput for terminal context chip E2E testing',
    protocolLabel: 'mock',
    capabilities,
    async probe(): Promise<HarnessInfo> {
      return {
        id,
        kind: 'codex',
        driverId: 'codex',
        displayName: 'Mock Terminal Harness',
        description: 'Mock',
        protocolLabel: 'mock',
        binaryPath: '/usr/bin/mock',
        version: '1.0.0',
        health: 'ready',
        capabilities,
        models: [{ id: 'mock-model', displayName: 'Mock Model', isDefault: true }],
        defaultModelId: 'mock-model',
      };
    },
    async createSession(_config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
      const listeners = new Set<(ev: NormalizedAdapterEvent) => void>();
      return {
        nativeSessionId: null,
        async sendTurn(input: TurnInput) {
          receivedTurnInputs.push(input);
          for (const l of listeners) l({ type: 'turn.started', turnId: input.turnId });
          for (const l of listeners) {
            l({
              type: 'message.assistant.completed',
              turnId: input.turnId,
              text: `Analyzed attached context (${input.text.length} chars)`,
            });
          }
          for (const l of listeners) {
            l({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
          }
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };

  return { adapter, receivedTurnInputs };
}

async function createTestDaemon(opts: { customAdapters?: HarnessAdapter[] } = {}): Promise<DaemonInstance> {
  const dataDir = makeTempDir('hm-term-data-');
  const daemon = createDaemon({
    dataDir,
    port: 0,
    customAdapters: opts.customAdapters,
  });
  activeDaemons.push(daemon);
  await daemon.start();
  return daemon;
}

afterEach(async () => {
  for (const svc of activeServices.splice(0)) {
    await svc.disposeAll().catch(() => {});
  }
  for (const daemon of activeDaemons.splice(0)) {
    await daemon.stop().catch(() => {});
  }
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe('Phase 4.2 Backend: Integrated PTY Terminal & Context Chips (hm.plugin.terminal-workspace)', () => {
  it('stripAnsiAndClip strips complex ANSI/OSC sequences, calculates exact 1-based line numbers, and clips strictly at 16KB', () => {
    const complexStack = [
      '\x1b]0;vitest@3.2.7\x07\x1b[2K\x1b[1G\x1b[31mFAIL\x1b[0m \x1b[1msrc/auth.test.ts\x1b[22m',
      '\x1b[31mTypeError\x1b[39m: Cannot read properties of undefined (reading \'\x1b[33mid\x1b[39m\')',
      '  at verify (\x1b]8;;file:///src/auth.ts\x1b\\src/auth.ts:44:12\x1b]8;;\x1b\\)',
      '\x1b[38;2;248;113;113merror[E0308]\x1b[0m: mismatched types in Cargo build',
      '  --> src/lib.rs:19:5\r',
    ].join('\r\n');

    expect(stripAnsi(complexStack)).not.toMatch(/\x1b|\x9b/);

    const recentClip = stripAnsiAndClip(complexStack, { recentLines: 3 });
    expect(recentClip.lineStart).toBe(3);
    expect(recentClip.lineEnd).toBe(5);
    expect(recentClip.totalLines).toBe(5);
    expect(recentClip.truncated).toBe(false);
    expect(recentClip.cleanText).toContain('at verify (src/auth.ts:44:12)');
    expect(recentClip.cleanText).toContain('--> src/lib.rs:19:5');
    expect(recentClip.cleanText).not.toMatch(/\x1b|\x9b|\r/);

    const ranged = stripAnsiAndClip(complexStack, { lineStart: 2, lineEnd: 4 });
    expect(ranged.lineStart).toBe(2);
    expect(ranged.lineEnd).toBe(4);
    expect(ranged.cleanText.split('\n')).toHaveLength(3);
    expect(ranged.cleanText).toContain("TypeError: Cannot read properties of undefined (reading 'id')");

    // Strict 16KB byte + UTF-8 multi-byte boundary test (zero broken UTF-8 chars)
    const hugeLines = Array.from({ length: 400 }, (_, i) =>
      `\x1b[31m行${i + 1}\x1b[0m: 堆栈错误信息错误描述_${'ABCD中文校验'.repeat(12)}`,
    ).join('\n');

    const cappedRecent = stripAnsiAndClip(hugeLines, { recentLines: 400 });
    expect(cappedRecent.truncated).toBe(true);
    expect(Buffer.byteLength(cappedRecent.cleanText, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_CHIP_BYTES);
    expect(cappedRecent.cleanText.length).toBeLessThanOrEqual(MAX_CONTEXT_CHIP_BYTES);
    expect(cappedRecent.cleanText).toContain('行400');
    expect(cappedRecent.cleanText).not.toContain('\ufffd');

    const cappedExplicit = stripAnsiAndClip(hugeLines, { lineStart: 1, lineEnd: 400 });
    expect(cappedExplicit.truncated).toBe(true);
    expect(Buffer.byteLength(cappedExplicit.cleanText, 'utf8')).toBeLessThanOrEqual(MAX_CONTEXT_CHIP_BYTES);
    expect(cappedExplicit.cleanText).toContain('行1:');
    expect(cappedExplicit.cleanText).not.toContain('\ufffd');
  });

  it('evicts oldest bytes at 512KB ring buffer limit and coalesces high-frequency writes in 16ms batches', async () => {
    const ring = new TerminalRingBuffer(DEFAULT_RING_BUFFER_BYTES);
    const oldest = 'OLDEST_LINE_HEADER\n' + 'X'.repeat(300_000) + '\n';
    const middle = '中文边界测试_' + 'M'.repeat(250_000) + '\n';
    const newest = 'NEWEST_SENTINEL_999\n';

    ring.push(oldest);
    ring.push(middle);
    ring.push(newest);

    expect(ring.truncated).toBe(true);
    expect(ring.byteLength).toBeLessThanOrEqual(DEFAULT_RING_BUFFER_BYTES);
    const snapshot = ring.toString();
    expect(snapshot).not.toContain('OLDEST_LINE_HEADER');
    expect(snapshot).toContain('NEWEST_SENTINEL_999');
    expect(snapshot).not.toContain('\ufffd');

    // Coalescing check over TerminalWorkspaceService
    const dataDir = makeTempDir('hm-coal-data-');
    const wsDir = makeTempDir('hm-coal-ws-');
    const store = new HarnessMateStore(path.join(dataDir, 'daemon.sqlite'));
    openStores.push(store);
    const ws = store.createWorkspace({
      id: 'ws_coal',
      name: 'coal',
      rootPath: wsDir,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });

    const mockBackend = createFakeBackendFactory();
    const svc = new TerminalWorkspaceService(store, {
      batchFlushMs: 16,
      backendFactory: mockBackend.factory,
    });
    activeServices.push(svc);

    const { terminal } = await svc.openTerminal(ws.id);
    const receivedFrames: Array<{ snapshot?: boolean; chunk: string }> = [];
    const unsub = svc.subscribeOutput(terminal.terminalId, (ev) => {
      receivedFrames.push({ snapshot: ev.snapshot, chunk: ev.chunk });
    });

    for (let i = 0; i < 400; i += 1) {
      mockBackend.instances[0]!.emitData(`chunk-${i}\n`);
    }

    await waitFor(() =>
      receivedFrames.some((f) => !f.snapshot && f.chunk.includes('chunk-399')),
    );
    unsub();

    const deltaFrames = receivedFrames.filter((f) => !f.snapshot);
    expect(deltaFrames.length).toBeGreaterThanOrEqual(1);
    expect(deltaFrames.length).toBeLessThan(15);
    expect(deltaFrames.map((f) => f.chunk).join('')).toContain('chunk-0');
    expect(deltaFrames.map((f) => f.chunk).join('')).toContain('chunk-399');
  });

  it('spawns real interactive OS shell, streams WS output, extracts ANSI chip into sendTurn, preserves legacy terminal API, and reaps 100% of child process trees', async () => {
    const mock = createMockHarness('mock-chip-harness');
    const daemon = await createTestDaemon({ customAdapters: [mock.adapter] });
    const wsDir = makeTempDir('hm-real-term-ws-');
    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'real-shell');

    const sessRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { workspaceId: ws.id, harnessId: mock.adapter.id, permissionMode: 'manual' },
    });
    expect(sessRes.statusCode).toBe(201);
    const { session } = sessRes.json() as { session: { id: string } };

    // Legacy POST /api/v1/sessions/:id/terminal still works identically
    const legacyCmd = process.platform === 'win32' ? 'Write-Output "LEGACY_OK"' : 'echo "LEGACY_OK"';
    const legacyRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/terminal`,
      payload: { command: legacyCmd },
    });
    expect(legacyRes.statusCode).toBe(200);
    expect((legacyRes.json() as { result: { stdout: string } }).result.stdout).toContain('LEGACY_OK');

    // Optional plugin disabled by default: opening terminal must reject with 409 E_PLUGIN_DISABLED
    const deniedRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/terminals`,
      payload: {},
    });
    expect(deniedRes.statusCode).toBe(409);

    await daemon.pluginManager.togglePlugin(TERMINAL_WORKSPACE_PLUGIN_ID, true);

    const addr = daemon.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const wsClient = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const wsFrames: WsServerFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      wsClient.once('open', () => resolve());
      wsClient.once('error', (err) => reject(err));
    });
    wsClient.on('message', (raw) => {
      wsFrames.push(JSON.parse(raw.toString('utf8')) as WsServerFrame);
    });

    // 1. Open real terminal #1 (PowerShell on Windows, $SHELL / /bin/sh on POSIX)
    const openRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/terminals`,
      payload: { title: 'TestRunner #1', sessionId: session.id },
    });
    expect(openRes.statusCode).toBe(201);
    const { terminal: term1 } = openRes.json() as { terminal: ManagedTerminalTab; snapshot: string };
    expect(term1.pid).toBeGreaterThan(0);
    expect(term1.status).toBe('running');
    expect(['pty', 'pipe']).toContain(term1.backend);
    expect(isPidAlive(term1.pid)).toBe(true);

    wsClient.send(JSON.stringify({ op: 'subscribe_terminal', terminalId: term1.terminalId }));

    // Emit both interactive shell output AND ANSI-colored error stack directly from the shell (no extra node spawn)
    const cmd =
      process.platform === 'win32'
        ? [
            'Write-Output "TERM_E2E_LIVE_$((20+22))"',
            'Write-Output "$([char]27)[31mFAIL$([char]27)[0m tests/login.test.ts"',
            'Write-Output "$([char]27)[33mAssertionError$([char]27)[0m: expected 401 to be 200"',
          ].join('; ') + '\r\n'
        : `printf 'TERM_E2E_LIVE_%s\\n\\033[31mFAIL\\033[0m tests/login.test.ts\\n\\033[33mAssertionError\\033[0m: expected 401 to be 200\\n' "$((20+22))"\n`;

    const inputRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/terminals/${term1.terminalId}/input`,
      payload: { data: cmd },
    });
    expect(inputRes.statusCode).toBe(200);

    await waitFor(() => {
      const snap = daemon.terminalWorkspace.getSnapshot(term1.terminalId);
      const wsSeen = wsFrames.some(
        (f) =>
          f.op === 'terminal_output' &&
          f.terminalId === term1.terminalId &&
          f.chunk.includes('expected 401 to be 200'),
      );
      return Boolean(snap?.text.includes('TERM_E2E_LIVE_42') && snap?.text.includes('expected 401 to be 200') && wsSeen);
    }, 12_000);

    // 2. Extract ANSI-cleaned TerminalContextChip -> sendTurn -> assert Mock Harness & canonical events
    const chipRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/terminals/${term1.terminalId}/context-chip`,
      payload: { recentLines: 10 },
    });
    expect(chipRes.statusCode).toBe(200);
    const { chip } = chipRes.json() as { chip: TerminalContextChip };
    expect(chip.terminalTitle).toBe('TestRunner #1');
    expect(chip.cleanText).toContain('AssertionError: expected 401 to be 200');
    expect(chip.cleanText).not.toMatch(/\x1b|\x9b/);

    const turnRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/turns`,
      payload: {
        text: '请诊断并修复该登录单测报错',
        terminalContexts: [chip],
      },
    });
    expect(turnRes.statusCode).toBe(202);
    await waitFor(() => mock.receivedTurnInputs.length === 1);

    const delivered = mock.receivedTurnInputs[0]!;
    expect(delivered.text).toContain('请诊断并修复该登录单测报错');
    expect(delivered.text).toContain('Attached Terminal Context');
    expect(delivered.text).toContain('TestRunner #1');
    expect(delivered.text).toContain(chip.cwd);
    expect(delivered.text).toContain('AssertionError: expected 401 to be 200');
    expect(delivered.text).not.toMatch(/\x1b|\x9b/);

    const events = daemon.store.getEventsAfter(session.id, 0, 100);
    expect(events.some((e: CanonicalEvent) => e.type === 'terminal.opened')).toBe(true);
    expect(events.some((e: CanonicalEvent) => e.type === 'terminal.context_attached')).toBe(true);

    // 3. Open second terminal, close term1 via REST, then disable plugin to verify zero orphan child processes
    const openRes2 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/terminals`,
      payload: { title: 'DevServer-2' },
    });
    expect(openRes2.statusCode).toBe(201);
    const { terminal: term2 } = openRes2.json() as { terminal: ManagedTerminalTab };
    expect(isPidAlive(term2.pid)).toBe(true);

    const delRes = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/v1/terminals/${term1.terminalId}`,
    });
    expect(delRes.statusCode).toBe(200);
    await waitFor(() => !isPidAlive(term1.pid), 6_000);

    await daemon.pluginManager.togglePlugin(TERMINAL_WORKSPACE_PLUGIN_ID, false);
    await waitFor(() => !isPidAlive(term2.pid), 6_000);
    expect(daemon.terminalWorkspace.listTerminals(ws.id)).toHaveLength(0);

    wsClient.close();
  }, 25_000);

  it('handles 10MB output storm with STRICTLY 0 bytes Core SQLite growth and <100ms concurrent approval/health latency', async () => {
    const dataDir = makeTempDir('hm-storm-data-');
    const wsDir = makeTempDir('hm-storm-ws-');

    const daemon = createDaemon({ dataDir, port: 0 });
    activeDaemons.push(daemon);
    await daemon.start();
    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'storm-ws');

    // Create baseline session & approval BEFORE the storm
    const fakeBackend = createFakeBackendFactory();
    const svc = new TerminalWorkspaceService(daemon.store, {
      maxRingBytes: DEFAULT_RING_BUFFER_BYTES,
      batchFlushMs: 16,
      backendFactory: fakeBackend.factory,
    });
    activeServices.push(svc);

    const { terminal } = await svc.openTerminal(ws.id, { title: 'StormTab' });
    const receivedFrames: number[] = [];
    const unsub = svc.subscribeOutput(terminal.terminalId, (ev) => {
      receivedFrames.push(Buffer.byteLength(ev.chunk, 'utf8'));
    });

    // Wait past startup backfill timer & stabilize SQLite checkpoint before measuring baseline size
    await new Promise((r) => setTimeout(r, 350));
    daemon.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const baselineDbBytes = getSqliteTotalBytes(daemon.paths.dbPath);

    // Pump >= 10MB of terminal storm chunks while running concurrent REST approvals/health queries
    const chunkPayload = `FATAL ERROR line padding ${'A'.repeat(4096)}\n`;
    const targetBytes = 10.5 * 1024 * 1024;
    let writtenBytes = 0;
    const latenciesMs: number[] = [];

    for (let wave = 0; wave < 40 && writtenBytes < targetBytes; wave += 1) {
      for (let i = 0; i < 65; i += 1) {
        fakeBackend.instances[0]!.emitData(chunkPayload);
        writtenBytes += Buffer.byteLength(chunkPayload, 'utf8');
      }
      const t0 = performance.now();
      const [approvalsRes, healthRes] = await Promise.all([
        daemon.app.inject({ method: 'GET', url: '/api/v1/approvals' }),
        daemon.app.inject({ method: 'GET', url: '/api/v1/health' }),
      ]);
      latenciesMs.push(performance.now() - t0);
      expect(approvalsRes.statusCode).toBe(200);
      expect(healthRes.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 2));
    }

    expect(writtenBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 40));
    unsub();

    const afterDbBytes = getSqliteTotalBytes(daemon.paths.dbPath);
    expect(afterDbBytes - baselineDbBytes).toBe(0);

    const tabAfter = svc.getTerminal(terminal.terminalId)!;
    expect(tabAfter.ringBufferBytes).toBeLessThanOrEqual(DEFAULT_RING_BUFFER_BYTES);

    const maxLatencyMs = Math.max(...latenciesMs);
    expect(maxLatencyMs).toBeLessThan(100);
  });

  it('rejects out-of-bounds CWD and enforces Worktree busy protection + 1-click releaseTerminalsUnderPath', async () => {
    const repoDir = makeTempDir('hm-wt-term-repo-');
    const outsideDir = makeTempDir('hm-wt-outside-');

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@harnessmate.local'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const daemon = await createTestDaemon();
    await daemon.pluginManager.togglePlugin(TERMINAL_WORKSPACE_PLUGIN_ID, true);
    const ws = await daemon.sessionManager.addWorkspace(repoDir, 'wt-repo');

    // Out-of-bounds CWD rejected
    const badCwdRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/terminals`,
      payload: { cwd: outsideDir },
    });
    expect(badCwdRes.statusCode).toBe(400);
    expect((badCwdRes.json() as { code: string }).code).toBe('E_INVALID_CWD');

    // Create Worktree
    const createWtRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/worktrees`,
      payload: { branchName: 'feat/term-lock' },
    });
    expect(createWtRes.statusCode).toBe(201);
    const { created } = createWtRes.json() as { created: { worktreePath: string; branch: string } };

    // Open terminal inside the isolated Worktree
    const openWtTermRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws.id}/terminals`,
      payload: { cwd: created.worktreePath, title: 'WT-Terminal' },
    });
    expect(openWtTermRes.statusCode).toBe(201);
    const { terminal: wtTerm } = openWtTermRes.json() as { terminal: ManagedTerminalTab };
    expect(isPidAlive(wtTerm.pid)).toBe(true);

    // Worktree listing reports blocking terminal
    const listWtRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ws.id}/worktrees`,
    });
    expect(listWtRes.statusCode).toBe(200);
    const listPayload = listWtRes.json() as {
      blockingTerminalsByPath?: Record<string, ManagedTerminalTab[]>;
    };
    const matchingKey = Object.keys(listPayload.blockingTerminalsByPath ?? {}).find(
      (k) => path.resolve(k).toLowerCase() === path.resolve(created.worktreePath).toLowerCase(),
    );
    expect(matchingKey).toBeDefined();

    // Deleting occupied Worktree returns 409 E_WORKTREE_BUSY before git removal fails
    const busyDelRes = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${ws.id}/worktrees`,
      payload: { worktreePath: created.worktreePath },
    });
    expect(busyDelRes.statusCode).toBe(409);
    expect((busyDelRes.json() as { code: string }).code).toBe('E_WORKTREE_BUSY');

    // Release blocking terminal via 1-click endpoint
    const releaseRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/terminals/release-path',
      payload: { targetPath: created.worktreePath },
    });
    expect(releaseRes.statusCode).toBe(200);
    const releaseData = releaseRes.json() as { releasedCount: number; terminalIds: string[] };
    expect(releaseData.releasedCount).toBe(1);
    expect(releaseData.terminalIds).toEqual([wtTerm.terminalId]);
    await waitFor(() => !isPidAlive(wtTerm.pid), 6_000);

    // Deleting Worktree now succeeds cleanly without Windows EBUSY
    const cleanDelRes = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${ws.id}/worktrees`,
      payload: { worktreePath: created.worktreePath, force: true },
    });
    expect(cleanDelRes.statusCode).toBe(200);
  }, 25_000);
});
