import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessDriverIdSchema,
  HarnessKindSchema,
  type HarnessInfo,
} from '@harnessmate/protocol';
import { CommandOutputHub } from '../src/core/command-output-hub.js';
import { EffectOutboxWorker } from '../src/core/effect-outbox.js';
import { TextDeltaCoalescer } from '../src/core/text-delta-coalescer.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry, sanitizeInstanceEnv } from '../src/harnesses/registry.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../src/harnesses/types.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const daemons: DaemonInstance[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (daemons.length > 0) {
    await daemons.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class MockStreamingDriverAdapter implements HarnessAdapter {
  readonly id: string;
  readonly kind: string;
  readonly driverId: string;
  readonly continuationKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly protocolLabel = 'Mock V2 Driver';
  readonly capabilities = {
    streaming: true,
    interactiveApproval: false,
    reasoningEfforts: ['low', 'high'] as Array<'low' | 'high'>,
    permissionModes: ['manual', 'auto'] as Array<'manual' | 'auto'>,
    sessionResume: true,
    sessionFork: false,
    imageInput: false,
    subagents: false,
  };
  public nativeCommandCalls: Array<{ command: string; args: string }> = [];

  constructor(opts: { id: string; driverId: string; displayName: string; continuationKey: string }) {
    this.id = opts.id;
    this.kind = opts.driverId;
    this.driverId = opts.driverId;
    this.continuationKey = opts.continuationKey;
    this.displayName = opts.displayName;
    this.description = `Mock adapter for ${opts.driverId}`;
  }

  async probePassive(): Promise<HarnessInfo> {
    return {
      id: this.id,
      kind: this.kind,
      driverId: this.driverId,
      instanceId: this.id,
      continuationKey: this.continuationKey,
      displayName: this.displayName,
      description: this.description,
      protocolLabel: this.protocolLabel,
      binaryPath: '/usr/bin/mock-driver',
      version: '2.0.0',
      health: 'ready',
      capabilities: this.capabilities,
      models: [{ id: 'mock-r1', displayName: 'Mock R1', isDefault: true }],
      defaultModelId: 'mock-r1',
    };
  }

  async probe(): Promise<HarnessInfo> {
    return this.probePassive();
  }

  async createSession(_config: AdapterSessionConfig): Promise<AdapterSessionHandle> {
    const listeners = new Set<(event: NormalizedAdapterEvent) => void>();
    const emit = (ev: NormalizedAdapterEvent) => {
      for (const l of listeners) l(ev);
    };
    const self = this;

    return {
      nativeSessionId: `native-${this.id}-1`,
      async sendTurn(input: TurnInput) {
        emit({ type: 'turn.started', turnId: input.turnId });
        // Rapid burst of 40 token deltas (should coalesce cleanly!)
        for (let i = 0; i < 40; i++) {
          emit({ type: 'message.assistant.delta', turnId: input.turnId, text: `tok${i} ` });
        }
        // Tool execution with 30 stdout chunks (should route to CommandOutputHub, NOT session_events)
        emit({
          type: 'tool.call.started',
          turnId: input.turnId,
          toolCallId: 'tc_build_1',
          toolName: 'bash',
          toolKind: 'shell',
          summary: 'pnpm test',
        });
        for (let j = 0; j < 30; j++) {
          emit({
            type: 'tool.call.delta',
            turnId: input.turnId,
            toolCallId: 'tc_build_1',
            outputDelta: `line ${j}\n`,
          });
        }
        emit({
          type: 'tool.call.completed',
          turnId: input.turnId,
          toolCallId: 'tc_build_1',
          toolName: 'bash',
          status: 'success',
          output: 'All 30 lines succeeded',
        });
        // L3 extension block
        emit({
          type: 'turn_block.ext',
          turnId: input.turnId,
          itemId: `${input.turnId}:ext:budget`,
          blockType: 'ext:deepseek.reasoning_budget',
          title: 'DeepSeek Reasoning Budget',
          fallbackSummary: 'Used 1280 / 8192 thinking tokens',
          payload: { used: 1280, limit: 8192 },
        });
        emit({
          type: 'message.assistant.completed',
          turnId: input.turnId,
          text: 'Build passed and verified.',
        });
        emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
      },
      async runNativeCommand(command: string, args: string) {
        self.nativeCommandCalls.push({ command, args });
        return `executed ${command} ${args}`.trim();
      },
      async interrupt() {},
      async resolveApproval() {},
      async dispose() {
        listeners.clear();
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
}

describe('Phase 0 Core Foundation', () => {
  it('accepts open third-party driver IDs while rejecting malformed IDs', () => {
    expect(HarnessKindSchema.parse('codex')).toBe('codex');
    expect(HarnessKindSchema.parse('deepseek')).toBe('deepseek');
    expect(HarnessDriverIdSchema.parse('opencode.v2')).toBe('opencode.v2');
    expect(HarnessDriverIdSchema.safeParse('').success).toBe(false);
    expect(HarnessDriverIdSchema.safeParse('invalid driver id').success).toBe(false);
  });

  it('supports Instance-First multi-instance registration, env sanitization, and non-disruptive metadata updates', async () => {
    const registry = new HarnessRegistry();
    registry.registerDriver(
      'deepseek',
      (inst) =>
        new MockStreamingDriverAdapter({
          id: inst.instanceId,
          driverId: inst.driverId,
          displayName: inst.displayName,
          continuationKey: inst.continuationKey,
        }),
    );

    const work = registry.registerInstance({
      instanceId: 'deepseek-work',
      driverId: 'deepseek',
      displayName: 'DeepSeek Work',
      homeDir: '/home/work/.deepseek',
      envWhitelist: {
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        HARNESSMATE_LOCAL_TOKEN: 'should-be-stripped',
      },
      enabled: true,
    });
    const personal = registry.registerInstance({
      instanceId: 'deepseek-personal',
      driverId: 'deepseek',
      displayName: 'DeepSeek Personal',
      homeDir: '/home/personal/.deepseek',
      enabled: true,
    });

    expect(work).not.toBe(personal);
    expect(registry.getInstanceConfig('deepseek-work')?.continuationKey).toBe(
      'deepseek:home:/home/work/.deepseek',
    );
    expect(registry.getInstanceConfig('deepseek-personal')?.continuationKey).toBe(
      'deepseek:home:/home/personal/.deepseek',
    );
    expect(registry.getInstanceConfig('deepseek-work')?.sanitizedEnv).toEqual({
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    });
    expect(sanitizeInstanceEnv({ HARNESSMATE_SESSION_MCP_TOKEN: 'x', FOO: 'bar' })).toEqual({
      FOO: 'bar',
    });

    const beforeRef = registry.get('deepseek-work');
    expect(registry.updateInstanceMetadata('deepseek-work', { displayName: 'DeepSeek Work Pro' })).toBe(true);
    // Updating display metadata must NOT swap out the live adapter instance
    expect(registry.get('deepseek-work')).toBe(beforeRef);

    const infos = await registry.probeAll();
    const workInfo = infos.find((h) => h.id === 'deepseek-work');
    expect(workInfo?.displayName).toBe('DeepSeek Work Pro');
    expect(workInfo?.driverId).toBe('deepseek');
    expect(workInfo?.continuationKey).toBe('deepseek:home:/home/work/.deepseek');
  });

  it('coalesces rapid text deltas, routes stdout deltas to CommandOutputHub, and materializes TurnItems + FTS5', async () => {
    const dataDir = makeTempDir('hm-phase0-data-');
    const wsDir = makeTempDir('hm-phase0-ws-');
    const mockAdapter = new MockStreamingDriverAdapter({
      id: 'deepseek-test',
      driverId: 'deepseek',
      displayName: 'DeepSeek Test',
      continuationKey: 'deepseek:instance:deepseek-test',
    });

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [mockAdapter],
    });
    daemons.push(daemon);
    await daemon.start();

    const ws = await daemon.sessionManager.addWorkspace(wsDir, 'Phase0 Repo');
    const session = await daemon.sessionManager.createSession({
      workspaceId: ws.id,
      harnessId: 'deepseek-test',
      permissionMode: 'manual',
    });

    const streamedChunks: string[] = [];
    const unsubHub = daemon.commandOutputHub.subscribe(session.id, 'tc_build_1', (frame) => {
      if (frame.chunk) streamedChunks.push(frame.chunk);
    });

    await daemon.sessionManager.sendTurn(session.id, 'Run verification build and inspect budget');
    unsubHub();

    const events = daemon.sessionManager.getSessionEvents(session.id);
    const deltaEvents = events.filter((e) => e.type === 'message.assistant.delta');
    const toolDeltaEvents = events.filter((e) => e.type === 'tool.call.delta');

    // 40 raw token deltas coalesced into a single event before tool.call.started!
    expect(deltaEvents.length).toBe(1);
    expect(String(deltaEvents[0]?.payload.text)).toContain('tok0 ');
    expect(String(deltaEvents[0]?.payload.text)).toContain('tok39 ');
    // 30 stdout chunks stayed in CommandOutputHub — ZERO raw tool.call.delta rows in SQLite!
    expect(toolDeltaEvents.length).toBe(0);
    expect(streamedChunks.join('')).toContain('line 29\n');
    expect(daemon.commandOutputHub.getSnapshot(session.id, 'tc_build_1')?.completed).toBe(true);

    // Materialized TurnItems & SessionRuns persisted and queryable via REST + store
    const items = daemon.sessionManager.getSessionTurnItems(session.id);
    expect(items.map((i) => i.blockType)).toEqual([
      'user_message',
      'command_execution',
      'ext:deepseek.reasoning_budget',
      'assistant_text',
    ]);
    expect(items.every((i) => i.status === 'completed')).toBe(true);

    const runs = daemon.sessionManager.getSessionRuns(session.id);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.driverId).toBe('deepseek');

    // Search plugin indexes materialized items via hm.session-data.v1
    const reindexRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/search/reindex',
      headers: { authorization: `Bearer ${daemon.config.localToken}` },
      payload: { workspaceId: ws.id },
    });
    expect(reindexRes.statusCode).toBe(200);
    const searchRes = await daemon.app.inject({
      method: 'GET',
      url: '/api/v1/search/sessions?q=verification%20build',
      headers: { authorization: `Bearer ${daemon.config.localToken}` },
    });
    expect(searchRes.statusCode).toBe(200);
    const hits = (searchRes.json() as { hits: Array<{ sessionId: string }> }).hits;
    expect(hits.some((h) => h.sessionId === session.id)).toBe(true);

    // REST endpoints return materialized items and runs
    const itemsRes = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/items`,
      headers: { authorization: `Bearer ${daemon.config.localToken}` },
    });
    expect(itemsRes.statusCode).toBe(200);
    expect((itemsRes.json() as { items: unknown[] }).items.length).toBe(4);
  }, 30_000);

  it('settles orphaned runs/items and distinguishes PROCESS_BOUND vs REPLAY_SAFE outbox effects on crash recovery', async () => {
    const dataDir = makeTempDir('hm-phase0-crash-');
    const dbPath = path.join(dataDir, 'crash.db');
    const store = new HarnessMateStore(dbPath);
    const now = Date.now();

    store.createWorkspace({
      id: 'ws_1',
      name: 'Crash Test',
      rootPath: dataDir,
      isGitRepo: false,
      gitBranch: null,
      createdAt: now,
    });
    store.createSession({
      id: 'sess_1',
      workspaceId: 'ws_1',
      harnessId: 'codex',
      harnessKind: 'codex',
      nativeSessionId: 'thr_1',
      participatingHarnesses: ['codex'],
      contextSyncMode: 'auto',
      cwd: dataDir,
      title: 'Crash Test Session',
      status: 'running',
      model: 'gpt-5',
      reasoningEffort: 'high',
      permissionMode: 'manual',
      lastSeq: 0,
      usage: null,
      pendingApprovalCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    store.startSessionRun({
      runId: 'run_orphan',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      instanceId: 'codex',
      driverId: 'codex',
      model: 'gpt-5',
      status: 'running',
      startedAt: now,
    });
    store.upsertTurnItem({
      itemId: 'tool:orphan_1',
      schemaVersion: 2,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      seq: 1,
      instanceId: 'codex',
      driverId: 'codex',
      blockType: 'command_execution',
      status: 'running',
      title: 'bash',
      textBody: 'sleep 999',
      payload: {},
      outputOmitted: false,
      omittedBytes: 0,
      createdAt: now,
      updatedAt: now,
    });

    store.enqueueOutboxEffect({
      effectId: 'eff_process_bound',
      sessionId: 'sess_1',
      effectType: 'start_cli_turn',
      durability: 'PROCESS_BOUND',
      payload: { turnId: 'turn_1' },
    });
    store.enqueueOutboxEffect({
      effectId: 'eff_replay_safe',
      sessionId: 'sess_1',
      effectType: 'sync_ledger_file',
      durability: 'REPLAY_SAFE',
      payload: { sessionId: 'sess_1' },
    });
    // Simulate worker claimed both right before SIGKILL
    store.claimPendingOutboxEffects(10);

    // Simulate restart recovery
    const report = store.recoverCrashStateOnStartup();
    expect(report.settledRuns).toBe(1);
    expect(report.settledItems).toBe(1);
    expect(report.cancelledProcessBoundEffects).toBe(1);
    expect(report.requeuedReplaySafeEffects).toBe(1);

    expect(store.listSessionRuns('sess_1')[0]?.status).toBe('interrupted');
    expect(store.getTurnItem('tool:orphan_1')?.status).toBe('interrupted');

    // Outbox worker must ONLY replay REPLAY_SAFE, never PROCESS_BOUND
    const executed: string[] = [];
    const worker = new EffectOutboxWorker(store);
    worker.registerHandler('start_cli_turn', async (eff) => {
      executed.push(eff.effectId);
    });
    worker.registerHandler('sync_ledger_file', async (eff) => {
      executed.push(eff.effectId);
    });
    const drained = await worker.drainOnce();
    expect(drained.succeeded).toBe(1);
    expect(executed).toEqual(['eff_replay_safe']);

    const processBoundRow = store.listOutboxEffects('cancelled').find((e) => e.effectId === 'eff_process_bound');
    expect(processBoundRow?.status).toBe('cancelled');
    store.close();
  });

  it('TextDeltaCoalescer preserves strict ordering across channels and CommandOutputHub caps ring memory', () => {
    const batches: Array<{ channel: string; text: string }> = [];
    const coalescer = new TextDeltaCoalescer({
      windowMs: 50,
      onFlush: (b) => batches.push({ channel: b.channel, text: b.text }),
    });
    coalescer.push({ sessionId: 's1', turnId: 't1', channel: 'thinking', text: 'step1 ' , harnessId: 'codex' });
    coalescer.push({ sessionId: 's1', turnId: 't1', channel: 'thinking', text: 'step2', harnessId: 'codex' });
    // Switching channel must synchronously flush thinking before buffering assistant
    coalescer.push({ sessionId: 's1', turnId: 't1', channel: 'assistant', text: 'answer', harnessId: 'codex' });
    coalescer.flushAll();
    coalescer.dispose();

    expect(batches).toEqual([
      { channel: 'thinking', text: 'step1 step2' },
      { channel: 'assistant', text: 'answer' },
    ]);

    const hub = new CommandOutputHub({ maxRingBytes: 4096 });
    hub.append('s1', 'tc1', 'A'.repeat(3000));
    hub.append('s1', 'tc1', 'B'.repeat(3000));
    const snap = hub.getSnapshot('s1', 'tc1');
    expect(snap?.truncated).toBe(true);
    expect(Buffer.byteLength(snap!.text, 'utf8')).toBeLessThanOrEqual(4096);
    expect(snap?.text.endsWith('B'.repeat(100))).toBe(true);
  });
});
