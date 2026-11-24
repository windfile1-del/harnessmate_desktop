import type {
  ApprovalRequest,
  DiscoveredCliSession,
  HarnessInfo,
  Session,
  SessionSearchHit,
  SideChatMessage,
  Workspace,
} from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ComposerPendingRequestBar,
  GlobalAttentionStrip,
  RuntimeRequestReceiptBlock,
  SecretRequestInputCard,
  UserQuestionCard,
} from '../src/components/ApprovalCenter';
import {
  SafeHighlightedSnippet,
  SessionExplorerView,
} from '../src/components/SessionExplorerModal';
import { SideChatView } from '../src/components/SideChatDrawer';
import { SlotRegistry, SlotRegistryProvider } from '../src/slots';

const sampleWorkspace: Workspace = {
  id: 'ws_1',
  name: 'HarnessMate',
  rootPath: '/repo/harnessmate',
  isGitRepo: true,
  gitBranch: 'main',
  createdAt: Date.now(),
};

const sampleHarness: HarnessInfo = {
  id: 'codex',
  kind: 'codex',
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
};

const sampleSession: Session = {
  id: 'sess_1',
  workspaceId: 'ws_1',
  harnessId: 'codex',
  harnessKind: 'codex',
  nativeSessionId: 'nat_1',
  parentSessionId: 'sess_parent',
  forkedFromTurnSeq: 3,
  forkMode: 'portable',
  participatingHarnesses: ['codex'],
  contextSyncMode: 'auto',
  cwd: '/repo/harnessmate',
  title: 'Fix auth retry',
  status: 'idle',
  model: 'gpt-5',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 6,
  usage: null,
  pendingApprovalCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('Phase 2.3 · Session Explorer & Side Chat UI', () => {
  it('renders XSS-safe highlighted snippets and SessionExplorer FTS5 / CLI Importer / Bundle v2 views', () => {
    const xssSnippet = renderToStaticMarkup(
      <SafeHighlightedSnippet
        text="Fix <script>alert(1)</script> oauth token bug"
        highlights={[{ start: 30, end: 35 }]}
      />,
    );
    expect(xssSnippet).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xssSnippet).not.toContain('<script>');
    expect(xssSnippet).toContain('<mark');
    expect(xssSnippet).toContain('oauth');

    const hits: SessionSearchHit[] = [
      {
        sessionId: 'sess_1',
        sessionTitle: 'Fix auth retry',
        workspaceId: 'ws_1',
        turnId: 'turn_2',
        turnSeq: 2,
        itemId: 'item_2',
        blockType: 'assistant_text',
        snippetText: 'Resolved oauth token refresh issue',
        snippetHtmlSafe: 'Resolved <mark>oauth</mark> token refresh issue',
        highlights: [{ start: 9, end: 14 }],
        driverId: 'codex',
        createdAt: Date.now(),
      },
    ];
    const searchHtml = renderToStaticMarkup(
      <SessionExplorerView
        workspaces={[sampleWorkspace]}
        harnesses={[sampleHarness]}
        sessions={[sampleSession]}
        selectedSession={sampleSession}
        initialTab="search"
        initialHits={hits}
        onJumpToHit={() => {}}
        onImportNative={async () => {}}
        onImportBundle={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(searchHtml).toContain('FTS5 全文检索');
    expect(searchHtml).toContain('Fix auth retry');
    expect(searchHtml).toContain('seq #2');

    const discovered: DiscoveredCliSession[] = [
      {
        harnessKind: 'codex',
        source: 'codex_desktop',
        scannerId: 'codex',
        nativeSessionId: 'nat_zst_1',
        title: 'Archived Codex Debug',
        cwd: '/repo/harnessmate',
        updatedAt: Date.now(),
        fileSizeBytes: 2_500_000,
        compressed: true,
        alreadyImportedSessionId: 'sess_1',
      },
    ];
    const importHtml = renderToStaticMarkup(
      <SessionExplorerView
        workspaces={[sampleWorkspace]}
        harnesses={[sampleHarness]}
        sessions={[sampleSession]}
        selectedSession={sampleSession}
        initialTab="import"
        initialDiscovered={discovered}
        onJumpToHit={() => {}}
        onImportNative={async () => {}}
        onImportBundle={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(importHtml).toContain('只读镜像');
    expect(importHtml).toContain('直接接管续跑');
    expect(importHtml).toContain('Archived Codex Debug');
    expect(importHtml).toContain('zstd 归档');
    expect(importHtml).toContain('已导入');
  });

  it('renders isolated Side Chat drawer with promote-to-fork action', () => {
    const msgs: SideChatMessage[] = [
      { id: 'm1', role: 'user', text: 'Explain token refresh flow', createdAt: Date.now() },
      { id: 'm2', role: 'assistant', text: 'Uses sliding window mutex', harnessId: 'codex', createdAt: Date.now() },
    ];
    const html = renderToStaticMarkup(
      <SideChatView
        session={sampleSession}
        messages={msgs}
        sending={false}
        promoting={false}
        onSend={() => {}}
        onClear={() => {}}
        onPromote={() => {}}
      />,
    );
    expect(html).toContain('Side Chat 侧栏问答');
    expect(html).toContain('绝不污染主会话时间线');
    expect(html).toContain('升级为分叉');
    expect(html).toContain('Explain token refresh flow');
  });
});

describe('Phase 2.3 · Approval, Question & Secret Center UI', () => {
  it('aggregates approvals, questions, and secret requests in GlobalAttentionStrip', () => {
    const pending: ApprovalRequest[] = [
      {
        id: 'req_1',
        sessionId: 'sess_1',
        nativeRequestId: 'n1',
        kind: 'command_approval',
        toolName: 'bash',
        toolKind: 'shell',
        summary: 'rm -rf /',
        input: {},
        riskLevel: 'critical',
        status: 'pending',
        createdAt: Date.now(),
      },
      {
        id: 'req_2',
        sessionId: 'sess_2',
        parentSessionId: 'sess_1',
        nativeRequestId: 'n2',
        kind: 'user_question',
        toolName: 'ask_user',
        toolKind: 'other',
        summary: 'Pick DB',
        input: {},
        riskLevel: 'low',
        status: 'pending',
        createdAt: Date.now(),
      },
      {
        id: 'req_3',
        sessionId: 'sess_1',
        nativeRequestId: 'n3',
        kind: 'secret_request',
        toolName: 'secret',
        toolKind: 'other',
        summary: 'API Key',
        input: {},
        riskLevel: 'low',
        status: 'pending',
        createdAt: Date.now(),
      },
    ];
    const html = renderToStaticMarkup(
      <GlobalAttentionStrip
        pendingRequests={pending}
        sessions={[sampleSession]}
        selectedSessionId="sess_1"
        onJumpToSession={() => {}}
        onOpenRiskRules={() => {}}
      />,
    );
    expect(html).toContain('1 个待审批');
    expect(html).toContain('1 个提问');
    expect(html).toContain('1 个凭据请求');
    expect(html).toContain('跳转下一待决');
    expect(html).toContain('风险规则');
  });

  it('enforces honest driver decision buttons and double-confirm guard on critical risk in ComposerPendingRequestBar', () => {
    const registry = new SlotRegistry();
    const criticalReq: ApprovalRequest = {
      id: 'req_crit',
      sessionId: 'sess_1',
      nativeRequestId: 'n_crit',
      kind: 'command_approval',
      toolName: 'bash',
      toolKind: 'shell',
      summary: 'rm -rf /',
      input: { command: 'rm -rf /' },
      riskLevel: 'critical',
      // Driver honestly declares ONLY allow_once and deny (NO allow_session!)
      supportedDecisions: ['allow_once', 'deny'],
      annotations: [
        {
          pluginId: 'hm.plugin.approval-center',
          risk: 'critical',
          severity: 'critical',
          label: '递归强制删除根目录',
          detail: '不可逆数据灾难',
        },
        {
          pluginId: 'ext.slow-sec',
          risk: 'low',
          severity: 'info',
          label: '部分安全规则检查未响应',
          degraded: true,
        },
      ],
      status: 'pending',
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(
      <SlotRegistryProvider registry={registry}>
        <ComposerPendingRequestBar
          session={sampleSession}
          pendingRequests={[criticalReq]}
          onResolve={async () => ({ conflict: false })}
        />
      </SlotRegistryProvider>,
    );
    expect(html).toContain('高危操作确认 (CRITICAL)');
    expect(html).toContain('高危操作禁止单键误触');
    expect(html).toContain('部分安全规则检查未响应');
    expect(html).toContain('允许本次');
    expect(html).toContain('拒绝');
    // Must NEVER fabricate allow_session when driver did not declare it!
    expect(html).not.toContain('本会话信任');
    // Approve button must be disabled before double-confirm checkbox is checked
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*允许本次/);
  });

  it('renders user_question options, password-masked secret_request input, and redacted historical receipt block', () => {
    const questionReq: ApprovalRequest = {
      id: 'req_q',
      sessionId: 'sess_1',
      nativeRequestId: 'nq',
      kind: 'user_question',
      toolName: 'ask',
      toolKind: 'other',
      summary: 'Choose targets',
      input: {},
      riskLevel: 'low',
      questionSpec: {
        question: 'Select target environments',
        selectionMode: 'multiple',
        allowFreeText: true,
        options: [
          { id: 'staging', label: 'Staging' },
          { id: 'prod', label: 'Production' },
        ],
      },
      status: 'pending',
      createdAt: Date.now(),
    };
    const qHtml = renderToStaticMarkup(
      <UserQuestionCard
        request={questionReq}
        submitting={false}
        onSubmitAnswer={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(qHtml).toContain('Select target environments');
    expect(qHtml).toContain('type="checkbox"');
    expect(qHtml).toContain('Staging');
    expect(qHtml).toContain('Production');

    const secretReq: ApprovalRequest = {
      id: 'req_sec',
      sessionId: 'sess_1',
      nativeRequestId: 'ns',
      kind: 'secret_request',
      toolName: 'secret',
      toolKind: 'other',
      summary: 'Provide deploy token',
      input: {},
      riskLevel: 'low',
      secretSpec: {
        prompt: 'Provide deploy token',
        fieldLabel: 'DEPLOY_TOKEN',
      },
      status: 'pending',
      createdAt: Date.now(),
    };
    const secretHtml = renderToStaticMarkup(
      <SecretRequestInputCard
        request={secretReq}
        submitting={false}
        onSubmitSecret={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(secretHtml).toContain('type="password"');
    expect(secretHtml).toContain('私密凭据通道（noLog）');
    expect(secretHtml).toContain('DEPLOY_TOKEN');

    // Historical receipt card must ALWAYS hide secret content even if receiptText was passed something else
    const receiptHtml = renderToStaticMarkup(
      <RuntimeRequestReceiptBlock
        kind="secret_request"
        title="凭据请求回执"
        receiptText="LEAKED_SHOULD_NOT_SHOW"
        requestStatus="resolved"
        resolvedBy="mobile"
      />,
    );
    expect(receiptHtml).toContain('已安全提供凭据（内容已隐藏）');
    expect(receiptHtml).not.toContain('LEAKED_SHOULD_NOT_SHOW');
    expect(receiptHtml).toContain('移动端');
  });
});
