import type { HarnessInfo, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgyArtifactReviewPanel,
  AgyEcosystemPanel,
} from '../src/components/agy/AgyArtifactReviewPanel';
import { AgyComposerControls } from '../src/components/agy/AgyComposerControls';
import { AgySettingsSlot } from '../src/components/agy/AgySettingsSlot';
import { AgyStudioBlockCard } from '../src/components/agy/AgyStudioBlocks';
import { UsageDashboardModal } from '../src/components/HarnessIntegrationViews';
import { useAppStore } from '../src/stores/app-store';

vi.mock('../src/stores/app-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/stores/app-store')>();
  const bound = original.useAppStore;
  return {
    ...original,
    useAppStore: Object.assign(
      (selector?: (state: ReturnType<typeof bound.getState>) => unknown) =>
        selector ? selector(bound.getState()) : bound.getState(),
      bound,
    ),
  };
});

const baseAgySession: Session = {
  id: 'sess_agy_ui_1',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy', 'agy.work'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'AGY Native Studio Test',
  status: 'idle',
  model: 'gemini-pro-orchestrator',
  actualModel: 'gemini-pro-orchestrator',
  reasoningEffort: 'high',
  permissionMode: 'manual',
  permissionEnforcement: 'client_guard',
  lastSeq: 3,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

function makeAgyHarness(id: string, displayName: string): HarnessInfo {
  return {
    id,
    kind: 'agy',
    driverId: 'agy',
    instanceId: id,
    continuationKey: `agy:${id}`,
    displayName,
    description: 'Antigravity profile',
    protocolLabel: 'ACP',
    binaryPath: 'C:/Users/windfile/AppData/Local/agy/bin/agy.exe',
    version: '1.5.14',
    health: 'ready',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['manual', 'auto_edit', 'full_auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: true,
    },
    capabilitiesV2: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['manual', 'auto_edit', 'full_auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: true,
      transport: 'acp_stdio',
      historyInjectionMode: 'native_items',
      supportsNativeRollback: false,
      supportsNativeFork: false,
      supportsActiveSteering: true,
      supportsUsageLimits: true,
      supportsDynamicOptions: true,
      nativeCommands: ['/plan', '/goal'],
      optionDescriptors: [],
    },
    models: [
      { id: 'gemini-pro-orchestrator', displayName: 'Gemini Pro Orchestrator', supportsReasoningEffort: true },
    ],
    defaultModelId: 'gemini-pro-orchestrator',
    isCustom: id !== 'agy',
  };
}

const initialStoreSnapshot = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialStoreSnapshot, true);
});

