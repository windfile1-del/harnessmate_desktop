import type {
  HarnessInfo,
  Session,
  SessionCompressionStatus,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextCompressionPanelView } from '../src/components/ContextCompressionPanel';
import { SlotRegistry, SlotRegistryProvider } from '../src/slots';

const sampleHarnesses: HarnessInfo[] = [
  {
    id: 'codex-main',
    kind: 'codex',
    driverId: 'codex',
    instanceId: 'codex-main',
    displayName: 'Codex CLI',
    description: 'Codex',
    protocolLabel: 'jsonrpc',
    binaryPath: '/usr/bin/codex',
    version: '1.0.0',
    health: 'ready',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['medium', 'high'],
      permissionModes: ['manual', 'accept_edits'],
      sessionResume: true,
      sessionFork: true,
      imageInput: true,
      subagents: true,
    },
    models: [],
  },
];

const sampleSession: Session = {
  id: 'sess_cmp_1',
  workspaceId: 'ws_1',
  harnessId: 'codex-main',
  harnessKind: 'codex',
  nativeSessionId: null,
  participatingHarnesses: ['codex-main'],
  contextSyncMode: 'auto',
  cwd: '/repo/project',
  title: 'Long Session Compression',
  status: 'idle',
  model: 'gpt-5',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 60,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_050_000,
};

const sampleStatus: SessionCompressionStatus = {
  enabled: true,
  sessionId: sampleSession.id,
  workspaceId: 'ws_1',
  config: {
    summarizerInstanceId: null,
    summarizerModel: null,
    dailyCallLimit: 50,
    sessionTokenBudgetCap: 120_000,
    timeoutMs: 8_000,
    chunkSizeTurns: 10,
    rollupTurnThreshold: 25,
    backgroundRollupEnabled: true,
    symbolOutlineMaxChars: 4_000,
  },
  chunks: [
    {
      chunkId: 'chk_1_10',
      sessionId: sampleSession.id,
      fromSeq: 1,
      toSeq: 30,
      fromTurn: 1,
      toTurn: 10,
      sourceItemsHash: 'abc123def456',
      summaryMarkdown: 'Refactored `src/engine.ts` and referenced `src/ghost.ts` [已删除/已重命名].',
      originalChars: 18_000,
      compressedChars: 1_400,
      compressionRatio: 12.86,
      usedLlm: false,
      summarizerInstanceId: null,
      fallback: false,
      fallbackReason: null,
      cacheHit: true,
      referencedPaths: [
        { path: 'src/engine.ts', existsAtCheck: true },
        { path: 'src/ghost.ts', existsAtCheck: false },
      ],
      createdAt: 1_700_000_010_000,
    },
  ],
  symbolOutlines: [
    {
      path: 'src/engine.ts',
      language: 'typescript',
      mtimeMs: 1_700_000_000_000,
      sizeBytes: 2_048,
      symbols: [
        { kind: 'class', name: 'EngineCore', line: 12, exported: true },
        { kind: 'function', name: 'compileWindow', line: 45, exported: true },
      ],
    },
  ],
  symbolOutlineMarkdown: '### Hot File Symbol Outlines\n- `src/engine.ts`',
  totalOriginalChars: 18_000,
  totalCompressedChars: 1_400,
  compressionRatio: 12.86,
  cacheStats: {
    chunkCount: 1,
    symbolFileCount: 1,
    workspaceBytesUsed: 12_288,
    workspaceBytesCap: 20 * 1024 * 1024,
    dailyLlmCallsUsed: 0,
    dailyLlmCallsLimit: 50,
    sessionTokensUsed: 0,
    sessionTokenBudgetCap: 120_000,
  },
};

describe('Phase 4.1 Frontend: ContextCompressionPanel & inspector.tabs slot', () => {
  it('renders compression chunks, ratios, hallucination path warning, symbol outlines, and zero-cost mode badge', () => {
    const html = renderToStaticMarkup(
      <ContextCompressionPanelView
        session={sampleSession}
        status={sampleStatus}
        harnesses={sampleHarnesses}
        onRefresh={() => {}}
        onCompressNow={() => {}}
        onClearCache={() => {}}
        onSaveConfig={() => {}}
      />,
    );

    expect(html).toContain('data-testid="context-compression-panel"');
    expect(html).toContain('纯本地零费用符号轮廓模式');
    expect(html).toContain('Turns 1–10: 18.0k → 1.4k chars (12.86x)');
    expect(html).toContain('缓存命中');
    expect(html).toContain('src/engine.ts');
    expect(html).toContain('src/ghost.ts [已删除/已重命名]');
    expect(html).toContain('发现 1 个未验证路径');
    expect(html).toContain('L12 export class EngineCore');
    expect(html).toContain('L45 export function compileWindow');
    expect(html).toContain('手动压缩历史');
    expect(html).toContain('清空缓存');

    // Clear cache button should be enabled when chunks > 0
    const clearBtnMatch = html.match(/<button[^>]*data-testid="clear-compression-cache-btn"[^>]*>/);
    expect(clearBtnMatch).not.toBeNull();
    expect(clearBtnMatch![0]).not.toMatch(/\sdisabled(?:=""|[\s>])/);
  });

  it('disables clear cache button when no chunks are cached', () => {
    const emptyStatus: SessionCompressionStatus = {
      ...sampleStatus,
      chunks: [],
      symbolOutlines: [],
      totalOriginalChars: 0,
      totalCompressedChars: 0,
      compressionRatio: 1,
    };

    const html = renderToStaticMarkup(
      <ContextCompressionPanelView
        session={sampleSession}
        status={emptyStatus}
        harnesses={sampleHarnesses}
        onRefresh={() => {}}
        onCompressNow={() => {}}
        onClearCache={() => {}}
        onSaveConfig={() => {}}
      />,
    );

    expect(html).toContain('尚未生成压缩分块');
    const clearBtnMatch = html.match(/<button[^>]*data-testid="clear-compression-cache-btn"[^>]*>/);
    expect(clearBtnMatch).not.toBeNull();
    expect(clearBtnMatch![0]).toMatch(/\sdisabled(?:=""|[\s>])/);
  });

  it('mounts ContextCompressionPanel into inspector.tabs slot when registered', () => {
    const registry = new SlotRegistry();
    const dispose = registry.register({
      slot: 'inspector.tabs',
      id: 'context-compression',
      pluginId: 'hm.plugin.context-compression',
      pluginName: 'Context Compression',
      title: '上下文压缩与符号索引',
      key: 'context-compression',
      order: 95,
      sourceKind: 'builtin',
      render: () => (
        <ContextCompressionPanelView
          session={sampleSession}
          status={sampleStatus}
          harnesses={sampleHarnesses}
          onRefresh={() => {}}
          onCompressNow={() => {}}
          onClearCache={() => {}}
          onSaveConfig={() => {}}
        />
      ),
    });

    const items = registry.getItems('inspector.tabs', { hasSession: true, matchKey: 'context-compression' });
    expect(items).toHaveLength(1);

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        {items[0]!.render({ session: sampleSession })}
      </SlotRegistryProvider>,
    );
    expect(html).toContain('data-testid="context-compression-panel"');

    dispose();
    expect(registry.getItems('inspector.tabs', { hasSession: true })).toHaveLength(0);
  });
});
