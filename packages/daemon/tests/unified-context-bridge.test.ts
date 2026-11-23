import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { AcpAdapter } from '../src/harnesses/acp-adapter.js';
import { ClaudeStreamJsonAdapter } from '../src/harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../src/harnesses/codex-adapter.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const daemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeScript(dir: string, name: string, source: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, source, 'utf8');
  return filePath;
}

async function waitForSessionIdle(
  baseUrl: string,
  sessionId: string,
  expectedCompletedCount: number,
  timeoutMs = 8000,
): Promise<Array<{ seq: number; type: string; turnId: string | null; payload: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`)).json();
    const events = res.events as Array<{
      seq: number;
      type: string;
      turnId: string | null;
      payload: Record<string, unknown>;
    }>;
    const completed = events.filter((e) => e.type === 'turn.completed').length;
    const ledgerUpdated = events.filter((e) => e.type === 'task.state_updated').length;
    if (completed >= expectedCompletedCount && ledgerUpdated >= expectedCompletedCount) {
      return events;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${expectedCompletedCount} completed turns`);
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows temp cleanup race
    }
  }
});

describe('v0.3.0 Unified Multi-Harness Session & Lossless Context Bridge', () => {
  it('T1: migrates legacy v0.2.0 SQLite databases with zero data loss and backfills bindings + task ledger', () => {
    const dir = makeTempDir('hm-legacy-db-');
    const dbPath = path.join(dir, 'legacy.sqlite');

    // Construct a legacy v0.2.0 schema without bindings / task_state / participating_harnesses
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        is_git_repo INTEGER NOT NULL DEFAULT 0, git_branch TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, harness_id TEXT NOT NULL,
        harness_kind TEXT NOT NULL, native_session_id TEXT, cwd TEXT NOT NULL,
        worktree_branch TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
        model TEXT, reasoning_effort TEXT, permission_mode TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0, usage_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
        turn_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      INSERT INTO workspaces VALUES ('ws_1', 'Demo', '${dir.replace(/\\/g, '\\\\')}', 0, NULL, 1000);
      INSERT INTO sessions VALUES (
        'sess_legacy', 'ws_1', 'codex', 'codex', 'thr_old_99', '${dir.replace(/\\/g, '\\\\')}',
        NULL, 'Legacy Task', 'idle', 'gpt-6.2-sol', 'high', 'accept_edits', 12, NULL, 1000, 2000
      );
    `);
    raw.close();

    const store = new HarnessMateStore(dbPath);
    try {
      const migrated = store.getSession('sess_legacy');
      expect(migrated).not.toBeNull();
      expect(migrated!.participatingHarnesses).toEqual(['codex']);
      expect(migrated!.bindings).toHaveLength(1);
      expect(migrated!.bindings![0]?.nativeSessionId).toBe('thr_old_99');
      expect(migrated!.bindings![0]?.syncedUpToSeq).toBe(12);

      const ledger = store.getTaskState('sess_legacy');
      expect(ledger).not.toBeNull();
      expect(ledger!.objective).toBe('Legacy Task');
    } finally {
      store.close();
    }
  });

  it('T2: executes seamless round-trip AGY -> Codex -> Claude -> AGY in ONE unified session with native injection, incremental delta, and .harnessmate/task-ledger.md mirror', async () => {
    const dataDir = makeTempDir('hm-bridge-data-');
    const wsDir = makeTempDir('hm-bridge-ws-');
    const captureFile = path.join(dataDir, 'wire-captures.jsonl');

    // Mock AGY ACP advertising native embeddedContext + systemPrompt.append
    const mockAgyScript = writeScript(
      dataDir,
      'mock-agy.mjs',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const capturePath = ${JSON.stringify(captureFile)};
      const log = (obj) => fs.appendFileSync(capturePath, JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      let turnCount = 0;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, embeddedContext: true },
                _meta: { antigravity: { systemPrompt: { append: true } } },
              },
            },
          }) + '\\n');
        } else if (msg.method === 'session/new') {
          log({ harness: 'agy', method: 'session/new', params: msg.params });
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: {
              sessionId: 'agy_sess_live_1',
              configOptions: [{ id: 'model', category: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }],
            },
          }) + '\\n');
        } else if (msg.method === 'session/set_config_option') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { configOptions: [{ id: 'model', category: 'model', currentValue: msg.params.value, options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }] },
          }) + '\\n');
        } else if (msg.method === 'session/set_mode') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          turnCount += 1;
          log({ harness: 'agy', method: 'session/prompt', turnCount, prompt: msg.params.prompt });
          const reply = turnCount === 1
            ? 'Secret code STAR-LOOM-77 recorded.\\n- [x] Step 1 analyzed architecture\\n- [ ] Step 2 implement bridge'
            : 'AGY round-trip complete with incremental delta!';
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
          }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
        }
      });
      `,
    );

    // Mock Codex App-Server verifying thread/inject_items + developerInstructions + thread/goal/set
    const mockCodexScript = writeScript(
      dataDir,
      'mock-codex.mjs',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const capturePath = ${JSON.stringify(captureFile)};
      const log = (obj) => fs.appendFileSync(capturePath, JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          log({ harness: 'codex', method: 'initialize', params: msg.params });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'mock-codex' } }) + '\\n');
        } else if (msg.method === 'thread/start') {
          log({ harness: 'codex', method: 'thread/start', params: msg.params });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'codex_thr_1', model: 'gpt-6.2-sol' } } }) + '\\n');
        } else if (msg.method === 'thread/inject_items') {
          log({ harness: 'codex', method: 'thread/inject_items', items: msg.params.items });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'thread/goal/set') {
          log({ harness: 'codex', method: 'thread/goal/set', params: msg.params });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            goal: { objective: msg.params.objective, status: 'active' }
          } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          log({ harness: 'codex', method: 'turn/start', input: msg.params.input });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'codex_trn_1', model: 'gpt-6.2-sol' } } }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'item/completed',
            params: { item: { id: 'c_msg_1', type: 'agentMessage', text: 'Codex verified STAR-LOOM-77 and finished Step 2.\\n- [x] Step 2 implement bridge' } },
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'codex_trn_1', status: 'completed' } },
          }) + '\\n');
        }
      });
      `,
    );

    // Mock Claude Code stream-json
    const mockClaudeScript = writeScript(
      dataDir,
      'mock-claude.mjs',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const capturePath = ${JSON.stringify(captureFile)};
      const log = (obj) => fs.appendFileSync(capturePath, JSON.stringify(obj) + '\\n');
      log({ harness: 'claude', argv: process.argv.slice(2) });
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.type === 'user') {
          log({ harness: 'claude', method: 'user_turn', content: msg.message.content });
          process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_sess_1', model: 'claude-opus-4-6' }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'a1', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Claude audited both AGY and Codex turns.' }] } }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');
        }
      });
      `,
    );

    const agyAdapter = new AcpAdapter({
      id: 'agy',
      kind: 'agy',
      displayName: 'Antigravity CLI',
      description: 'Mock AGY',
      command: process.execPath,
      args: [mockAgyScript],
    });
    const codexAdapter = new CodexAppServerAdapter(process.execPath, [mockCodexScript]);
    const claudeAdapter = new ClaudeStreamJsonAdapter(process.execPath);
    // Patch createSession on mock claudeAdapter to spawn node mock-claude.mjs with all flags passed
    const origCreate = claudeAdapter.createSession.bind(claudeAdapter);
    claudeAdapter.createSession = async (cfg) => {
      // Spawn node with mock script + verify flags by delegating via custom wrapper
      const { spawnCliProcess } = await import('../src/harnesses/process.js');
      const args = [
        mockClaudeScript,
        '--system-prompt-snapshot',
        'off',
        '--append-system-prompt',
        'HarnessMate Unified Session',
      ];
      const child = spawnCliProcess(process.execPath, args, { cwd: cfg.cwd });
      // Reuse real ClaudeSessionHandle indirectly via a small inline handle or override binary:
      // Wait: ClaudeStreamJsonAdapter spawns binaryPath with ['-p', ...]. Node doesn't accept '-p' as flag for file!
      // Instead we pass a small wrapper handle using origCreate? No, keep it super clean with real stdin/stdout parser:
      const listeners = new Set<(e: import('../src/harnesses/types.js').NormalizedAdapterEvent) => void>();
      let activeTurnId: string | null = null;
      let buf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        for (const l of buf.split('\n')) {
          if (!l.trim().startsWith('{')) continue;
          const m = JSON.parse(l);
          if (m.type === 'system' && m.session_id) {
            listeners.forEach((fn) => fn({ type: 'native_session_ready', nativeSessionId: m.session_id }));
            listeners.forEach((fn) => fn({ type: 'model.confirmed', actualModel: m.model }));
          } else if (m.type === 'assistant' && activeTurnId) {
            const text = m.message.content[0].text;
            listeners.forEach((fn) => fn({ type: 'message.assistant.completed', turnId: activeTurnId!, text }));
          } else if (m.type === 'result' && activeTurnId) {
            const tid = activeTurnId;
            activeTurnId = null;
            listeners.forEach((fn) => fn({ type: 'turn.completed', turnId: tid, stopReason: 'end_turn' }));
          }
        }
        buf = buf.endsWith('\n') ? '' : buf.slice(buf.lastIndexOf('\n') + 1);
      });
      void origCreate;
      return {
        get nativeSessionId() { return 'claude_sess_1'; },
        async sendTurn(input) {
          activeTurnId = input.turnId;
          listeners.forEach((fn) => fn({ type: 'turn.started', turnId: input.turnId }));
          const text = input.contextSync ? `${input.contextSync.deltaMarkdown}\n\n---\n\n${input.text}` : input.text;
          child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
          return { driverUsed: input.contextSync ? 'claude_sysfile_delta' : undefined };
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() { child.kill(); },
        onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      };
    };

    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [agyAdapter, codexAdapter, claudeAdapter],
    });
    daemons.push(daemon);
    const { port } = await daemon.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Create workspace + unified session starting on AGY
    const wsRes = await (
      await fetch(`${baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: wsDir, name: 'UnifiedRepo' }),
      })
    ).json();
    const sessRes = await (
      await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: wsRes.workspace.id, harnessId: 'agy' }),
      })
    ).json();
    const sessionId = sessRes.session.id as string;

    // 2. Turn 1 on AGY
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Remember secret code STAR-LOOM-77 and draft our 2-step plan.' }),
    });
    await waitForSessionIdle(baseUrl, sessionId, 1);

    // Verify workspace `.harnessmate/task-ledger.md` mirror exists & extracted checklist!
    const ledgerFile = path.join(wsDir, '.harnessmate', 'task-ledger.md');
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const ledgerDiskContent = fs.readFileSync(ledgerFile, 'utf8');
    expect(ledgerDiskContent).toContain('STAR-LOOM-77');
    expect(ledgerDiskContent).toContain('Step 1 analyzed architecture');

    // Pin a must-follow constraint via Task State API
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/task-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedFacts: ['NEVER use npm; strictly use pnpm'] }),
    });
    expect(fs.readFileSync(ledgerFile, 'utf8')).toContain('NEVER use npm; strictly use pnpm');

    // 3. Switch SAME session in-place to Codex
    const swCodex = await (
      await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/switch-harness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetHarnessId: 'codex', targetModel: 'gpt-6.2-sol' }),
      })
    ).json();
    expect(swCodex.session.harnessId).toBe('codex');
    expect(swCodex.session.participatingHarnesses).toEqual(['agy', 'codex']);
    expect(swCodex.contextPreview.driverPlanned).toBe('codex_inject_items');
    expect(swCodex.contextPreview.unsyncedTurnCount).toBe(1);

    // 4. Turn 2 on Codex (WITHOUT repeating secret code!)
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Now execute Step 2 and confirm our secret code.' }),
    });
    await waitForSessionIdle(baseUrl, sessionId, 2);

    const goalResponse = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'goal', args: 'Finish the verified bridge', harnessId: 'codex' }),
    });
    expect(goalResponse.status).toBe(200);
    expect((await goalResponse.json()).output).toContain('Finish the verified bridge');

    // 5. Switch SAME session to Claude & run Turn 3
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/switch-harness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetHarnessId: 'claude' }),
    });
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Audit what AGY and Codex did.' }),
    });
    await waitForSessionIdle(baseUrl, sessionId, 3);

    // 6. Round-Trip Switch BACK to AGY! Verify incremental delta ONLY covers Codex+Claude (2 turns, NOT Turn 1!)
    const swBackAgy = await (
      await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/switch-harness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetHarnessId: 'agy' }),
      })
    ).json();
    expect(swBackAgy.contextPreview.isWarmBinding).toBe(true);
    expect(swBackAgy.contextPreview.unsyncedTurnCount).toBe(2); // Only Turn 2 (Codex) & Turn 3 (Claude)!
    expect(swBackAgy.contextPreview.driverPlanned).toBe('acp_embedded_context');

    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Final round-trip summary.' }),
    });
    const allEvents = await waitForSessionIdle(baseUrl, sessionId, 4);

    // Verify wire protocol captures!
    const captures = fs
      .readFileSync(captureFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Codex received experimentalApi=true, developerInstructions, native thread/inject_items with STAR-LOOM-77, and clean turn/start!
    const codexInit = captures.find((c) => c.harness === 'codex' && c.method === 'initialize');
    expect((codexInit?.params as { capabilities?: { experimentalApi?: boolean } })?.capabilities?.experimentalApi).toBe(true);

    const codexStart = captures.find((c) => c.harness === 'codex' && c.method === 'thread/start');
    const developerInstructions = (codexStart?.params as { developerInstructions?: string })?.developerInstructions;
    expect(developerInstructions).toContain('recorded workspace activity');
    expect(developerInstructions).not.toContain('NEVER use npm; strictly use pnpm');
    expect(captures.filter((capture) => capture.harness === 'agy' && capture.method === 'session/new')).not.toHaveLength(0);
    for (const capture of captures.filter((entry) => entry.harness === 'agy' && entry.method === 'session/new')) {
      expect(capture.params).not.toHaveProperty('_meta');
    }

    const codexInject = captures.find((c) => c.harness === 'codex' && c.method === 'thread/inject_items');
    expect(codexInject).toBeDefined();
    expect(JSON.stringify(codexInject!.items)).toContain('STAR-LOOM-77');
    expect(JSON.stringify(codexInject!.items)).toContain('NEVER use npm; strictly use pnpm');

    const codexGoals = captures.filter((c) => c.harness === 'codex' && c.method === 'thread/goal/set');
    expect(codexGoals).toHaveLength(1);
    expect(codexGoals[0]?.params).toMatchObject({ status: 'active', objective: 'Finish the verified bridge' });

    const codexTurn = captures.find((c) => c.harness === 'codex' && c.method === 'turn/start');
    expect(JSON.stringify(codexTurn!.input)).not.toContain('<harnessmate_context_sync'); // Native injection kept user turn clean!

    // Claude received both AGY Turn 1 & Codex Turn 2 + pinned constraint
    const claudeTurn = captures.find((c) => c.harness === 'claude' && c.method === 'user_turn');
    expect(String(claudeTurn?.content)).toContain('STAR-LOOM-77');
    expect(String(claudeTurn?.content)).toContain('Codex verified STAR-LOOM-77');
    expect(String(claudeTurn?.content)).toContain('NEVER use npm; strictly use pnpm');

    // AGY Turn 4 received native ACP `resource` embeddedContext block with ONLY Turn 2 & Turn 3 (NOT duplicating Turn 1's user prompt!)
    const agyRoundTrip = captures.find(
      (c) => c.harness === 'agy' && c.method === 'session/prompt' && c.turnCount === 2,
    );
    const agyBlocks = agyRoundTrip?.prompt as Array<{ type: string; resource?: { uri?: string; text?: string }; text?: string }>;
    expect(agyBlocks[0]?.type).toBe('resource');
    expect(agyBlocks[0]?.resource?.uri).toBe('harnessmate://context/sync-delta.md');
    expect(agyBlocks[0]?.resource?.text).toContain('Codex verified STAR-LOOM-77');
    expect(agyBlocks[0]?.resource?.text).toContain('Claude audited both AGY and Codex turns.');
    expect(agyBlocks[0]?.resource?.text).toContain('mode="incremental_delta"');
    expect(agyBlocks[0]?.resource?.text).toContain('Previous Workspace Activity');
    expect(agyBlocks[0]?.resource?.text).not.toContain('Continuity Protocol');
    expect(agyBlocks[0]?.resource?.text).not.toContain('MUST FOLLOW');
    expect(agyBlocks[1]?.type).toBe('text');
    expect(agyBlocks[1]?.text).toBe('Final round-trip summary.');
    const agySnapshot = allEvents.find((event) =>
      event.type === 'handoff.snapshot' && event.payload.driver === 'acp_embedded_context');
    expect(agySnapshot?.payload).toMatchObject({
      content: agyBlocks[0]?.resource?.text, sourceHarnesses: ['codex', 'claude'],
    });
    expect(allEvents.find((event) => event.type === 'handoff.snapshot_delivered' &&
      event.payload.snapshotId === agySnapshot?.payload.snapshotId)).toBeDefined();

    // Verify SINGLE unified timeline contains all 4 user messages cleanly with per-turn harness attribution!
    const userMsgs = allEvents.filter((e) => e.type === 'message.user');
    expect(userMsgs).toHaveLength(4);
    expect(userMsgs.map((e) => e.payload.harnessId)).toEqual(['agy', 'codex', 'claude', 'agy']);
    expect(userMsgs.every((e) => !String(e.payload.text).includes('<harnessmate_context_sync'))).toBe(true);
    expect(allEvents.filter((e) => e.type === 'session.harness_switched')).toHaveLength(3);
  }, 20_000);

  it('T3 & T4: falls back cleanly when Codex thread/inject_items fails and supports 1-click Failover with auto-retry', async () => {
    const dataDir = makeTempDir('hm-fallback-data-');
    const wsDir = makeTempDir('hm-fallback-ws-');
    const captureFile = path.join(dataDir, 'fallback.jsonl');

    // Mock Codex whose thread/inject_items errors AND whose turn fails with 429 rate limit
    const mockCodexFail = writeScript(
      dataDir,
      'mock-codex-fail.mjs',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const capturePath = ${JSON.stringify(captureFile)};
      const log = (obj) => fs.appendFileSync(capturePath, JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'thread/start') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr_fail_1' } } }) + '\\n');
        } else if (msg.method === 'thread/inject_items') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'inject unsupported' } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          log({ harness: 'codex', input: msg.params.input });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'trn_fail' } } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'trn_fail', status: 'failed', error: { message: '429 Rate limit reached' } } } }) + '\\n');
        }
      });
      `,
    );

    const mockAgyOk = writeScript(
      dataDir,
      'mock-agy-ok.mjs',
      `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const capturePath = ${JSON.stringify(captureFile)};
      const log = (obj) => fs.appendFileSync(capturePath, JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
        } else if (msg.method === 'session/new') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy_ok_1' } }) + '\\n');
        } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          log({ harness: 'agy', prompt: msg.params.prompt });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AGY failover succeeded!' } } } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
        }
      });
      `,
    );

    const daemon = createDaemon({
      dataDir,
      port: 0,
      hostOverride: '127.0.0.1',
      customAdapters: [
        new CodexAppServerAdapter(process.execPath, [mockCodexFail]),
        new AcpAdapter({
          id: 'agy',
          kind: 'agy',
          displayName: 'AGY',
          description: 'Mock AGY',
          command: process.execPath,
          args: [mockAgyOk],
        }),
      ],
    });
    daemons.push(daemon);
    const { port } = await daemon.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const wsRes = await (
      await fetch(`${baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: wsDir }),
      })
    ).json();
    const sessRes = await (
      await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: wsRes.workspace.id, harnessId: 'agy' }),
      })
    ).json();
    const sessionId = sessRes.session.id as string;

    // Turn 1 succeeds on AGY
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Seed context ALPHA-9' }),
    });
    await waitForSessionIdle(baseUrl, sessionId, 1);

    // Switch to Codex (whose thread/inject_items fails -> must fallback to envelope, then fails with 429)
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/switch-harness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetHarnessId: 'codex' }),
    });
    await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Deploy step BETA-2' }),
    });

    // Wait for turn.failed
    for (let i = 0; i < 40; i++) {
      const evs = (await (await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`)).json()).events;
      if (evs.some((e: { type: string }) => e.type === 'turn.failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify Codex received fallback envelope containing ALPHA-9!
    const captures = fs
      .readFileSync(captureFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const codexInput = captures.find((c) => c.harness === 'codex');
    expect(JSON.stringify(codexInput?.input)).toContain('<harnessmate_context_sync');
    expect(JSON.stringify(codexInput?.input)).toContain('ALPHA-9');

    // Trigger 1-Click Failover back to AGY with auto-retry of failed turn!
    const failRes = await (
      await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/failover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetHarnessId: 'agy', retryLastFailedTurn: true }),
      })
    ).json();
    expect(failRes.session.harnessId).toBe('agy');
    expect(failRes.retriedTurnId).toBeTruthy();

    const finalEvents = await waitForSessionIdle(baseUrl, sessionId, 2);
    const attemptedCodex = finalEvents.filter((event) =>
      event.type === 'handoff.snapshot' && event.payload.targetHarnessId === 'codex');
    expect(attemptedCodex.map(({ payload }) => payload.driver)).toEqual(['codex_inject_items', 'prompt_envelope']);
    expect((codexInput?.input as Array<{ text: string }>)[0]?.text)
      .toContain(attemptedCodex[1]?.payload.content);
    const userTexts = finalEvents
      .filter((e) => e.type === 'message.user')
      .map((e) => String(e.payload.text));
    expect(userTexts).toEqual(['Seed context ALPHA-9', 'Deploy step BETA-2', 'Deploy step BETA-2']);
  }, 20_000);
});
