import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGY_WORKBENCH_CONTRACT } from '../src/api/peer-contracts';
import { useAppStore as useHostStore } from '../src/stores/app-store';
import { useAppStore as useWorkbenchPluginStore } from '../src/plugins/agy-workbench-default/store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('B4-W1 AGY Workbench Plugin Ownership & Decoupling', () => {
  it('bundles hm.plugin.agy-workbench-default with agy.workbench.v1 and session.stage.embedded manifest + built UI', () => {
    const manifestPath = path.join(
      REPO_ROOT,
      'plugins',
      'bundled',
      'hm.plugin.agy-workbench-default',
      'harnessmate-plugin.json',
    );
    const uiIndexPath = path.join(
      REPO_ROOT,
      'plugins',
      'bundled',
      'hm.plugin.agy-workbench-default',
      'ui',
      'index.html',
    );
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(uiIndexPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      id: string;
      provides?: string[];
      contributes?: { slots?: Array<{ slot: string; id: string }> };
    };
    const slots = manifest.contributes?.slots ?? [];
    expect(manifest.id).toBe('hm.plugin.agy-workbench-default');
    expect(manifest.provides).toContain(AGY_WORKBENCH_CONTRACT);
    expect(slots.some((s) => s.slot === 'session.stage.embedded')).toBe(true);
    expect(slots.some((s) => s.slot === 'composer.actions')).toBe(true);
    expect(slots.filter((s) => s.slot === 'inspector.tabs').length).toBeGreaterThanOrEqual(3);
    expect(slots.some((s) => s.slot === 'harness.settings')).toBe(true);
    expect(slots.some((s) => s.slot === 'session.sidebar.badge')).toBe(true);
  });

  it('removes host AGY business view registrations from App.tsx, PluginSlotSync.tsx, and ChatStage.tsx', () => {
    const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'web', 'src', 'App.tsx'), 'utf8');
    const slotSyncSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'web', 'src', 'slots', 'PluginSlotSync.tsx'),
      'utf8',
    );
    const chatStageSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'web', 'src', 'plugins', 'chat-default', 'ChatStage.tsx'),
      'utf8',
    );

    expect(appSrc).not.toContain('registerAgy');
    expect(appSrc).not.toContain('AgyWorkbenchShell');
    expect(slotSyncSrc).not.toContain('AgyNativeWorkbenchPage');
    expect(slotSyncSrc).not.toContain('core.harness.agy');
    expect(slotSyncSrc).toContain('session.stage.embedded');
    expect(chatStageSrc).not.toContain('AgyWorkbenchShell');
    expect(chatStageSrc).toContain('AGY_WORKBENCH_CONTRACT');
  });

  it('keeps workbench plugin store isolated from host store and consumes native projection replay cleanly', () => {
    expect(useWorkbenchPluginStore).not.toBe(useHostStore);

    const sessionId = 'sess_wb_replay_1';
    useWorkbenchPluginStore.getState().ingestNativeProjectionFixture(
      sessionId,
      {
        schemaVersion: 1,
        binding: {
          runtimeId: 'rt_wb_1' as never,
          sessionId,
          instanceId: 'agy',
          generation: 'gen_wb_1' as never,
        },
        asOfSeq: 2,
        capabilitiesRevision: 1,
        status: 'connected',
        leaseReasons: [],
        activities: [
          {
            id: 'act_1' as never,
            turnId: 'turn_1',
            origin: 'user_turn',
            state: 'running',
            summary: 'Replay Swarm & Subagent',
            updatedAt: Date.now(),
          },
        ],
        work: [],
        agents: [],
        relations: [],
        workflows: [
          {
            id: 'wf_swarm_1' as never,
            originActivityId: 'act_1' as never,
            state: {
              kind: 'known',
              value: 'running',
              evidence: { sourceKind: 'replay', freshness: 'fresh', observedAt: Date.now() },
            },
            detail: {
              kind: 'swarm',
              workerIds: [],
              board: {
                kind: 'known',
                value: 'available',
                evidence: { sourceKind: 'replay', freshness: 'fresh', observedAt: Date.now() },
              },
              objective: 'Frontend Consumer Replay',
            },
            revision: 1,
          },
        ],
        requestIds: [],
        receipts: {},
      },
      [],
    );

    const pluginSlice = useWorkbenchPluginStore.getState().nativeRuntimeBySession[sessionId];
    expect(pluginSlice?.projection?.workflows[0]?.detail.kind).toBe('swarm');
    expect(pluginSlice?.syncState.phase).toBe('live');
    // Host store remains untouched
    expect(useHostStore.getState().nativeRuntimeBySession[sessionId]).toBeUndefined();
    useWorkbenchPluginStore.getState().clearNativeSessionState(sessionId);
  });
});