describe('Phase AGY-5 UI Components', () => {
  it('renders AgySettingsSlot distinction between official_default shared keyring and profile_isolated account', () => {
    const defaultHarness = makeAgyHarness('agy', 'Antigravity 官方默认');
    const workHarness = makeAgyHarness('agy.work', 'AGY Work');

    const defaultHtml = renderToStaticMarkup(
      <AgySettingsSlot
        harness={defaultHarness}
        onRefresh={() => {}}
        initialEntries={[
          {
            profile: {
              instanceId: 'agy',
              displayName: 'Antigravity 官方默认',
              isolationMode: 'official_default',
              authMethod: 'oauth-personal',
              appDataDirName: 'antigravity-cli',
              defaults: {},
              enabled: true,
            },
            authState: {
              instanceId: 'agy',
              isolationMode: 'official_default',
              authMethod: 'oauth-personal',
              phase: 'authenticated',
              identity: { email: 'default@example.com', tierName: 'Pro', summary: 'default@example.com' },
            },
          },
        ]}
      />,
    );

    expect(defaultHtml).toContain('官方默认 · 共享系统凭据');
    expect(defaultHtml).toContain('确认登出本机共享凭据（将影响本地 Antigravity IDE/CLI）');
    expect(defaultHtml).toContain('官方 Google 登录');

    const isolatedHtml = renderToStaticMarkup(
      <AgySettingsSlot
        harness={workHarness}
        onRefresh={() => {}}
        initialEntries={[
          {
            profile: {
              instanceId: 'agy.work',
              displayName: 'AGY Work',
              isolationMode: 'profile_isolated',
              authMethod: 'oauth-personal',
              geminiDir: 'C:/profiles/agy.work/.gemini',
              appDataDirName: 'antigravity-cli-work',
              defaults: {},
              enabled: true,
            },
            authState: {
              instanceId: 'agy.work',
              isolationMode: 'profile_isolated',
              authMethod: 'oauth-personal',
              phase: 'waiting_code',
              authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
            },
          },
        ]}
      />,
    );

    expect(isolatedHtml).toContain('独立 Profile · 文件隔离');
    expect(isolatedHtml).toContain('等待授权码');
    expect(isolatedHtml).toContain('https://accounts.google.com/o/oauth2/v2/auth?state=xyz');
    expect(isolatedHtml).toContain('删除 AGY Work');
  });

  it('renders AgyComposerControls with Orchestrator badge, client_guard, Steering ready, and manual-only 1-click switcher', () => {
    useAppStore.setState({
      harnesses: [
        makeAgyHarness('agy', 'AGY Default'),
        makeAgyHarness('agy.work', 'AGY Work'),
      ],
    });

    const idleHtml = renderToStaticMarkup(
      <AgyComposerControls session={baseAgySession} isRunning={false} />,
    );
    expect(idleHtml).toContain('Orchestrator');
    expect(idleHtml).toContain('client_guard');
    expect(idleHtml).toContain('切至 AGY Work');
    expect(idleHtml).not.toContain('配置已锁定');

    const runningHtml = renderToStaticMarkup(
      <AgyComposerControls session={{ ...baseAgySession, status: 'running' }} isRunning />,
    );
    expect(runningHtml).toContain('Steering 就绪');
    expect(runningHtml).toContain('配置已锁定');
    expect(runningHtml).toContain('disabled=""');
  });

  it('renders all 5 AGY Studio extension block variants cleanly', () => {
    const blocks = [
      {
        id: 'blk_plan',
        type: 'ext:agy.plan' as const,
        pluginId: 'core.harness.agy',
        title: 'AGY 计划步骤',
        fallbackSummary: '2 steps',
        payload: {
          steps: [
            { title: 'Inspect fixtures', status: 'completed' },
            { title: 'Run replay test', status: 'in_progress' },
          ],
        },
      },
      {
        id: 'blk_sub',
        type: 'ext:agy.subagent_batch' as const,
        pluginId: 'core.harness.agy',
        title: 'AGY 子 Agent 委派',
        fallbackSummary: 'Researcher running',
        payload: { toolCallId: 'sub_1' },
      },
      {
        id: 'blk_bg',
        type: 'ext:agy.background_task' as const,
        pluginId: 'core.harness.agy',
        title: 'AGY 后台任务',
        fallbackSummary: 'pnpm test · running',
        payload: { taskId: 'bg_1' },
      },
      {
        id: 'blk_art',
        type: 'ext:agy.artifact_card' as const,
        pluginId: 'core.harness.agy',
        title: 'Artifact 已更新',
        fallbackSummary: 'implementation_plan.md',
        payload: { artifactName: 'implementation_plan.md' },
      },
      {
        id: 'blk_goal',
        type: 'ext:agy.goal_status' as const,
        pluginId: 'core.harness.agy',
        title: 'AGY Goal 推进',
        fallbackSummary: 'Phase 5 verification active',
        payload: { phase: 'active' },
      },
    ];

    for (const block of blocks) {
      const html = renderToStaticMarkup(
        <AgyStudioBlockCard session={baseAgySession} block={block} />,
      );
      expect(html).toContain(block.title);
    }

    const subagentHtml = renderToStaticMarkup(
      <AgyStudioBlockCard session={baseAgySession} block={blocks[1]!} />,
    );
    expect(subagentHtml).toContain('查看只读轨迹');
  });

  it('renders AgyArtifactReviewPanel with numbered lines and AgyEcosystemPanel with 6-domain isolation boundaries', () => {
    const reviewHtml = renderToStaticMarkup(
      <AgyArtifactReviewPanel
        session={baseAgySession}
        initialArtifacts={[
          { name: 'implementation_plan.md', kind: 'markdown', sizeBytes: 42, updatedAt: 1000 },
        ]}
        initialContent={{
          name: 'implementation_plan.md',
          kind: 'markdown',
          sizeBytes: 42,
          updatedAt: 1000,
          content: '# Plan\n- Step 1\n- Step 2',
          truncated: false,
        }}
      />,
    );
    expect(reviewHtml).toContain('implementation_plan.md');
    expect(reviewHtml).toContain('# Plan');
    expect(reviewHtml).toContain('批准 (Approve)');
    expect(reviewHtml).toContain('要求修改');

    const ecoHtml = renderToStaticMarkup(
      <AgyEcosystemPanel
        session={baseAgySession}
        initialSnapshot={{
          instanceId: 'agy.work',
          isolationMode: 'profile_isolated',
          geminiDir: 'C:/profiles/agy.work/.gemini',
          projects: { workspaceRoot: 'D:/repo', additionalDirectories: ['D:/shared'] },
          rules: { profileFiles: ['GEMINI.md'], workspaceRulesDirPresent: true },
          skills: { profileSkillsLinked: true, workspaceSkillsCount: 2 },
          mcp: {
            nativeGlobalConfigPresent: true,
            nativeGlobalConfigPath: 'C:/profiles/agy.work/.gemini/antigravity/mcp_config.json',
            nativeScope: 'global_shared',
            harnessMateSessionMcpScope: 'session_isolated',
            note: '原生 mcp_config.json 为账号全局共享；HarnessMate MCP 为会话隔离',
          },
          hooks: {
            agyInternalHooksPresent: true,
            agyInternalHooksScope: 'agy_internal',
            harnessMateV5HooksCount: 1,
          },
          plugins: {
            agyPluginCliNote: '由 agy plugin install/list 管理，与 HarnessMate 插件目录相互独立',
            harnessMateActivePluginsCount: 3,
          },
        }}
      />,
    );
    expect(ecoHtml).toContain('Projects (目录边界)');
    expect(ecoHtml).toContain('MCP (作用域边界)');
    expect(ecoHtml).toContain('AGY 原生: global_shared (跨 Profile 共享) · HarnessMate: session_isolated');
    expect(ecoHtml).toContain('Hooks (严禁混用)');
    expect(ecoHtml).toContain('Plugins (双轨独立)');
  });

  it('renders manual-only AGY multi-account guard notice and switch button inside UsageDashboardModal', () => {
    useAppStore.setState({
      harnesses: [makeAgyHarness('agy', 'AGY Default'), makeAgyHarness('agy.work', 'AGY Work')],
      selectedSessionId: baseAgySession.id,
      accountUsage: [
        {
          harnessId: 'agy',
          harnessKind: 'agy',
          driverId: 'agy',
          instanceId: 'agy',
          displayName: 'AGY Default',
          billingTier: 'subscription',
          loggedIn: true,
          accountLabel: 'default@example.com',
          planType: 'Pro',
          authMethod: 'oauth-personal',
          rateLimits: [{ label: 'Daily Quota', usedPercent: 42 }],
          dailyBuckets: [],
          localSessionCount: 1,
          localInputTokens: 1200,
          localOutputTokens: 300,
          localCachedTokens: 400,
          localCostUsd: 0,
          fetchedAt: 1000,
          error: null,
        },
      ],
      failoverPolicy: {
        mode: 'manual_one_click',
        priorityChain: ['agy', 'agy.work'],
        maxAutoSwitchesPerSession: 2,
        autoRetryInterruptedPrompt: true,
        notifyOnQuotaReset: true,
      },
    });

    const modalHtml = renderToStaticMarkup(<UsageDashboardModal onClose={() => {}} scope={{}} />);
    expect(modalHtml).toContain('多 AGY Google 账号禁止自动额度轮换，仅支持手动一键切换。');
    expect(modalHtml).toContain('手动切换至该账号');
  });
});
