import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { perfDiagnostics } from '../src/core/perf-diagnostics.js';
import { createDefaultSessionDataPlugin } from '../src/plugins/session-data-default/index.js';
import { SessionChangeFeedService } from '../src/core/session-change-feed.js';
import { HistoryImportAdapter } from '../src/core/history-import-adapter.js';
import type { SessionDataServiceV1 } from '@harnessmate/plugin-api';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  perfDiagnostics.setEnabled(false, true);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore transient Windows handle release
    }
  }
});

describe('B4-W3 SQLite tail pagination & session.data.v1 listEvents', () => {
  it('pages backward past trailing metadata events when minTurnEvents is requested without gaps', async () => {
    const dir = makeTempDir('hm-b4w3-tail-');
    const store = new HarnessMateStore(path.join(dir, 'test.db'));
    let dispose: (() => void) | void;
    try {
      const now = Date.now();
      const ws = store.createWorkspace({
        id: 'ws_tail_test',
        name: 'TailTest',
        rootPath: dir,
        isGitRepo: false,
        gitBranch: null,
        createdAt: now,
      });
      const session = store.createSession({
        id: 'sess_tail_test',
        workspaceId: ws.id,
        harnessId: 'codex',
        harnessKind: 'codex',
        nativeSessionId: null,
        title: 'Tail Session',
        cwd: dir,
        status: 'idle',
        model: 'gpt-5',
        reasoningEffort: 'medium',
        permissionMode: 'manual',
        lastSeq: 0,
        usage: null,
        pendingApprovalCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Write 100 turns (400 turn-bearing events)
      for (let i = 0; i < 100; i++) {
        const turnId = `turn-${i}`;
        store.appendEvent(session.id, 'turn.started', {}, turnId);
        store.appendEvent(session.id, 'message.user', { text: `Q ${i}` }, turnId);
        store.appendEvent(session.id, 'message.assistant.completed', { text: `A ${i}` }, turnId);
        store.appendEvent(session.id, 'turn.completed', {}, turnId);
      }
      // Append 600 trailing non-turn metadata events (like task.state_updated)
      for (let i = 0; i < 600; i++) {
        store.appendEvent(session.id, 'task.state_updated', { version: i + 1 }, null);
      }

      const total = store.getSession(session.id)!.lastSeq;
      expect(total).toBe(1000);

      // Without minTurnEvents, last 400 rows are all task.state_updated (0 turns)
      const rawTail = store.getEventsBefore(session.id, total + 1, 400, 0, 0);
      expect(rawTail).toHaveLength(400);
      expect(rawTail.every((e) => e.turnId === null)).toBe(true);

      // With minTurnEvents = 80 (~20 turns), expands cleanly back to seq 321..1000 (contiguous)
      const smartTail = store.getEventsBefore(session.id, total + 1, 400, 0, 80);
      expect(smartTail[0]!.seq).toBe(321);
      expect(smartTail[smartTail.length - 1]!.seq).toBe(1000);
      expect(smartTail).toHaveLength(680);
      for (let i = 1; i < smartTail.length; i++) {
        expect(smartTail[i]!.seq).toBe(smartTail[i - 1]!.seq + 1);
      }
      expect(store.hasEventsBefore(session.id, smartTail[0]!.seq, 0)).toBe(true);

      // Verify through default session-data plugin contract
      const changeFeed = new SessionChangeFeedService(store);
      const pluginDef = createDefaultSessionDataPlugin({
        store,
        historyImportAdapter: new HistoryImportAdapter(store),
        changeFeed,
      });
      let svc: SessionDataServiceV1 | undefined;
      const cleanups: Array<() => void> = [];
      dispose = pluginDef.apply({
        instanceId: 'hm.plugin.session-data-default',
        provide: (contract: string, impl: unknown) => {
          if (contract === 'session.data.v1') svc = impl as SessionDataServiceV1;
        },
        effect: (fn: () => (() => void) | void) => {
          const c = fn();
          if (typeof c === 'function') cleanups.push(c);
        },
      } as any);

      const page1 = await svc!.listEvents({
        sessionId: session.id,
        throughSeq: total,
        beforeSeq: total + 1,
        tail: true,
        minTurnEvents: 80,
        limit: 400,
      });
      expect(page1.ok).toBe(true);
      if (page1.ok) {
        expect(page1.value.earliestSeq).toBe(321);
        expect(page1.value.lastSeq).toBe(1000);
        expect(page1.value.hasEarlier).toBe(true);
        expect(page1.value.events.some((e) => e.turnId === 'turn-99')).toBe(true);
      }

      // Load earlier page before seq 321
      const page2 = await svc!.listEvents({
        sessionId: session.id,
        beforeSeq: 321,
        tail: true,
        limit: 400,
      });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.value.earliestSeq).toBe(1);
        expect(page2.value.lastSeq).toBe(320);
        expect(page2.value.hasEarlier).toBe(false);
      }
    } finally {
      if (typeof dispose === 'function') dispose();
      store.close();
    }
  });
});

describe('B4-W3 on-demand perfDiagnostics telemetry', () => {
  it('stays silent when disabled and records queues, subscriptions, timers and traces when enabled', () => {
    perfDiagnostics.setEnabled(false, true);
    perfDiagnostics.recordBatchFlush('runtimeCommit', {
      batchSize: 1,
      backlogMs: 2,
      trace: {
        sessionId: 's1',
        runtimeReceivedAt: 100,
        postCommitAt: 105,
      },
    });
    expect(perfDiagnostics.snapshot(true).recentTraces).toHaveLength(0);

    perfDiagnostics.setEnabled(true, true);
    perfDiagnostics.adjustSubscription('wsService', 2);
    perfDiagnostics.adjustTimer('wsServiceFlush', 1);
    perfDiagnostics.setQueueDepth('wsService', 5);
    perfDiagnostics.recordBatchFlush('wsService', {
      batchSize: 4,
      backlogMs: 18,
      queueDepthAfter: 1,
      trace: {
        sessionId: 's1',
        contract: 'session.data.v1',
        runtimeReceivedAt: 1000,
        postCommitAt: 1004,
        wsFlushedAt: 1012,
      },
    });

    const snap = perfDiagnostics.snapshot(true);
    expect(snap.enabled).toBe(true);
    expect(snap.activeSubscriptions.wsService).toBe(2);
    expect(snap.activeTimers.wsServiceFlush).toBe(1);
    expect(snap.queues.wsService.highWaterMark).toBe(5);
    expect(snap.queues.wsService.maxBacklogMs).toBe(18);
    expect(snap.queues.wsService.maxBatchSize).toBe(4);
    expect(snap.recentTraces).toHaveLength(1);
    expect(snap.recentTraces[0]!.postCommitAt).toBe(1004);
    perfDiagnostics.adjustSubscription('wsService', -2);
    perfDiagnostics.adjustTimer('wsServiceFlush', -1);
  });
});
