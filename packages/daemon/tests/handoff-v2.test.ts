import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskFailedAttemptSchema, type CanonicalEvent, type Session } from '@harnessmate/protocol';
import { ContextCompiler } from '../src/core/context-compiler.js';
import {
  HandoffRedactionError,
  HandoffRedactor,
  redactHandoffTextSync,
} from '../src/core/handoff-redactor.js';
import { composeSnapshot } from '../src/core/handoff-snapshot.js';
import { dispatchTurn } from '../src/core/outbound-gate.js';
import { readRecordedTurnEvidence, TaskLedgerService } from '../src/core/task-ledger-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { AdapterSessionHandle } from '../src/harnesses/types.js';
import { PluginEvents } from '../src/plugin-host/runtime/events.js';
import { PluginCapabilities } from '../src/plugins/plugin-capabilities.js';
import { PluginManager } from '../src/plugins/plugin-manager.js';
import { registerPluginMcp } from '../src/plugins/plugin-mcp.js';

const tempDirs: string[] = [];
const stores: HarnessMateStore[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTestStore(dir: string, name = 'test.sqlite'): HarnessMateStore {
  const store = new HarnessMateStore(path.join(dir, name));
  stores.push(store);
  return store;
}

function seedWorkspaceAndSession(
  store: HarnessMateStore,
  wsDir: string,
  opts?: {
    sessionId?: string;
    harnessId?: string;
    harnessKind?: Session['harnessKind'];
    nativeSessionId?: string | null;
    status?: Session['status'];
    participatingHarnesses?: string[];
  },
): Session {
  const now = Date.now();
  const wsId = `ws_${Math.random().toString(36).slice(2, 8)}`;
  store.createWorkspace({
    id: wsId,
    name: 'TestWorkspace',
    rootPath: wsDir,
    isGitRepo: false,
    gitBranch: null,
    createdAt: now,
  });
  return store.createSession({
    id: opts?.sessionId ?? `sess_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: wsId,
    harnessId: opts?.harnessId ?? 'codex',
    harnessKind: opts?.harnessKind ?? 'codex',
    nativeSessionId: opts?.nativeSessionId ?? null,
    participatingHarnesses: opts?.participatingHarnesses ?? [opts?.harnessId ?? 'codex'],
    contextSyncMode: 'auto',
    cwd: wsDir,
    worktreeBranch: null,
    title: 'Handoff v2 Verification',
    status: opts?.status ?? 'idle',
    model: 'gpt-6.2-sol',
    actualModel: null,
    modelReroutedReason: null,
    reasoningEffort: 'medium',
    permissionMode: 'manual',
    lastSeq: 0,
    usage: null,
    createdAt: now,
    updatedAt: now,
  });
}

function makeCompiler(
  store: HarnessMateStore,
  gitStatus?: ConstructorParameters<typeof ContextCompiler>[3],
  redactor?: HandoffRedactor,
) {
  const ledger = new TaskLedgerService(store, gitStatus ?? (() => undefined));
  const events = new PluginEvents(() => {});
  const compiler = new ContextCompiler(
    store,
    ledger,
    { budgetTokens: 12_000, autoAttach: true },
    gitStatus ?? (() => undefined),
    events,
    undefined,
    redactor,
  );
  return { compiler, ledger, events };
}

function appendTurnEvents(
  store: HarnessMateStore,
  sessionId: string,
  turnId: string,
  harnessId: string,
  userText: string,
  assistantText: string,
  tools?: Array<{
    toolCallId: string;
    toolName: string;
    toolKind: string;
    summary: string;
    input?: Record<string, unknown>;
    status?: string;
    output?: string;
    diff?: string;
  }>,
): number {
  let seq = 0;
  const now = Date.now();
  seq = store.appendEvent(sessionId, 'message.user', { harnessId, text: userText }, turnId, now).seq;
  for (const tc of tools ?? []) {
    seq = store.appendEvent(
      sessionId,
      'tool.call.started',
      {
        harnessId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        toolKind: tc.toolKind,
        summary: tc.summary,
        ...(tc.input ? { input: tc.input } : {}),
      },
      turnId,
      now + 1,
    ).seq;
    seq = store.appendEvent(
      sessionId,
      'tool.call.completed',
      {
        harnessId,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        status: tc.status ?? 'success',
        output: tc.output ?? '',
        diff: tc.diff ?? '',
      },
      turnId,
      now + 2,
    ).seq;
  }
  seq = store.appendEvent(
    sessionId,
    'message.assistant.completed',
    { harnessId, text: assistantText },
    turnId,
    now + 3,
  ).seq;
  seq = store.appendEvent(sessionId, 'turn.completed', { harnessId, stopReason: 'end_turn' }, turnId, now + 4).seq;
  return seq;
}

afterEach(async () => {
  while (apps.length > 0) {
    try {
      await apps.pop()!.close();
    } catch {
      // ignore close errors
    }
  }
  while (stores.length > 0) {
    try {
      stores.pop()!.close();
    } catch {
      // ignore close errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows temp cleanup locks
    }
  }
});

describe('Handoff Protocol v2 & Task Ledger Enhancements', () => {
  describe('1. HandoffRedactor, Snapshot, Compiler & Fail-Closed Hooks', () => {
    it('redacts all built-in secret patterns without false positives on normal IDs or double-redaction', () => {
      const sample = [
        'Normal token ID: STAR-LOOM-77',
        'OpenAI: sk-proj-abcdefghijklmnop1234567890',
        'Anthropic: sk-ant-api03-abcdefghijklmnop1234567890',
        'GitHub classic: ghp_1234567890abcdefghij123456',
        'GitHub fine: github_pat_1234567890abcdefghij_123456',
        'Slack: xoxb-1234567890-1234567890-abcdef123456',
        'Bearer header: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.sig_12345678',
        'Standalone JWT: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.signature_987654',
        'AWS Access: AKIAIOSFODNN7EXAMPLE',
        'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'PEM:\r\n-----BEGIN RSA PRIVATE KEY-----\r\nMIIEowIBAAKCAQEAtestkeydata\r\n-----END RSA PRIVATE KEY-----',
        'DB URL: postgres://admin:s3cr3tP4ss!@db.internal:5432/prod',
        'MY_API_KEY="supersecretvalue9876"',
      ].join('\n');

      const first = redactHandoffTextSync(sample);
      expect(first.text).toContain('STAR-LOOM-77');
      expect(first.text).not.toContain('sk-proj-abcdefghijklmnop1234567890');
      expect(first.text).not.toContain('sk-ant-api03-abcdefghijklmnop1234567890');
      expect(first.text).not.toContain('ghp_1234567890abcdefghij123456');
      expect(first.text).not.toContain('github_pat_1234567890abcdefghij_123456');
      expect(first.text).not.toContain('xoxb-1234567890-1234567890-abcdef123456');
      expect(first.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(first.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(first.text).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(first.text).not.toContain('MIIEowIBAAKCAQEAtestkeydata');
      expect(first.text).not.toContain('s3cr3tP4ss!');
      expect(first.text).not.toContain('supersecretvalue9876');

      expect(first.categories).toEqual(
        expect.arrayContaining([
          'pem_private_key',
          'anthropic_key',
          'openai_key',
          'aws_access_key',
          'aws_secret_key',
          'github_token',
          'slack_token',
          'bearer_token',
          'jwt_token',
          'password_url',
          'env_secret_assign',
        ]),
      );
      expect(first.redactedCount).toBe(12);

      // Idempotency: running redaction again must not double-redact placeholders
      const second = redactHandoffTextSync(first.text);
      expect(second.redactedCount).toBe(0);
      expect(second.text).toBe(first.text);
    });

    it('supports onRedact extension hooks, defense-in-depth, and fail-closed error/timeout handling', async () => {
      const redactor = new HandoffRedactor({ hookTimeoutMs: 60 });
      const dispose = redactor.registerHook((text) => ({
        text: text.replace(/CORP-SECRET-\d+/g, '[REDACTED:corp_secret]'),
        redactedCount: 1,
        categories: ['corp_secret'],
      }));

      const ok = await redactor.redact('Key CORP-SECRET-42 and sk-proj-abcdefghijklmnop1234567890', {
        sessionId: 's1',
        source: 'handoff_compile',
      });
      expect(ok.text).toBe('Key [REDACTED:corp_secret] and [REDACTED:openai_key]');
      expect(ok.redactedCount).toBe(2);
      expect(ok.categories).toEqual(expect.arrayContaining(['openai_key', 'corp_secret']));
      dispose();

      // Hook throwing error must fail closed
      redactor.registerHook(() => {
        throw new Error('custom redactor crashed');
      });
      await expect(
        redactor.redact('raw secret sk-proj-abcdefghijklmnop1234567890', {
          sessionId: 's1',
          source: 'handoff_compile',
        }),
      ).rejects.toMatchObject({ name: 'HandoffRedactionError', code: 'E_HANDOFF_REDACTION_FAILED' });

      // Hook exceeding timeout must fail closed
      const slowRedactor = new HandoffRedactor({ hookTimeoutMs: 40 });
      slowRedactor.registerHook(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('late'), 500).unref();
          }),
      );
      await expect(
        slowRedactor.redact('sensitive payload', { sessionId: 's1', source: 'mcp_session_read' }),
      ).rejects.toBeInstanceOf(HandoffRedactionError);
    });

    it('redacts composeSnapshot sections before hashing and redacts compiled ContextCompiler outputs', async () => {
      const snap = composeSnapshot([
        { id: 'workspace', source: 'git', text: 'clean' },
        { id: 'transcript', source: 'conversation', text: 'token=ghp_1234567890abcdefghij123456' },
      ]);
      expect(snap.redactedCount).toBe(1);
      expect(snap.redactedCategories).toEqual(['github_token']);
      expect(snap.sections[1]?.text).toBe('token=[REDACTED:github_token]');

      const dir = makeTempDir('hm-redact-compile-');
      const wsDir = makeTempDir('hm-redact-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, { harnessId: 'agy', harnessKind: 'agy' });
      const { compiler, ledger } = makeCompiler(store);
      compiler.registerSection('plugin.sec', { id: 'extra', text: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.abcdef123456' });
      ledger.updateManual(session, { objective: 'Deploy postgres://admin:pass1234@db.local:5432/app' });

      const seq = appendTurnEvents(
        store,
        session.id,
        't1',
        'agy',
        'Use sk-ant-api03-abcdefghijklmnop1234567890 and STAR-LOOM-77',
        'Configured AKIAIOSFODNN7EXAMPLE safely',
      );
      const latestSession = store.getSession(session.id)!;
      const packet = await compiler.compile({
        session: { ...latestSession, lastSeq: seq },
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: null,
      });

      expect(packet.deltaMarkdown).not.toContain('sk-ant-api03-abcdefghijklmnop1234567890');
      expect(packet.deltaMarkdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(packet.deltaMarkdown).not.toContain('pass1234');
      expect(packet.deltaMarkdown).toContain('STAR-LOOM-77');
      expect(packet.objective).not.toContain('pass1234');
      expect(JSON.stringify(packet.portableItems)).not.toContain('sk-ant-api03');
      expect(JSON.stringify(packet.portableItems)).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(packet.redaction?.redactedCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe('2. delivery_status = pending Crash Re-entry Guard & Side-Effect-Free Preview', () => {
    it('keeps compile() strictly read-only and forces fresh full_session_summary on pending crash recovery', async () => {
      const dir = makeTempDir('hm-pending-guard-');
      const wsDir = makeTempDir('hm-pending-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, {
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'thr_warm_99',
        participatingHarnesses: ['agy', 'codex'],
      });
      const seq1 = appendTurnEvents(store, session.id, 't1', 'agy', 'Turn 1 on AGY', 'Done turn 1');
      store.upsertSessionBinding({
        sessionId: session.id,
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'thr_warm_99',
        syncedUpToSeq: seq1,
        driverUsed: 'codex_inject_items',
        updatedAt: Date.now(),
      });
      const seq2 = appendTurnEvents(store, session.id, 't2', 'agy', 'Turn 2 on AGY', 'Done turn 2');

      const { compiler } = makeCompiler(store);
      const binding = store.getSessionBinding(session.id, 'codex');
      const currentSession = { ...store.getSession(session.id)!, lastSeq: seq2 };

      // Normal warm compile
      const warmPacket = await compiler.compile({
        session: currentSession,
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding,
      });
      expect(warmPacket.preview.isWarmBinding).toBe(true);
      expect(warmPacket.preview.unsyncedTurnCount).toBe(1);
      // Side-effect-free guarantee: compile() writes 0 rows to session_handoffs
      expect(store.listHandoffRecords(session.id)).toHaveLength(0);

      // Simulate crash right after stagePending() before confirmDelivery()
      const stagedHandoffId = warmPacket.deliveryLifecycle!.stagePending({
        turnId: 't3',
        driver: 'codex_inject_items',
      });
      expect(store.getLatestHandoffRecord(session.id, 'codex')?.deliveryStatus).toBe('pending');
      expect(stagedHandoffId).toBeTruthy();

      // Next compile() (e.g. getContextPreview after restart) must stay read-only AND trigger forceFreshNativeSession
      const countBeforePreview = store.listHandoffRecords(session.id).length;
      const recoveryPacket = await compiler.compile({
        session: currentSession,
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: store.getSessionBinding(session.id, 'codex'),
      });

      expect(store.listHandoffRecords(session.id)).toHaveLength(countBeforePreview);
      expect(store.getSessionBinding(session.id, 'codex')?.nativeSessionId).toBe('thr_warm_99');
      expect(store.getSession(session.id)?.nativeSessionId).toBe('thr_warm_99');

      expect(recoveryPacket.forceFreshNativeSession).toBe(true);
      expect(recoveryPacket.forceFreshReason).toBe('uncertain_previous_delivery');
      expect(recoveryPacket.preview.isWarmBinding).toBe(false);
      expect(recoveryPacket.preview.syncedUpToSeq).toBe(0);
      expect(recoveryPacket.preview.unsyncedTurnCount).toBe(2);
      expect(recoveryPacket.syncNeeded).toBe(true);
      expect(recoveryPacket.deltaMarkdown).toContain('mode="initial_sync"');
      expect(recoveryPacket.deltaMarkdown).toContain('uncertain_previous_delivery');

      // Now dispatchTurn executes stagePending -> injectContext -> sendTurn -> confirmDelivery
      const handle: AdapterSessionHandle = {
        nativeSessionId: 'thr_fresh_100',
        async injectContext(payload) {
          // During injectContext, persisted handoff row is 'pending' and old nativeSessionId was cleared!
          expect(store.getLatestHandoffRecord(session.id, 'codex')?.deliveryStatus).toBe('pending');
          expect(store.getSessionBinding(session.id, 'codex')?.nativeSessionId).toBeNull();
          expect(store.getSession(session.id)?.nativeSessionId).toBeNull();
          payload.onDispatch?.('codex_inject_items', payload.portableItems);
          return 'codex_inject_items';
        },
        async sendTurn() {
          return { driverUsed: 'codex_inject_items' };
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
        onEvent() {
          return () => {};
        },
      };

      const driver = await dispatchTurn(
        handle,
        { id: 'codex', kind: 'codex' },
        { turnId: 't3', text: 'Resume cleanly' },
        recoveryPacket,
        () => {},
      );
      expect(driver).toBe('codex_inject_items');
      const latest = store.getLatestHandoffRecord(session.id, 'codex')!;
      expect(latest.deliveryStatus).toBe('confirmed');
      expect(latest.confirmedAt).not.toBeNull();
      expect(latest.forceFreshReason).toBe('uncertain_previous_delivery');
      expect(latest.mode).toBe('full_session_summary');
    });

    it('marks failed and clears native binding when sendTurn fails after native injectContext', async () => {
      const dir = makeTempDir('hm-fail-delivery-');
      const wsDir = makeTempDir('hm-fail-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, {
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'thr_1',
      });
      const seq = appendTurnEvents(store, session.id, 't1', 'agy', 'Hi', 'Hello');
      const { compiler } = makeCompiler(store);
      const packet = await compiler.compile({
        session: { ...store.getSession(session.id)!, lastSeq: seq },
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: store.getSessionBinding(session.id, 'codex'),
      });

      const handle: AdapterSessionHandle = {
        nativeSessionId: 'thr_1',
        async injectContext() {
          return 'codex_inject_items';
        },
        async sendTurn() {
          throw new Error('stream disconnected');
        },
        async interrupt() {},
        async resolveApproval() {},
        async dispose() {},
        onEvent() {
          return () => {};
        },
      };

      await expect(
        dispatchTurn(handle, { id: 'codex', kind: 'codex' }, { turnId: 't2', text: 'Next' }, packet, () => {}),
      ).rejects.toThrow('stream disconnected');

      expect(store.getLatestHandoffRecord(session.id, 'codex')?.deliveryStatus).toBe('failed');
      expect(store.getSessionBinding(session.id, 'codex')?.nativeSessionId).toBeNull();
      expect(store.getSession(session.id)?.nativeSessionId).toBeNull();
    });
  });

  describe('3. Auto-Fresh Overflow, Omitted Items Guidance & Workspace Staleness Notice', () => {
    it('switches to fresh native session on warm context window overflow', async () => {
      const dir = makeTempDir('hm-autofresh-');
      const wsDir = makeTempDir('hm-autofresh-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, {
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'thr_old',
        participatingHarnesses: ['codex', 'claude'],
      });
      const seq1 = appendTurnEvents(store, session.id, 't1', 'codex', 'First task', 'First reply');
      store.upsertSessionBinding({
        sessionId: session.id,
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'thr_old',
        syncedUpToSeq: seq1,
        driverUsed: 'codex_inject_items',
        updatedAt: Date.now(),
      });
      const seq2 = appendTurnEvents(store, session.id, 't2', 'claude', 'Second task', 'Second reply');

      const { compiler } = makeCompiler(store);
      const packet = await compiler.compile({
        session: { ...store.getSession(session.id)!, lastSeq: seq2 },
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: store.getSessionBinding(session.id, 'codex'),
        modelContextWindow: 100_000,
        nativeUsedTokens: 74_500, // 100k - 74.5k - 25k reserve = 500 < 1000
        currentUserText: 'Continue',
      });

      expect(packet.forceFreshNativeSession).toBe(true);
      expect(packet.forceFreshReason).toBe('context_budget_overflow');
      expect(packet.preview.isWarmBinding).toBe(false);
      expect(packet.preview.syncedUpToSeq).toBe(0);
      expect(packet.preview.unsyncedTurnCount).toBe(2);
      expect(packet.deltaMarkdown).toContain('context_budget_overflow');
    });

    it('collects omittedItemIds (excluding reasoning, capped at 20) and injects hm_session_read guidance', async () => {
      const dir = makeTempDir('hm-omitted-');
      const wsDir = makeTempDir('hm-omitted-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, { harnessId: 'agy', harnessKind: 'agy' });

      let lastSeq = 0;
      const now = Date.now();
      for (let i = 1; i <= 30; i++) {
        const turnId = `turn_${String(i).padStart(2, '0')}`;
        const longReply = `Reply #${i}: ${'x'.repeat(900)}`;
        lastSeq = appendTurnEvents(store, session.id, turnId, 'agy', `Prompt #${i}: ${'u'.repeat(300)}`, longReply);
        store.upsertTurnItem({
          itemId: `${turnId}:user`,
          schemaVersion: 2,
          sessionId: session.id,
          turnId,
          seq: lastSeq - 1,
          instanceId: 'agy',
          driverId: 'agy',
          blockType: 'user_message',
          status: 'completed',
          title: 'User',
          textBody: `Prompt #${i}`,
          payload: {},
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: now + i,
          updatedAt: now + i,
        });
        store.upsertTurnItem({
          itemId: `${turnId}:reasoning`,
          schemaVersion: 2,
          sessionId: session.id,
          turnId,
          seq: lastSeq,
          instanceId: 'agy',
          driverId: 'agy',
          blockType: 'reasoning',
          status: 'completed',
          title: 'Reasoning',
          textBody: 'Internal chain of thought',
          payload: {},
          outputOmitted: false,
          omittedBytes: 0,
          createdAt: now + i,
          updatedAt: now + i,
        });
      }
      // Large omitted tool item in most recent turn
      store.upsertTurnItem({
        itemId: 'tool:tc_big_99',
        schemaVersion: 2,
        sessionId: session.id,
        turnId: 'turn_30',
        seq: lastSeq,
        instanceId: 'agy',
        driverId: 'agy',
        blockType: 'command_execution',
        status: 'completed',
        title: 'pnpm test',
        textBody: 'very large output',
        payload: {},
        outputOmitted: true,
        omittedBytes: 32_768,
        createdAt: now + 100,
        updatedAt: now + 100,
      });

      const { compiler } = makeCompiler(store);
      const packet = await compiler.compile({
        session: { ...store.getSession(session.id)!, lastSeq },
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: null,
        budgetTokens: 4_000,
      });

      expect(packet.omitted).toBeDefined();
      expect(packet.omitted!.count).toBeGreaterThan(20);
      expect(packet.omitted!.itemIds.length).toBe(20);
      expect(packet.omitted!.itemIds).toContain('tool:tc_big_99');
      expect(packet.omitted!.itemIds.some((id) => id.includes(':reasoning'))).toBe(false);
      expect(packet.omitted!.mcpPullAvailable).toBe(true);
      expect(packet.deltaMarkdown).toContain('hm_session_read');
      expect(JSON.stringify(packet.portableItems)).toContain('hm_session_read');
    });

    it('injects [WORKSPACE_MUTATED_SINCE_LAST_TURN] with normalized paths on cross-engine file edits', async () => {
      const dir = makeTempDir('hm-stale-ws-');
      const wsDir = makeTempDir('hm-stale-repo-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir, {
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'codex_1',
        participatingHarnesses: ['codex', 'claude'],
      });
      const seq1 = appendTurnEvents(store, session.id, 't1', 'codex', 'Start work', 'Started');
      store.upsertSessionBinding({
        sessionId: session.id,
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: 'codex_1',
        syncedUpToSeq: seq1,
        driverUsed: 'codex_inject_items',
        updatedAt: Date.now(),
      });

      // Claude edits files using both Windows backslash input path and unified diff
      const seq2 = appendTurnEvents(
        store,
        session.id,
        't2',
        'claude',
        'Edit daemon files',
        'Updated foo and bar',
        [
          {
            toolCallId: 'tc_edit_1',
            toolName: 'Edit',
            toolKind: 'file_edit',
            summary: 'Update foo.ts',
            input: { file_path: path.join(wsDir, 'packages\\daemon\\src\\foo.ts') },
            diff: '--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      );

      const { compiler } = makeCompiler(store);
      const packet = await compiler.compile({
        session: { ...store.getSession(session.id)!, lastSeq: seq2 },
        targetHarnessId: 'codex',
        targetHarnessKind: 'codex',
        binding: store.getSessionBinding(session.id, 'codex'),
      });

      expect(packet.workspaceAnchor?.mutatedSinceTargetLastTurn).toBe(true);
      expect(packet.workspaceAnchor?.mutatedFiles).toEqual(
        expect.arrayContaining(['packages/daemon/src/foo.ts', 'src/bar.ts']),
      );
      expect(packet.deltaMarkdown).toContain('[WORKSPACE_MUTATED_SINCE_LAST_TURN]');
      expect(packet.deltaMarkdown).toContain('packages/daemon/src/foo.ts');
    });
  });

  describe('4. Task Ledger failedAttempts, Conflict Merge & Read-Only Noise Filter', () => {
    it('records, deduplicates, caps failedAttempts, ignores transient turn errors, and renders directive vs reference headings', async () => {
      const dir = makeTempDir('hm-ledger-fail-');
      const wsDir = makeTempDir('hm-ledger-fail-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir);
      const ledger = new TaskLedgerService(store, () => undefined);

      // Bounds & deduplication
      const longSummary = 'S'.repeat(350);
      const longReason = 'R'.repeat(600);
      ledger.recordFailedAttempt(session, {
        summary: longSummary,
        failureReason: longReason,
        relatedFiles: ['src\\a.ts', 'src/a.ts', '.harnessmate/task-ledger.md'],
        harnessInstanceId: 'codex',
      });
      ledger.recordFailedAttempt(session, {
        summary: longSummary,
        failureReason: longReason,
        relatedFiles: ['src/b.ts'],
        harnessInstanceId: 'claude',
      });

      let state = store.getTaskState(session.id)!;
      expect(state.failedAttempts).toHaveLength(1);
      const parsed = TaskFailedAttemptSchema.parse(state.failedAttempts![0]);
      expect(parsed.summary.length).toBeLessThanOrEqual(300);
      expect(parsed.failureReason.length).toBeLessThanOrEqual(500);
      expect(parsed.relatedFiles).toEqual(['src/a.ts', 'src/b.ts']);

      // Cap at 12
      for (let i = 1; i <= 15; i++) {
        ledger.recordFailedAttempt(session, {
          summary: `Attempt #${i}`,
          failureReason: `Reason #${i}`,
        });
      }
      state = store.getTaskState(session.id)!;
      expect(state.failedAttempts).toHaveLength(12);
      expect(state.failedAttempts![11]?.summary).toBe('Attempt #15');

      const directiveMd = ledger.renderLedgerMarkdown(state, session, 'directive');
      expect(directiveMd).toContain('## Failed Attempts (DO NOT REPEAT)');
      const referenceMd = ledger.renderLedgerMarkdown(state, session, 'reference');
      expect(referenceMd).toContain('## Previously Attempted Approaches (Failed)');
      expect(referenceMd).not.toContain('MUST FOLLOW');

      // Transient 429 error ignored; real tool failure captured; ContextCompiler detects hasLedgerFacts
      const freshSession = seedWorkspaceAndSession(store, makeTempDir('hm-ledger-ingest-'));
      await ledger.ingestTurnEvents(freshSession, 't_429', 'codex', [
        {
          sessionId: freshSession.id,
          seq: 1,
          turnId: 't_429',
          type: 'turn.failed',
          payload: { message: '429 Rate limit reached' },
          createdAt: Date.now(),
        },
      ]);
      expect(store.getTaskState(freshSession.id)?.failedAttempts).toBeUndefined();

      await ledger.ingestTurnEvents(freshSession, 't_err', 'codex', [
        {
          sessionId: freshSession.id,
          seq: 2,
          turnId: 't_err',
          type: 'tool.call.started',
          payload: { toolCallId: 'tc_build', toolName: 'bash', toolKind: 'shell', summary: 'pnpm build' },
          createdAt: Date.now(),
        },
        {
          sessionId: freshSession.id,
          seq: 3,
          turnId: 't_err',
          type: 'tool.call.completed',
          payload: { toolCallId: 'tc_build', toolName: 'bash', status: 'error', output: 'TS2304: Cannot find name Foo' },
          createdAt: Date.now(),
        },
      ]);
      const errState = store.getTaskState(freshSession.id)!;
      expect(errState.failedAttempts).toHaveLength(1);
      expect(errState.failedAttempts![0]?.failureReason).toContain('TS2304');

      const { compiler } = makeCompiler(store);
      const packet = await compiler.compile({
        session: { ...freshSession, lastSeq: 3 },
        targetHarnessId: 'claude',
        targetHarnessKind: 'claude',
        binding: null,
      });
      expect(packet.syncNeeded).toBe(true);
      expect(packet.deltaMarkdown).toContain('TS2304');
    });

    it('detects external SHA-256 edits to .harnessmate/task-ledger.md and performs 3-way merge preserving custom sections', async () => {
      const dir = makeTempDir('hm-ledger-merge-');
      const wsDir = makeTempDir('hm-ledger-merge-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir);
      const ledger = new TaskLedgerService(store, () => undefined);

      ledger.updateManual(session, {
        objective: 'Initial goal',
        pinnedFacts: ['Use pnpm'],
        decisions: ['WAL mode'],
      });

      const ledgerPath = path.join(wsDir, '.harnessmate', 'task-ledger.md');
      const metaPath = path.join(wsDir, '.harnessmate', '.task-ledger-meta.json');
      expect(fs.existsSync(ledgerPath)).toBe(true);
      expect(fs.existsSync(metaPath)).toBe(true);

      // External human edit on disk (with CRLF)
      const original = fs.readFileSync(ledgerPath, 'utf8');
      const edited =
        original
          .replace('Initial goal', 'Human Refined Goal')
          .replace('- [PINNED] Use pnpm', '- [PINNED] Use pnpm\r\n- [PINNED] Never edit canonical.ts') +
        '\r\n## Human Notes\r\n\r\nCheck Windows path separators carefully.\r\n';
      fs.writeFileSync(ledgerPath, edited, 'utf8');

      // Daemon updates via ingestTurnEvents touching foo.ts
      await ledger.ingestTurnEvents(session, 't1', 'codex', [
        {
          sessionId: session.id,
          seq: 1,
          turnId: 't1',
          type: 'tool.call.started',
          payload: { toolCallId: 'tc_1', toolName: 'Edit', toolKind: 'file_edit', summary: 'edit', input: { file_path: 'src/foo.ts' } },
          createdAt: Date.now(),
        },
        {
          sessionId: session.id,
          seq: 2,
          turnId: 't1',
          type: 'tool.call.completed',
          payload: { toolCallId: 'tc_1', toolName: 'Edit', status: 'success' },
          createdAt: Date.now(),
        },
      ]);

      const merged = store.getTaskState(session.id)!;
      expect(merged.objective).toBe('Human Refined Goal');
      expect(merged.pinnedFacts).toEqual(['Use pnpm', 'Never edit canonical.ts']);
      expect(merged.touchedFiles).toContain('src/foo.ts');

      const rewritten = fs.readFileSync(ledgerPath, 'utf8');
      expect(rewritten).toContain('Human Refined Goal');
      expect(rewritten).toContain('Never edit canonical.ts');
      expect(rewritten).toContain('## Human Notes');
      expect(rewritten).toContain('Check Windows path separators carefully.');
      expect(rewritten).toContain('`src/foo.ts`');

      // Subsequent sync with no external edits keeps state clean and idempotent
      ledger.syncSession(session);
      const afterSecondSync = store.getTaskState(session.id)!;
      expect(afterSecondSync.pinnedFacts).toEqual(['Use pnpm', 'Never edit canonical.ts']);
    });

    it('filters read-only shell noise commands and deduplicates verification results', async () => {
      const dir = makeTempDir('hm-noise-');
      const wsDir = makeTempDir('hm-noise-ws-');
      const store = createTestStore(dir);
      const session = seedWorkspaceAndSession(store, wsDir);
      const ledger = new TaskLedgerService(store, () => undefined);

      const commands: Array<{ cmd: string; status?: 'success' | 'error'; output?: string }> = [
        { cmd: 'ls -la' },
        { cmd: 'cat src/test.ts' },
        { cmd: 'pwd' },
        { cmd: 'git status' },
        { cmd: 'git diff packages/daemon/tests/test.ts' },
        { cmd: 'git log --grep=build' },
        { cmd: 'rg "check" packages/' },
        { cmd: 'grep missing src/', status: 'error', output: 'exit 1' },
        { cmd: 'find . -name "*test*"' },
        { cmd: 'head -n 10 package.json' },
        { cmd: 'tail -n 20 out.log' },
        { cmd: 'echo "build test pass"' },
        { cmd: 'cd pkg && git status' },
        { cmd: 'pnpm test', status: 'error', output: '1 failed' },
        { cmd: 'pnpm --filter @harnessmate/daemon typecheck', status: 'success', output: 'ok' },
        { cmd: "Set-Location 'd:\\repo'; pnpm build", status: 'success', output: 'built' },
        { cmd: 'npx vitest run', status: 'success', output: '41 passed' },
        { cmd: 'pnpm test', status: 'success', output: 'all passed' },
      ];

      const events: CanonicalEvent[] = [];
      let seq = 1;
      for (let i = 0; i < commands.length; i++) {
        const entry = commands[i]!;
        const id = `tc_${i}`;
        events.push(
          {
            sessionId: session.id,
            seq: seq++,
            turnId: 't_noise',
            type: 'tool.call.started',
            payload: {
              toolCallId: id,
              toolName: 'bash',
              toolKind: 'shell',
              summary: entry.cmd,
              input: { command: entry.cmd },
            },
            createdAt: Date.now() + i,
          },
          {
            sessionId: session.id,
            seq: seq++,
            turnId: 't_noise',
            type: 'tool.call.completed',
            payload: {
              toolCallId: id,
              toolName: 'bash',
              status: entry.status ?? 'success',
              output: entry.output ?? '',
            },
            createdAt: Date.now() + i,
          },
        );
      }

      const state = await ledger.ingestTurnEvents(session, 't_noise', 'codex', events);
      expect(state.verifications.map((v) => v.command)).toEqual([
        'pnpm --filter @harnessmate/daemon typecheck',
        "Set-Location 'd:\\repo'; pnpm build",
        'npx vitest run',
        'pnpm test',
      ]);
      expect(state.verifications[3]?.status).toBe('pass');
      expect(state.blockers).toEqual([]);
      // grep missing src/ (read-only exit 1) must NOT create a failedAttempt; only the failed pnpm test did
      expect(state.failedAttempts?.map((a) => a.summary)).toEqual(['Shell command `pnpm test` failed']);

      const evidence = readRecordedTurnEvidence(events, wsDir);
      expect(evidence.verifications.map((v) => v.command)).toEqual([
        'pnpm --filter @harnessmate/daemon typecheck',
        "Set-Location 'd:\\repo'; pnpm build",
        'npx vitest run',
        'pnpm test',
      ]);
    });
  });

  describe('5. hm_session_read MCP Tool Conditional Exposure, Pagination & Redaction', () => {
    it('conditionally exposes hm_session_read in tools/list and enforces pagination, redaction, reasoning exclusion, and fail-closed errors', async () => {
      const dir = makeTempDir('hm-mcp-read-');
      const wsDir = makeTempDir('hm-mcp-ws-');
      const store = createTestStore(dir);
      const plugins = new PluginManager(
        path.join(dir, 'plugins'),
        new HarnessRegistry(),
        () => [],
        new Map(),
        { store },
      );
      let mcpPort = 0;
      const capabilities = new PluginCapabilities(store, plugins, () => `http://127.0.0.1:${mcpPort}/api/v1/plugin-tools`);

      const redactor = new HandoffRedactor({ hookTimeoutMs: 50 });
      const app = Fastify();
      apps.push(app);
      registerPluginMcp(app, capabilities, store, { redactor });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      mcpPort = typeof addr === 'object' && addr ? addr.port : 0;

      const session = seedWorkspaceAndSession(store, wsDir, {
        sessionId: 'sess_mcp_1',
        harnessId: 'codex',
        harnessKind: 'codex',
        status: 'running',
        participatingHarnesses: ['codex'],
      });
      const otherSession = seedWorkspaceAndSession(store, makeTempDir('hm-mcp-other-ws-'), {
        sessionId: 'sess_mcp_other',
        harnessId: 'codex',
        harnessKind: 'codex',
        status: 'running',
      });

      const lease = capabilities.openLease(session, 'codex', []);
      const token = lease.connection.token;
      const callMcp = (method: string, params?: object) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/plugin-tools',
          headers: { authorization: `Bearer ${token}` },
          payload: { jsonrpc: '2.0', id: 1, method, params },
        });

      // Initially: single-harness, no cross-harness handoffs, no omitted items -> tools/list has 0 tools
      const initialList = (await callMcp('tools/list')).json();
      expect(initialList.result.tools).toHaveLength(0);

      // Same-harness cold-start handoff record with no omitted items still keeps tools/list clean (0 tools)
      store.createHandoffRecord({
        handoffId: 'h_same_1',
        sessionId: session.id,
        turnId: 't0',
        fromInstanceId: null,
        toInstanceId: 'codex',
        mode: 'full_session_summary',
        deliveryChannel: 'native_items',
        deliveryStatus: 'confirmed',
        coveredUpToSeq: 0,
        estimatedChars: 100,
        redactedCount: 0,
        forceFreshReason: null,
        snapshot: { omittedItemIds: [] },
        createdAt: Date.now(),
        confirmedAt: Date.now(),
      });
      expect((await callMcp('tools/list')).json().result.tools).toHaveLength(0);

      // Seed items (including reasoning, secret, and large omitted output)
      const now = Date.now();
      store.upsertTurnItem({
        itemId: 'item_user_1',
        schemaVersion: 2,
        sessionId: session.id,
        turnId: 't1',
        seq: 1,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'user_message',
        status: 'completed',
        title: 'User prompt',
        textBody: 'Hello world',
        payload: {},
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: now,
        updatedAt: now,
      });
      store.upsertTurnItem({
        itemId: 'item_reason_1',
        schemaVersion: 2,
        sessionId: session.id,
        turnId: 't1',
        seq: 2,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'reasoning',
        status: 'completed',
        title: 'Internal thoughts',
        textBody: 'Hidden reasoning',
        payload: {},
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
      store.upsertTurnItem({
        itemId: 'item_tool_big',
        schemaVersion: 2,
        sessionId: session.id,
        turnId: 't1',
        seq: 3,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'command_execution',
        status: 'completed',
        title: 'Run with sk-proj-abcdefghijklmnop1234567890',
        textBody: `${'A'.repeat(120)} secret=ghp_1234567890abcdefghij123456 ${'B'.repeat(120)}`,
        payload: { envToken: 'xoxb-1234567890-1234567890-abcdef123456' },
        outputOmitted: true,
        omittedBytes: 4096,
        createdAt: now + 2,
        updatedAt: now + 2,
      });
      store.upsertTurnItem({
        itemId: 'item_other_session',
        schemaVersion: 2,
        sessionId: otherSession.id,
        turnId: 't_other',
        seq: 1,
        instanceId: 'codex',
        driverId: 'codex',
        blockType: 'user_message',
        status: 'completed',
        title: 'Other',
        textBody: 'Top secret other session',
        payload: {},
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: now + 3,
        updatedAt: now + 3,
      });

      // Now outputOmitted exists -> tools/list exposes hm_session_read with readOnlyHint: true
      const exposedList = (await callMcp('tools/list')).json();
      expect(exposedList.result.tools).toHaveLength(1);
      expect(exposedList.result.tools[0]).toMatchObject({
        name: 'hm_session_read',
        annotations: { readOnlyHint: true },
      });

      // Fetch by itemId with pagination & redaction
      const page1 = JSON.parse(
        (
          await callMcp('tools/call', {
            name: 'hm_session_read',
            arguments: { itemId: 'item_tool_big', textOffset: 0, maxChars: 180 },
          })
        ).json().result.content[0].text,
      );
      expect(page1.item.hasMore).toBe(true);
      expect(page1.item.nextTextOffset).toBe(180);
      expect(page1.item.title).not.toContain('sk-proj-');
      expect(page1.item.textBody).not.toContain('ghp_');
      expect(JSON.stringify(page1.item.payload)).not.toContain('xoxb-');

      const page2 = JSON.parse(
        (
          await callMcp('tools/call', {
            name: 'hm_session_read',
            arguments: { itemId: 'item_tool_big', textOffset: page1.item.nextTextOffset, maxChars: 500 },
          })
        ).json().result.content[0].text,
      );
      expect(page2.item.hasMore).toBe(false);
      expect(page2.item.nextTextOffset).toBeNull();

      // Range query excludes reasoning and filters by afterSeq / beforeSeq
      const range = JSON.parse(
        (
          await callMcp('tools/call', {
            name: 'hm_session_read',
            arguments: { afterSeq: 0, beforeSeq: 4, limit: 10 },
          })
        ).json().result.content[0].text,
      );
      expect(range.items.map((i: { itemId: string }) => i.itemId)).toEqual(['item_user_1', 'item_tool_big']);

      // Direct reasoning fetch rejected
      const reasoningRes = (
        await callMcp('tools/call', {
          name: 'hm_session_read',
          arguments: { itemId: 'item_reason_1' },
        })
      ).json();
      expect(reasoningRes.result.isError).toBe(true);

      // Cross-session access rejected
      const crossRes = (
        await callMcp('tools/call', {
          name: 'hm_session_read',
          arguments: { sessionId: otherSession.id, itemId: 'item_other_session' },
        })
      ).json();
      expect(crossRes.result.isError).toBe(true);

      const crossItemRes = (
        await callMcp('tools/call', {
          name: 'hm_session_read',
          arguments: { itemId: 'item_other_session' },
        })
      ).json();
      expect(crossItemRes.result.isError).toBe(true);

      // Fail-closed redactor hook error returns isError: true without leaking secrets
      const disposeFailHook = redactor.registerHook(() => {
        throw new Error('hook boom');
      });
      const failClosedRes = (
        await callMcp('tools/call', {
          name: 'hm_session_read',
          arguments: { itemId: 'item_tool_big' },
        })
      ).json();
      expect(failClosedRes.result.isError).toBe(true);
      expect(failClosedRes.result.content[0].text).not.toContain('ghp_');
      disposeFailHook();
    });
  });
});
