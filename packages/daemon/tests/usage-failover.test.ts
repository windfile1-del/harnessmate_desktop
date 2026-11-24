import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessInfo, Session } from '@harnessmate/protocol';
import { FailoverCoordinator } from '../src/core/failover-service.js';
import { UsageService } from '../src/core/usage-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  AdapterUsageLimitResult,
  HarnessAdapter,
  NormalizedAdapterEvent,
} from '../src/harnesses/types.js';
import { createDaemon } from '../src/server/app.js';

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // ignore Windows transient locks
  }
}

function createFakeAdapter(opts: {
  id: string;
  driverId: string;
  displayName: string;
  readUsageLimits?: () => Promise<AdapterUsageLimitResult>;
  onSendTurn?: (
    turnId: string,
    emit: (ev: NormalizedAdapterEvent) => void,
    text: string,
  ) => void;
}): HarnessAdapter {
  const capabilities = {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high'] as Array<'low' | 'medium' | 'high'>,
    permissionModes: ['plan', 'accept_edits', 'auto'] as Array<'plan' | 'accept_edits' | 'auto'>,
    sessionResume: true,
    sessionFork: false,
    imageInput: false,
    subagents: false,
  };
  const info: HarnessInfo = {
    id: opts.id,
    kind: opts.driverId,
    driverId: opts.driverId,
    instanceId: opts.id,
    displayName: opts.displayName,
    description: `Mock adapter for ${opts.displayName}`,
    protocolLabel: `${opts.driverId}-mock`,
    binaryPath: `/mock/bin/${opts.driverId}`,
    version: '1.0.0',
    health: 'ready',
    capabilities,
    models: [{ id: `${opts.driverId}-default`, displayName: `${opts.displayName} Model`, isDefault: true }],
    defaultModelId: `${opts.driverId}-default`,
  };

  return {
    id: opts.id,
    kind: opts.driverId,
    driverId: opts.driverId,
    displayName: opts.displayName,
    description: info.description,
    protocolLabel: info.protocolLabel,
    capabilities,
    ...(opts.readUsageLimits ? { readUsageLimits: opts.readUsageLimits } : {}),
    probePassive: async () => info,
    probe: async () => info,
    async createSession(_cfg: AdapterSessionConfig): Promise<AdapterSessionHandle> {
      const listeners = new Set<(ev: NormalizedAdapterEvent) => void>();
      const emit = (ev: NormalizedAdapterEvent) => {
        for (const l of listeners) l(ev);
      };
      return {
        nativeSessionId: `nat_${opts.id}`,
        async sendTurn(input) {
          emit({ type: 'turn.started', turnId: input.turnId });
          if (opts.onSendTurn) {
            opts.onSendTurn(input.turnId, emit, input.text);
          } else {
            emit({ type: 'message.assistant.completed', turnId: input.turnId, text: `Reply from ${opts.id}` });
            emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
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
}

describe('Multi-Instance UsageService & FailoverCoordinator', () => {
  it('aggregates multiple same-driver and custom-driver instances without hardcoding and enforces 60s TTL cache', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-usage-v2-'));
    const store = new HarnessMateStore(path.join(tmpDir, 'test.sqlite'));
    const registry = new HarnessRegistry();

    let now = 1_700_000_000_000;
    let codexWorkCalls = 0;
    let codexPersonalCalls = 0;
    let deepseekCalls = 0;

    try {
      const ws = store.createWorkspace({
        id: 'ws_1',
        name: 'demo',
        rootPath: tmpDir,
        isGitRepo: false,
        gitBranch: null,
        createdAt: now,
      });

      registry.register(
        createFakeAdapter({
          id: 'codex-work',
          driverId: 'codex',
          displayName: 'Codex (Work)',
          readUsageLimits: async () => {
            codexWorkCalls += 1;
            return {
              loggedIn: true,
              accountLabel: 'work@company.com',
              planType: 'pro',
              authMethod: 'chatgpt',
              billingTier: 'subscription',
              rateLimits: [
                { label: '5 小时周期限额', usedPercent: 95, windowMinutes: 300, resetsAt: now + 3_600_000 },
              ],
            };
          },
        }),
      );

      registry.register(
        createFakeAdapter({
          id: 'codex-personal',
          driverId: 'codex',
          displayName: 'Codex (Personal)',
          readUsageLimits: async () => {
            codexPersonalCalls += 1;
            return {
              loggedIn: true,
              accountLabel: 'me@personal.dev',
              planType: 'plus',
              authMethod: 'chatgpt',
              billingTier: 'subscription',
              rateLimits: [
                { label: '5 小时周期限额', usedPercent: 18, windowMinutes: 300, resetsAt: now + 7_200_000 },
              ],
            };
          },
        }),
      );

      registry.register(
        createFakeAdapter({
          id: 'deepseek-api',
          driverId: 'deepseek',
          displayName: 'DeepSeek API',
          readUsageLimits: async () => {
            deepseekCalls += 1;
            return {
              loggedIn: true,
              accountLabel: 'deepseek-key',
              planType: 'payg',
              authMethod: 'api_key',
              billingTier: 'api_payg',
              rateLimits: [],
            };
          },
        }),
      );

      // Custom driver WITHOUT readUsageLimits() must degrade gracefully to local SQLite stats
      registry.register(
        createFakeAdapter({
          id: 'ollama-local',
          driverId: 'ollama',
          displayName: 'Ollama Local',
        }),
      );

      // Seed local session_runs for codex-work and ollama-local
      const s1 = store.createSession({
        id: 'sess_usage_1',
        workspaceId: ws.id,
        harnessId: 'codex-work',
        harnessKind: 'codex',
        participatingHarnesses: ['codex-work', 'ollama-local'],
        contextSyncMode: 'auto',
        cwd: tmpDir,
        title: 'Work Task',
        status: 'idle',
        model: 'gpt-5',
        reasoningEffort: null,
        permissionMode: 'accept_edits',
        nativeSessionId: null,
        lastSeq: 2,
        usage: null,
        pendingApprovalCount: 0,
        createdAt: now - 20_000,
        updatedAt: now,
      });
      store.startSessionRun({
        runId: 'run_1',
        sessionId: s1.id,
        turnId: 't1',
        instanceId: 'codex-work',
        driverId: 'codex',
        model: 'gpt-5',
        status: 'completed',
        usage: { inputTokens: 12000, outputTokens: 3000, cachedTokens: 6000, costUsd: 0.04 },
        startedAt: now - 10_000,
        endedAt: now - 5_000,
      });
      store.startSessionRun({
        runId: 'run_2',
        sessionId: s1.id,
        turnId: 't2',
        instanceId: 'ollama-local',
        driverId: 'ollama',
        model: 'qwen2.5-coder',
        status: 'completed',
        usage: { inputTokens: 4500, outputTokens: 1500, costUsd: 0 },
        startedAt: now - 4_000,
        endedAt: now - 1_000,
      });

      const usageService = new UsageService(store, registry, { ttlMs: 60_000, now: () => now });

      // First call probes all adapters implementing readUsageLimits
      const first = await usageService.collectAccountUsage();
      expect(first.map((a) => a.instanceId)).toEqual([
        'codex-work',
        'codex-personal',
        'deepseek-api',
        'ollama-local',
      ]);
      expect(codexWorkCalls).toBe(1);
      expect(codexPersonalCalls).toBe(1);
      expect(deepseekCalls).toBe(1);

      const workSnap = first.find((a) => a.instanceId === 'codex-work')!;
      expect(workSnap.accountLabel).toBe('work@company.com');
      expect(workSnap.billingTier).toBe('subscription');
      expect(workSnap.localInputTokens).toBe(12000);
      expect(workSnap.localCachedTokens).toBe(6000);
      expect(workSnap.cached).toBe(false);

      const ollamaSnap = first.find((a) => a.instanceId === 'ollama-local')!;
      expect(ollamaSnap.error).toBeUndefined();
      expect(ollamaSnap.localInputTokens).toBe(4500);
      expect(ollamaSnap.localOutputTokens).toBe(1500);

      // Second call within 60s TTL must hit cache without re-invoking adapters
      now += 30_000;
      const cached = await usageService.collectAccountUsage();
      expect(codexWorkCalls).toBe(1);
      expect(codexPersonalCalls).toBe(1);
      expect(deepseekCalls).toBe(1);
      expect(cached.find((a) => a.instanceId === 'codex-work')?.cached).toBe(true);

      // Force refresh bypasses TTL
      await usageService.collectAccountUsage({ forceRefresh: true });
      expect(codexWorkCalls).toBe(2);

      // Advancing past 60s expires TTL
      now += 61_000;
      await usageService.collectAccountUsage();
      expect(codexWorkCalls).toBe(3);
    } finally {
      store.close();
      safeRmSync(tmpDir);
    }
  });

  it('enforces FailoverPolicy priority chain, subscription->API cost guard, ping-pong guard, and quota reset recovery', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-failover-v2-'));
    const store = new HarnessMateStore(path.join(tmpDir, 'test.sqlite'));
    const registry = new HarnessRegistry();
    let now = 1_700_000_000_000;

    try {
      registry.register(createFakeAdapter({ id: 'codex-work', driverId: 'codex', displayName: 'Codex Work' }));
      registry.register(createFakeAdapter({ id: 'codex-personal', driverId: 'codex', displayName: 'Codex Personal' }));
      registry.register(createFakeAdapter({ id: 'deepseek-api', driverId: 'deepseek', displayName: 'DeepSeek API' }));

      const usageService = new UsageService(store, registry, { now: () => now });
      const failover = new FailoverCoordinator(store, registry, () => usageService, { now: () => now });

      failover.setPolicy({
        mode: 'auto_same_tier',
        priorityChain: ['codex-work', 'codex-personal', 'deepseek-api'],
        maxAutoSwitchesPerSession: 2,
        autoRetryInterruptedPrompt: true,
        notifyOnQuotaReset: true,
      });

      const tiers = {
        'codex-work': 'subscription' as const,
        'codex-personal': 'subscription' as const,
        'deepseek-api': 'api_payg' as const,
      };

      // 1. codex-work hits usage_limit -> auto-recommends same-tier codex-personal
      failover.recordFailure('codex-work', 'usage_limit', now + 60_000);
      const rec1 = failover.recommendFailover('sess_1', 'codex-work', 'usage_limit', {
        billingTierByInstance: tiers,
      });
      expect(rec1.recommendedInstanceId).toBe('codex-personal');
      expect(rec1.canAutoFailover).toBe(true);
      failover.recordAutoSwitch('sess_1');

      // 2. codex-personal also hits usage_limit -> next is deepseek-api (api_payg), cost guardrail downgrades to manual!
      failover.recordFailure('codex-personal', 'usage_limit', now + 120_000);
      const rec2 = failover.recommendFailover('sess_1', 'codex-personal', 'usage_limit', {
        billingTierByInstance: tiers,
      });
      expect(rec2.recommendedInstanceId).toBe('deepseek-api');
      expect(rec2.canAutoFailover).toBe(false);
      expect(rec2.downgradedToManualReason).toContain('成本护栏');

      // 3. Ping-pong guard blocks auto-failover once maxAutoSwitchesPerSession (2) is reached
      failover.recordAutoSwitch('sess_1');
      failover.setPolicy({ mode: 'auto_any' });
      const rec3 = failover.recommendFailover('sess_1', 'codex-personal', 'usage_limit', {
        billingTierByInstance: tiers,
      });
      expect(rec3.pingPongBlocked).toBe(true);
      expect(rec3.canAutoFailover).toBe(false);

      // 4. Quota reset recovery frees codex-work once resetsAt elapses
      now += 61_000;
      const recovered = failover.checkQuotaResets();
      expect(recovered.map((r) => r.instanceId)).toEqual(['codex-work']);
      expect(failover.getCooldown('codex-work')).toBeUndefined();
    } finally {
      store.close();
      safeRmSync(tmpDir);
    }
  });

  it('runs end-to-end daemon rate-limit failover loop, paginated omitted item fetch, and hm_render_html', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-p2-'));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-repo-'));

    const bigOutput = 'LINE_DATA_'.repeat(3000); // ~30KB (> 16KB threshold)

    const primaryAdapter = createFakeAdapter({
      id: 'vendor-primary',
      driverId: 'vendor_a',
      displayName: 'Vendor Primary',
      readUsageLimits: async () => ({
        loggedIn: true,
        accountLabel: 'primary@example.com',
        planType: 'team',
        authMethod: 'oauth',
        billingTier: 'subscription',
        rateLimits: [{ label: '5h window', usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() + 60_000 }],
      }),
      onSendTurn(turnId, emit) {
        emit({
          type: 'tool.call.started',
          turnId,
          toolCallId: 'tc_big',
          toolName: 'Bash',
          toolKind: 'shell',
          summary: 'cat huge.log',
        });
        emit({
          type: 'tool.call.completed',
          turnId,
          toolCallId: 'tc_big',
          toolName: 'Bash',
          status: 'success',
          output: bigOutput,
        });
        emit({
          type: 'turn.failed',
          turnId,
          code: 'usage_limit',
          message: 'Rate limit exceeded (429)',
        });
      },
    });

    const backupAdapter = createFakeAdapter({
      id: 'vendor-backup',
      driverId: 'vendor_b',
      displayName: 'Vendor Backup',
      readUsageLimits: async () => ({
        loggedIn: true,
        accountLabel: 'backup@example.com',
        planType: 'pro',
        authMethod: 'oauth',
        billingTier: 'subscription',
        rateLimits: [{ label: '5h window', usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() + 3600_000 }],
      }),
      onSendTurn(turnId, emit, text) {
        emit({
          type: 'message.assistant.completed',
          turnId,
          text: `Recovered by backup for: ${text}`,
        });
        emit({ type: 'turn.completed', turnId, stopReason: 'end_turn' });
      },
    });

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [primaryAdapter, backupAdapter],
    });

    try {
      await daemon.start();
      const ws = await daemon.sessionManager.addWorkspace(repoDir);

      // Configure failover policy via REST
      const putPolicy = await daemon.app.inject({
        method: 'PUT',
        url: '/api/v1/usage/failover-policy',
        payload: {
          mode: 'manual_one_click',
          priorityChain: ['vendor-primary', 'vendor-backup'],
          maxAutoSwitchesPerSession: 2,
          autoRetryInterruptedPrompt: true,
          notifyOnQuotaReset: true,
        },
      });
      expect(putPolicy.statusCode).toBe(200);

      // Create session on vendor-primary and send a turn that emits huge tool output then fails with usage_limit
      const session = await daemon.sessionManager.createSession({
        workspaceId: ws.id,
        harnessId: 'vendor-primary',
        permissionMode: 'auto',
      });
      await daemon.sessionManager.sendTurn(session.id, 'Run full diagnostic', undefined, {
        turnOptions: { fastMode: true },
      });

      // 1. Verify GET /items returns trimmed output with outputOmitted: true and GET /items/:itemId paginates full output
      const itemsRes = await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/items`,
      });
      expect(itemsRes.statusCode).toBe(200);
      const itemsBody = itemsRes.json() as { items: Array<{ itemId: string; outputOmitted: boolean; textBody: string }> };
      const bigItem = itemsBody.items.find((i) => i.itemId === 'tool:tc_big');
      expect(bigItem?.outputOmitted).toBe(true);
      expect(bigItem?.textBody.length).toBeLessThanOrEqual(16_384);

      const page1Res = await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/items/${encodeURIComponent('tool:tc_big')}?textOffset=0&maxChars=20000`,
      });
      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json() as { text: string; totalChars: number; hasMore: boolean; nextTextOffset: number | null };
      expect(page1.totalChars).toBe(bigOutput.length);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextTextOffset).toBe(20000);

      const page2Res = await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/items/${encodeURIComponent('tool:tc_big')}?textOffset=20000&maxChars=20000`,
      });
      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json() as { text: string; hasMore: boolean };
      expect(page1.text + page2.text).toBe(bigOutput);
      expect(page2.hasMore).toBe(false);

      // 2. Verify failover recommendation picks vendor-backup
      const recRes = await daemon.app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/failover-recommendation?failedInstanceId=vendor-primary&failureClass=usage_limit`,
      });
      expect(recRes.statusCode).toBe(200);
      const recJson = recRes.json() as { recommendation: { recommendedInstanceId: string } };
      expect(recJson.recommendation.recommendedInstanceId).toBe('vendor-backup');

      // 3. Execute 1-click failover with context handoff + automatic retry of interrupted turn
      const foRes = await daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/failover`,
        payload: { targetHarnessId: 'vendor-backup', retryLastFailedTurn: true },
      });
      expect(foRes.statusCode).toBe(200);
      const foBody = foRes.json() as { session: { harnessId: string }; retriedTurnId: string | null };
      expect(foBody.session.harnessId).toBe('vendor-backup');
      expect(foBody.retriedTurnId).toBeTruthy();

      const events = daemon.sessionManager.getSessionEvents(session.id, 0);
      expect(
        events.some(
          (e) =>
            e.type === 'message.assistant.completed' &&
            String(e.payload.text).includes('Recovered by backup'),
        ),
      ).toBe(true);

      // 4. Verify hm_render_html MCP tool persists html_render TurnBlockRecord & rejects >512KB payloads
      const lease = (daemon.sessionManager as unknown as {
        pluginCapabilities: { issueLease: (s: Session, h: string) => { token: string } };
      }).pluginCapabilities;
      if (lease && typeof lease.issueLease === 'function') {
        const refreshed = daemon.sessionManager.getSession(session.id)!;
        const issued = lease.issueLease(refreshed, refreshed.harnessId);

        const renderOkRes = await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/plugin-tools',
          headers: { authorization: `Bearer ${issued.token}` },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'hm_render_html',
              arguments: { title: 'Diag SVG', html: '<svg width="100" height="40"></svg>' },
            },
          },
        });
        expect(renderOkRes.statusCode).toBe(200);
        const renderItems = daemon.sessionManager.getSessionTurnItems(session.id, {
          blockTypes: ['html_render'],
        });
        expect(renderItems).toHaveLength(1);
        expect(renderItems[0]?.title).toBe('Diag SVG');

        // Once session has html_render activity, tools/list conditionally exposes hm_render_html as readOnly
        const listToolsRes = await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/plugin-tools',
          headers: { authorization: `Bearer ${issued.token}` },
          payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        });
        expect(listToolsRes.statusCode).toBe(200);
        const tools = (
          listToolsRes.json() as {
            result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
          }
        ).result.tools;
        const htmlTool = tools.find((t) => t.name === 'hm_render_html');
        expect(htmlTool?.annotations?.readOnlyHint).toBe(true);

        const renderBigRes = await daemon.app.inject({
          method: 'POST',
          url: '/api/v1/plugin-tools',
          headers: { authorization: `Bearer ${issued.token}` },
          payload: {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'hm_render_html',
              arguments: { title: 'Too Big', html: 'x'.repeat(520 * 1024) },
            },
          },
        });
        const bigJson = renderBigRes.json() as { result: { isError?: boolean } };
        expect(bigJson.result.isError).toBe(true);
      }
    } finally {
      await daemon.stop();
      safeRmSync(dataDir);
      safeRmSync(repoDir);
    }
  }, 20_000);
});
