import type {
  CanonicalEvent,
  HarnessInfo,
  ProviderOptionDescriptor,
  Session,
  TurnBlockRecord,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildSandboxedHtmlRenderSrcDoc,
  HTML_RENDER_MAX_BYTES,
  HtmlRenderCard,
} from '../src/components/HtmlRenderCard';
import {
  FailoverInlineBanner,
  GenericExtBlockCard,
  WorkGroupRow,
} from '../src/components/MessageStudio';
import { sanitizeTraitValues, TraitsPicker } from '../src/components/TraitsPicker';
import {
  resolveContextWindowMeter,
  resolveHarnessMeta,
  resolveHarnessOptionDescriptors,
} from '../src/lib/harness-meta';
import { mergeTurnBlockRecords, projectSessionEvents } from '../src/lib/projector';
import {
  buildTimelineMinimapItems,
  groupTurnBlocks,
  type ExtensionTurnBlock,
  type UnknownTurnBlock,
} from '../src/lib/work-groups';
import {
  Slot,
  SlotErrorBoundary,
  SlotRegistry,
  SlotRegistryProvider,
  SlotSessionProvider,
} from '../src/slots';

const sampleSession: Session = {
  id: 'sess_v5',
  workspaceId: 'ws_1',
  harnessId: 'deepseek-prod',
  harnessKind: 'deepseek',
  nativeSessionId: null,
  participatingHarnesses: ['deepseek-prod'],
  contextSyncMode: 'auto',
  cwd: '/repo',
  title: 'V5 Slots & Message Studio',
  status: 'idle',
  model: 'deepseek-r1',
  reasoningEffort: null,
  permissionMode: 'accept_edits',
  lastSeq: 10,
  usage: {
    inputTokens: 150_000,
    outputTokens: 25_000,
    cachedTokens: 110_000,
    contextTokens: 175_000,
    modelContextWindow: 200_000,
  },
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

const customHarness: HarnessInfo = {
  id: 'deepseek-prod',
  kind: 'deepseek',
  driverId: 'deepseek',
  instanceId: 'deepseek-prod',
  displayName: 'DeepSeek Reasoner',
  description: 'Third-party DeepSeek adapter plugin',
  protocolLabel: 'deepseek-sse',
  binaryPath: '/usr/local/bin/deepseek',
  version: '2.1.0',
  health: 'ready',
  capabilities: {
    streaming: true,
    interactiveApproval: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    permissionModes: ['plan', 'accept_edits', 'auto'],
    sessionResume: true,
    sessionFork: false,
    imageInput: false,
    subagents: false,
  },
  presentation: {
    shortLabel: 'DeepSeek',
    accentColor: '#38bdf8',
    softBg: 'rgba(56, 189, 248, 0.14)',
    tagline: 'DeepSeek R1 · Third-Party Plugin',
  },
  optionDescriptors: [
    {
      key: 'thinkingMode',
      label: '思考模式',
      kind: 'select',
      defaultValue: 'balanced',
      options: [
        { value: 'fast', label: '快速' },
        { value: 'balanced', label: '均衡' },
        { value: 'deep', label: '深度' },
      ],
    },
    {
      key: 'fastMode',
      label: '极速通道',
      kind: 'boolean',
      defaultValue: false,
    },
    {
      key: 'thinkingBudgetTokens',
      label: '思维预算',
      kind: 'number',
      min: 1024,
      max: 32768,
      step: 1024,
      defaultValue: 8192,
    },
  ],
  models: [
    { id: 'deepseek-r1', displayName: 'DeepSeek R1', isDefault: true },
  ],
  defaultModelId: 'deepseek-r1',
};

describe('V5 UI Slots Registration & Error Isolation', () => {
  it('supports all 5 V5 slots (chat.block, composer.traits, harness.settings, inspector.diff, session.sidebar.badge)', () => {
    const registry = new SlotRegistry();

    // 1. harness.settings (scope: root, cardinality: keyed) renders without active session
    registry.register({
      slot: 'harness.settings',
      id: 'deepseek-auth',
      pluginId: 'hm.adapter.deepseek',
      pluginName: 'DeepSeek Adapter',
      key: 'deepseek',
      render: ({ harness }) => <div>Settings:{harness.displayName}</div>,
    });

    const rootSettingsHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={null}>
          <Slot
            name="harness.settings"
            matchKey="deepseek"
            slotProps={{ harness: customHarness, onRefresh: () => {} }}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(rootSettingsHtml).toContain('Settings:DeepSeek Reasoner');

    // 2. chat.block (scope: session, cardinality: keyed)
    const extBlock: ExtensionTurnBlock = {
      blockId: 'ext_1',
      schemaVersion: 2,
      seq: 5,
      turnId: 't1',
      harnessInstanceId: 'deepseek-prod',
      driverId: 'deepseek',
      type: 'ext:deepseek.reasoning_budget',
      title: 'Reasoning Budget',
      fallbackSummary: 'Used 4096 / 8192 budget tokens',
      payload: { used: 4096, limit: 8192 },
      status: 'completed',
      createdAt: 1000,
      updatedAt: 1100,
    };

    registry.register({
      slot: 'chat.block',
      id: 'deepseek-budget-card',
      pluginId: 'hm.adapter.deepseek',
      pluginName: 'DeepSeek Adapter',
      key: 'ext:deepseek.reasoning_budget',
      render: ({ block }) => <div>BudgetCard:{block.blockId}</div>,
    });

    const chatBlockHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="chat.block"
            matchKey="ext:deepseek.reasoning_budget"
            slotProps={{ session: sampleSession, block: extBlock }}
            fallback={<div>FallbackCard</div>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(chatBlockHtml).toContain('BudgetCard:ext_1');

    // Without session, session-scoped chat.block falls back cleanly
    const noSessionBlockHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={null}>
          <Slot
            name="chat.block"
            matchKey="ext:deepseek.reasoning_budget"
            slotProps={{ session: sampleSession, block: extBlock }}
            fallback={<div>FallbackCard</div>}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(noSessionBlockHtml).toBe('<div>FallbackCard</div>');

    // 3. inspector.diff (cardinality: single -> lowest order wins)
    registry.register({
      slot: 'inspector.diff',
      id: 'checkpoints-diff',
      pluginId: 'hm.plugin.git-checkpoints',
      pluginName: 'Git Checkpoints',
      order: 10,
      render: ({ session }) => <div>CheckpointDiff:{session.id}</div>,
    });
    registry.register({
      slot: 'inspector.diff',
      id: 'secondary-diff',
      pluginId: 'user.other-diff',
      pluginName: 'Other Diff',
      order: 50,
      render: () => <div>SecondaryDiff</div>,
    });
    const diffHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="inspector.diff"
            slotProps={{ session: sampleSession, git: null, onRefresh: () => {} }}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(diffHtml).toContain('CheckpointDiff:sess_v5');
    expect(diffHtml).not.toContain('SecondaryDiff');

    // 4. session.sidebar.badge (scope: session-maybe, cardinality: list)
    registry.register({
      slot: 'session.sidebar.badge',
      id: 'triage-pin',
      pluginId: 'hm.plugin.triage',
      pluginName: 'Triage Inbox',
      order: 20,
      render: () => <span>PINNED</span>,
    });
    const badgeHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={null}>
          <Slot name="session.sidebar.badge" slotProps={{ session: sampleSession }} />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(badgeHtml).toContain('PINNED');

    // 5. composer.traits (scope: session, cardinality: list)
    registry.register({
      slot: 'composer.traits',
      id: 'dynamic-traits',
      pluginId: 'hm.plugin.message-studio',
      pluginName: 'Message Studio',
      render: ({ harness, values, onChange }) => (
        <TraitsPicker
          descriptors={resolveHarnessOptionDescriptors(harness)}
          values={values}
          onChange={onChange}
        />
      ),
    });
    const traitsHtml = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <SlotSessionProvider session={sampleSession}>
          <Slot
            name="composer.traits"
            slotProps={{
              session: sampleSession,
              harness: customHarness,
              disabled: false,
              values: { thinkingMode: 'deep', fastMode: true },
              onChange: () => {},
            }}
          />
        </SlotSessionProvider>
      </SlotRegistryProvider>,
    );
    expect(traitsHtml).toContain('思考模式');
    expect(traitsHtml).toContain('极速通道');
    expect(traitsHtml).toContain('思维预算');

    // 6. Error boundary isolation reports V5 slot key cleanly
    const boundary = new SlotErrorBoundary({
      registry,
      item: {
        pluginId: 'user.broken-ext',
        pluginName: 'Broken Ext',
        slot: 'chat.block',
        id: 'broken-block',
        title: 'Broken Block',
      },
      children: null,
    });
    boundary.componentDidCatch(new Error('Malformed ext block render'), { componentStack: '' });
    expect(
      registry
        .getRenderFailures()
        .some((f) => f.slot === 'chat.block' && f.message === 'Malformed ext block render'),
    ).toBe(true);
  });
});

describe('TurnBlock Projection, WorkGroup & Fallback Rendering', () => {
  it('preserves interleaved TurnBlock chronological order, groups consecutive work steps, and merges TurnBlockRecord items', () => {
    const events: CanonicalEvent[] = [
      {
        sessionId: 'sess_v5',
        seq: 1,
        type: 'message.user',
        turnId: 't1',
        createdAt: 1000,
        payload: { text: 'Inspect and run tests', harnessId: 'deepseek-prod', harnessKind: 'deepseek' },
      },
      {
        sessionId: 'sess_v5',
        seq: 2,
        type: 'thinking.completed',
        turnId: 't1',
        createdAt: 1050,
        payload: { text: 'First inspect package.json' },
      },
      {
        sessionId: 'sess_v5',
        seq: 3,
        type: 'tool.call.started',
        turnId: 't1',
        createdAt: 1100,
        payload: {
          toolCallId: 'tc_read',
          toolName: 'Read',
          toolKind: 'file_read',
          summary: 'Read package.json',
        },
      },
      {
        sessionId: 'sess_v5',
        seq: 4,
        type: 'tool.call.completed',
        turnId: 't1',
        createdAt: 1200,
        payload: { toolCallId: 'tc_read', toolName: 'Read', status: 'success', output: '{}' },
      },
      {
        sessionId: 'sess_v5',
        seq: 5,
        type: 'tool.call.started',
        turnId: 't1',
        createdAt: 1300,
        payload: {
          toolCallId: 'tc_cmd',
          toolName: 'Bash',
          toolKind: 'shell',
          summary: 'pnpm test',
        },
      },
      {
        sessionId: 'sess_v5',
        seq: 6,
        type: 'tool.call.completed',
        turnId: 't1',
        createdAt: 2500,
        payload: {
          toolCallId: 'tc_cmd',
          toolName: 'Bash',
          status: 'success',
          output: 'preview...',
          outputOmitted: true,
          omittedBytes: 128_000,
        },
      },
      {
        sessionId: 'sess_v5',
        seq: 7,
        type: 'message.assistant.completed',
        turnId: 't1',
        createdAt: 2600,
        payload: { text: 'All tests passed!' },
      },
      {
        sessionId: 'sess_v5',
        seq: 8,
        type: 'turn.completed',
        turnId: 't1',
        createdAt: 2700,
        payload: { stopReason: 'end_turn' },
      },
    ];

    const records: TurnBlockRecord[] = [
      {
        itemId: 'ext:future-1',
        schemaVersion: 2,
        sessionId: 'sess_v5',
        turnId: 't1',
        seq: 8,
        instanceId: 'deepseek-prod',
        driverId: 'deepseek',
        blockType: 'ext:future.telemetry',
        status: 'completed',
        title: 'Future Vendor Block',
        textBody: 'Custom vendor telemetry summary',
        payload: { score: 99 },
        outputOmitted: false,
        omittedBytes: 0,
        createdAt: 2650,
        updatedAt: 2650,
      },
    ];

    const projected = mergeTurnBlockRecords(
      projectSessionEvents(events, { id: 'deepseek-prod', kind: 'deepseek' }),
      records,
    );
    const turn = projected.turns[0]!;
    expect(turn.blocks.map((b) => b.type)).toEqual([
      'reasoning',
      'tool_call',
      'command_execution',
      'assistant_text',
      'ext:future.telemetry',
    ]);

    const segments = groupTurnBlocks(turn.blocks, false);
    expect(segments).toHaveLength(3);
    expect(segments[0]?.kind).toBe('work_group');
    if (segments[0]?.kind === 'work_group') {
      expect(segments[0].blocks).toHaveLength(3);
      expect(segments[0].collapsedByDefault).toBe(true);
      expect(segments[0].summaryText).toContain('已完成 3 个步骤');
      expect(segments[0].summaryText).toContain('运行 1 命令');
      const wgHtml = renderToStaticMarkup(
        <WorkGroupRow session={sampleSession} group={segments[0]} />,
      );
      expect(wgHtml).toContain('work-group-row');
      expect(wgHtml).toContain('已完成 3 个步骤');
    }
    expect(segments[1]?.kind).toBe('block');
    expect(segments[2]?.kind).toBe('block');

    // Unknown / ext block fallback card renders cleanly without crashing
    const unknownBlock: UnknownTurnBlock = {
      blockId: 'unk_1',
      schemaVersion: 2,
      seq: 9,
      turnId: 't1',
      harnessInstanceId: 'deepseek-prod',
      driverId: 'deepseek',
      type: 'unknown_block',
      originalType: 'future_v9_widget',
      title: 'Future V9 Widget',
      fallbackSummary: 'Graceful degradation summary',
      payload: { nested: { ok: true } },
      unknownBlock: true,
      status: 'completed',
      createdAt: 3000,
      updatedAt: 3000,
    };
    const fallbackHtml = renderToStaticMarkup(<GenericExtBlockCard block={unknownBlock} />);
    expect(fallbackHtml).toContain('generic-ext-fallback-card');
    expect(fallbackHtml).toContain('future_v9_widget');
    expect(fallbackHtml).toContain('Graceful degradation summary');
  });

  it('renders sandboxed HtmlRenderCard with strict CSP and rejects >512KB payloads', () => {
    const srcDoc = buildSandboxedHtmlRenderSrcDoc({
      html: '<div><h1>Chart</h1></div>',
      theme: 'dark',
      cssVars: { '--bg-surface': '#121623' },
      renderId: 'r_1',
    });
    expect(srcDoc).toContain('Content-Security-Policy');
    expect(srcDoc).toContain("connect-src &#39;none&#39;".replace(/&#39;/g, "'"));
    expect(srcDoc).toContain('window.alert = function () {}');
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('<h1>Chart'));
    const documentHtml = '<html lang="zh"><head><title>Chart</title></head><body class="report">Chart</body></html>';
    const fullDoc = buildSandboxedHtmlRenderSrcDoc({ html: documentHtml, theme: 'dark', cssVars: {}, renderId: 'r_full' });
    expect(fullDoc).toMatch(/^<!doctype html><html><head>/);
    expect(fullDoc.endsWith(documentHtml)).toBe(true);

    const cardHtml = renderToStaticMarkup(
      <HtmlRenderCard renderId="r_1" title="Architecture SVG" html="<svg></svg>" />,
    );
    expect(cardHtml).toContain('sandbox="allow-scripts"');
    expect(cardHtml).not.toContain('allow-same-origin');
    expect(cardHtml).not.toContain('allow-top-navigation');
    expect(cardHtml).toContain('Architecture SVG');

    const oversized = 'a'.repeat(HTML_RENDER_MAX_BYTES + 100);
    const oversizedHtml = renderToStaticMarkup(
      <HtmlRenderCard renderId="r_big" title="Oversized" html={oversized} />,
    );
    expect(oversizedHtml).not.toContain('<iframe');
    expect(oversizedHtml).toContain('超过安全上限');
  });
});

describe('Dynamic TraitsPicker, Zero-Hardcoding Meta, Context Meter & Failover UI', () => {
  it('sanitizes stale trait values and renders dynamic descriptors for custom drivers', () => {
    const descriptors: ProviderOptionDescriptor[] = [
      {
        key: 'variant',
        label: '模型档位',
        kind: 'select',
        defaultValue: 'standard',
        options: [
          { value: 'standard', label: '标准' },
          { value: 'pro', label: '专业' },
        ],
      },
      {
        key: 'fastMode',
        label: 'Fast Mode',
        kind: 'boolean',
        defaultValue: false,
      },
      {
        key: 'budget',
        label: '预算',
        kind: 'number',
        min: 100,
        max: 1000,
        defaultValue: 500,
      },
    ];

    // Stale select value 'legacy_turbo' must auto-reset to defaultValue 'standard', number clamped to max
    const sanitized = sanitizeTraitValues(descriptors, {
      variant: 'legacy_turbo',
      fastMode: true,
      budget: 9999,
      removedKey: 'ignored',
    });
    expect(sanitized).toEqual({
      variant: 'standard',
      fastMode: true,
      budget: 1000,
    });

    const html = renderToStaticMarkup(
      <TraitsPicker descriptors={descriptors} values={sanitized} onChange={() => {}} />,
    );
    expect(html).toContain('traits-picker');
    expect(html).toContain('模型档位');
    expect(html).toContain('Fast Mode');
    expect(html).toContain('预算');
  });

  it('resolves backend HarnessPresentationMeta, context window meter, minimap, and failover banner without vendor hardcoding', () => {
    const meta = resolveHarnessMeta({ harnessId: 'deepseek-prod', harnessKind: 'deepseek' }, [customHarness]);
    expect(meta.shortLabel).toBe('DeepSeek');
    expect(meta.accentColor).toBe('#38bdf8');

    const fallbackMeta = resolveHarnessMeta({ harnessKind: 'opencode' }, []);
    expect(fallbackMeta.accentColor).toBe('var(--accent-star)');

    const meter = resolveContextWindowMeter(sampleSession.usage);
    expect(meter).not.toBeNull();
    expect(meter?.usagePercent).toBe(88);
    expect(meter?.level).toBe('critical');
    expect(meter?.cacheHitRate).toBe(73);
    expect(meter?.isEstimated).toBe(false);

    const minimap = buildTimelineMinimapItems(
      [
        {
          kind: 'turn',
          turnId: 't1',
          harnessId: 'deepseek-prod',
          harnessKind: 'deepseek',
          userText: 'Build feature',
          status: 'completed',
          tools: [{ toolKind: 'file_edit' }],
        },
        {
          kind: 'switch',
          seq: 5,
          fromHarnessId: 'deepseek-prod',
          toHarnessId: 'opencode-1',
          toHarnessKind: 'opencode',
        },
      ],
      { id: 'deepseek-prod', kind: 'deepseek' },
    );
    expect(minimap).toHaveLength(2);
    expect(minimap[0]?.hasFileChanges).toBe(true);
    expect(minimap[1]?.kind).toBe('switch');

    const backupHarness: HarnessInfo = {
      ...customHarness,
      id: 'opencode-backup',
      kind: 'opencode',
      driverId: 'opencode',
      instanceId: 'opencode-backup',
      displayName: 'OpenCode Backup',
    };
    const bannerHtml = renderToStaticMarkup(
      <FailoverInlineBanner
        failedInstanceId="deepseek-prod"
        failureClass="usage_limit"
        errorMessage="Rate limit reached (429)"
        resetsAt={Date.now() + 30 * 60_000}
        harnesses={[customHarness, backupHarness]}
        accountUsage={[]}
        failoverPolicy={{
          mode: 'manual_one_click',
          priorityChain: ['opencode-backup'],
          maxAutoSwitchesPerSession: 2,
          autoRetryInterruptedPrompt: true,
          notifyOnQuotaReset: true,
        }}
        onFailover={() => {}}
      />,
    );
    expect(bannerHtml).toContain('failover-inline-banner');
    expect(bannerHtml).toContain('OpenCode Backup');
    expect(bannerHtml).toContain('Handoff v2');
  });
});
