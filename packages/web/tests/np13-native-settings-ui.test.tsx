import type { HarnessInfo } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgySettingsSlot } from '../src/components/agy/AgySettingsSlot';
import {
  AgyNativeSettingsWorkspace,
  SETTINGS_SECTIONS,
  buildAgySettingsViewModel,
  createAuthorizedSettingsSnapshotFixture,
  createEnterprisePolicySettingsSnapshotFixture,
  createGateClosedSettingsSnapshotFixture,
} from '../src/components/agy/native/settings';
import { computeNextTabIndex } from '../src/components/agy/native/shared';
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
    binaryPath: 'agy.exe',
    version: '1.5.16',
    health: 'ready',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['manual', 'accept_edits', 'plan'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: true,
    },
    models: [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportsReasoningEffort: true }],
    defaultModelId: 'gemini-3.8-flash',
    isCustom: id !== 'agy',
  };
}

const initialStoreSnapshot = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialStoreSnapshot, true);
});

describe('NP-13 Native Ecosystem & Settings UI', () => {
  it('renders all 5 Settings sections with namespaces, availability, provenance, and boundary cards', () => {
    const snap = createAuthorizedSettingsSnapshotFixture();

    const accountHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={snap} initialSection="account" />,
    );
    expect(accountHtml).toContain('手动账户生态与认证隔离');
    expect(accountHtml).toContain('禁止自动换号');
    expect(accountHtml).toContain('不添单活切换（U07）');
    expect(accountHtml).toContain('读写范围公布');

    const modelsHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={snap} initialSection="models" />,
    );
    expect(modelsHtml).toContain('AccountDefaults &lt; Session &lt; Turn');
    expect(modelsHtml).toContain('Gemini 3.8 Flash');
    expect(modelsHtml).toContain('effort_not_in_observed_options');
    expect(modelsHtml).toContain('permission_client_guard_degraded');

    const agentsHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={snap} initialSection="agents" onRequestOptInQuery={() => {}} />,
    );
    expect(agentsHtml).toContain('reviewer');
    expect(agentsHtml).toContain('AGY 原生');
    expect(agentsHtml).toContain('切换主 Custom Agent 可能需要新建会话或原生 Fork');
    expect(agentsHtml).toContain('Opt-in 查询 agy agents');

    const ecosystemHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={snap} initialSection="ecosystem" />,
    );
    expect(ecosystemHtml).toContain('deploy-check');
    expect(ecosystemHtml).toContain('被 workspace_agents 覆盖');
    expect(ecosystemHtml).toContain('严禁注入 System Prompt');
    expect(ecosystemHtml).toContain('#1540');
    expect(ecosystemHtml).toContain('PreToolUse');
    expect(ecosystemHtml).toContain('管理员政策禁用');
    expect(ecosystemHtml).toContain('凭据已脱敏');
    expect(ecosystemHtml).toContain('HarnessMate');
    expect(ecosystemHtml).toContain('Credits、账单与付费计划');
    expect(ecosystemHtml).toContain('AGY Remote Control');
    expect(ecosystemHtml).toContain('App Sidecars 与 agentapi');

    const projectsHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={snap} initialSection="projects" />,
    );
    expect(projectsHtml).toContain('工作区根与附加目录');
    expect(projectsHtml).toContain('符号链接越界已拦截');
  });

  it('degrades honestly when gates are closed, snapshot is null, or enterprise #1610 applies', () => {
    const nullHtml = renderToStaticMarkup(<AgyNativeSettingsWorkspace snapshot={null} />);
    expect(nullHtml).toContain('AGY 原生生态与配置发现未加载');

    const closedHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={createGateClosedSettingsSnapshotFixture()} />,
    );
    expect(closedHtml).toContain('扩展生态本地扫描门控默认关闭（U04）');

    const enterpriseHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace
        snapshot={createEnterprisePolicySettingsSnapshotFixture()}
        initialSection="account"
      />,
    );
    expect(enterpriseHtml).toContain('issue #1610');
    expect(enterpriseHtml).toContain('oauth-business');
  });

  it('preserves AgySettingsSlot feature-off compatibility and mounts workspace when provided', () => {
    const harness = makeAgyHarness('agy', 'Antigravity 官方默认');
    const entries = [
      {
        profile: {
          instanceId: 'agy',
          displayName: 'Antigravity 官方默认',
          isolationMode: 'official_default' as const,
          authMethod: 'oauth-personal' as const,
          appDataDirName: 'antigravity-cli',
          defaults: {
            linkGlobalSkills: true,
            syncGlobalRules: true,
            additionalDirectories: [],
          },
          enabled: true,
        },
        authState: {
          instanceId: 'agy',
          isolationMode: 'official_default' as const,
          authMethod: 'oauth-personal' as const,
          phase: 'authenticated' as const,
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
          identity: { emailLabel: 'tester', tierName: 'Pro' },
        },
      },
    ];

    useAppStore.setState({ agyNativeWorkbenchEnabled: false });
    const offHtml = renderToStaticMarkup(
      <AgySettingsSlot harness={harness} onRefresh={() => {}} initialEntries={entries} />,
    );
    expect(offHtml).not.toContain('agy-native-settings-workspace');
    expect(offHtml).not.toContain('toggle-agy-native-ecosystem');

    useAppStore.setState({ agyNativeWorkbenchEnabled: true });
    const workbenchToggleHtml = renderToStaticMarkup(
      <AgySettingsSlot harness={harness} onRefresh={() => {}} initialEntries={entries} />,
    );
    expect(workbenchToggleHtml).toContain('toggle-agy-native-ecosystem');

    const mountedHtml = renderToStaticMarkup(
      <AgySettingsSlot
        harness={harness}
        onRefresh={() => {}}
        initialEntries={entries}
        ecosystemSnapshot={createAuthorizedSettingsSnapshotFixture()}
        initialSection="ecosystem"
      />,
    );
    expect(mountedHtml).toContain('agy-native-settings-workspace');
    expect(mountedHtml).toContain('AGY 原生生态与 HarnessMate 边界'.slice(0, 6));
  });

  it('filters view-model by namespace/search and cycles tabs with keyboard navigation', () => {
    const snap = createAuthorizedSettingsSnapshotFixture();
    const hmOnly = buildAgySettingsViewModel(snap, { namespaceFilter: 'harnessmate' });
    expect(hmOnly.skills).toHaveLength(0);
    expect(hmOnly.mcpServers.map((m) => m.name)).toEqual(['hm-session-tools']);
    expect(hmOnly.shadowedSkillsCount).toBe(1);
    expect(hmOnly.policyRestrictionCount).toBe(3);

    const searchRes = buildAgySettingsViewModel(snap, { searchQuery: 'github-global' });
    expect(searchRes.mcpServers.map((m) => m.name)).toEqual(['github-global']);

    expect(computeNextTabIndex('ArrowRight', 0, SETTINGS_SECTIONS.length)).toBe(1);
    expect(computeNextTabIndex('ArrowLeft', 0, SETTINGS_SECTIONS.length)).toBe(4);
    expect(computeNextTabIndex('End', 1, SETTINGS_SECTIONS.length)).toBe(4);
    expect(computeNextTabIndex('Home', 3, SETTINGS_SECTIONS.length)).toBe(0);
  });
});
