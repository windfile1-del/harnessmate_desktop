import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgyArtifactReviewPanel } from '../src/components/agy/AgyArtifactReviewPanel';
import {
  AgyArtifactReviewWorkspace,
  BrowserAgentPanel,
  PlanAndDiffSeparationPanel,
  SafeArtifactContentView,
  createReadOnlyArtifactWorkspaceFixture,
  parseSafeMarkdown,
} from '../src/components/agy/native/review';

const sampleSession: Session = {
  id: 'sess_np14_web_1',
  workspaceId: 'ws_1',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-14 Web Test',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  permissionEnforcement: 'client_guard',
  lastSeq: 1,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('NP-14 · Web Safe Artifact Review, Plan/Diff Separation & Browser Agent UI (T16)', () => {
  it('neutralizes XSS payloads, blocks unreviewed links/external images, and permits allowlisted official docs', () => {
    const raw = [
      '# Untrusted Artifact',
      '<script>alert("pwn")</script>',
      '<img src="x" onerror="alert(1)">',
      '<svg onload="alert(2)">',
      '[Steal](javascript:alert(3))',
      '[External](https://evil.example/payload)',
      '![Pixel](https://evil.example/track.png)',
      '[Official Review Docs](https://antigravity.google/docs/artifact-review/)',
    ].join('\n');

    const parsed = parseSafeMarkdown(raw);
    expect(parsed.rawHtmlDetected).toBe(true);
    expect(parsed.blockedLinksCount).toBe(2);
    expect(parsed.blockedImagesCount).toBe(1);

    const fixture = createReadOnlyArtifactWorkspaceFixture();
    const html = renderToStaticMarkup(
      <SafeArtifactContentView
        summary={fixture.artifacts[0]!}
        content={{ ...fixture.selectedContent!, content: raw }}
        runtimeStatus="attached"
        featureGates={fixture.featureGates}
        reviewCapability={fixture.reviewCapability}
      />,
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('href="https://antigravity.google/docs/artifact-review/"');
    expect(html).toContain('np14-security-redaction-banner');
    expect(html).toContain('np14-blocked-link-token');
  });

  it('renders read-only mode when reviewControlEnabled=false, unlocks verified live controls, and locks historical snapshots', () => {
    const gateOff = createReadOnlyArtifactWorkspaceFixture();
    const htmlOff = renderToStaticMarkup(<AgyArtifactReviewWorkspace {...gateOff} />);
    expect(htmlOff).toContain('AGY Artifact &amp; Review Workspace');
    expect(htmlOff).toContain('当前保持受控只读模式');
    expect(htmlOff).not.toContain('np14-native-approve-btn');

    const liveVerified = createReadOnlyArtifactWorkspaceFixture({
      featureGates: {
        nativeArtifactsEnabled: true,
        reviewControlEnabled: true,
        mediaArtifactsEnabled: false,
      },
      artifacts: [
        {
          ...gateOff.artifacts[0]!,
          scope: { ...gateOff.artifacts[0]!.scope, readOnly: false },
          verifiedActionKeys: [
            'read_artifact',
            'submit_native_comment',
            'submit_native_approval',
            'submit_native_rejection',
          ],
          reviewWireSupport: 'verified_live_wire',
          pendingRequestId: 'req_live_1',
        },
      ],
      reviewCapability: {
        canRead: true,
        canComment: true,
        canApproveViaNativeProtocol: true,
        approveGate: 'available',
        reasonCode: 'verified_native_artifact_review_ready',
        officialFallbackHint: 'Ready',
      },
    });
    const htmlOn = renderToStaticMarkup(<AgyArtifactReviewWorkspace {...liveVerified} />);
    expect(htmlOn).toContain('np14-native-approve-btn');
    expect(htmlOn).toContain('np14-native-reject-btn');

    // Historical snapshots MUST remain read-only even when reviewControlEnabled=true
    const historicalHtml = renderToStaticMarkup(
      <SafeArtifactContentView
        summary={{
          ...liveVerified.artifacts[0]!,
          scope: { ...liveVerified.artifacts[0]!.scope, isHistorical: true, scopeKind: 'historical' },
        }}
        content={liveVerified.selectedContent!}
        runtimeStatus="attached"
        featureGates={liveVerified.featureGates}
        reviewCapability={liveVerified.reviewCapability}
      />,
    );
    expect(historicalHtml).not.toContain('np14-native-approve-btn');
    expect(historicalHtml).toContain('历史快照仅提供只读回看');
  });

  it('separates Plan (AGY-W13) and ACP Tool Diffs (AGY-W15) from Artifact Review', () => {
    const fixture = createReadOnlyArtifactWorkspaceFixture();
    const html = renderToStaticMarkup(
      <PlanAndDiffSeparationPanel
        planSnapshot={fixture.planSnapshot}
        toolDiffs={fixture.toolDiffs ?? []}
      />,
    );
    expect(html).toContain('Plan 计划与执行步骤 (AGY-W13)');
    expect(html).toContain('ACP plan');
    expect(html).toContain('AGY update_steps');
    expect(html).toContain('ACP 工具变更 Diff (AGY-W15)');
    expect(html).toContain('独立于 Artifact Review 与工作区 Git Diff');
    expect(html).toContain('project/README.md');
  });

  it('distinguishes App embedded browser (App-only) vs CLI/Enterprise Chrome MCP and enforces independent media gate', () => {
    const fixture = createReadOnlyArtifactWorkspaceFixture();
    const appHtml = renderToStaticMarkup(
      <BrowserAgentPanel observation={fixture.browserObservation} />,
    );
    expect(appHtml).toContain('Antigravity App 内嵌浏览器 (App-only)');
    expect(appHtml).toContain('不复刻 AGY App 内嵌浏览器交互控制');
    expect(appHtml).toContain('媒体门控已关闭');

    const enterpriseHtml = renderToStaticMarkup(
      <BrowserAgentPanel
        observation={{
          ...fixture.browserObservation!,
          surface: 'enterprise_chrome_mcp',
          mediaGateEnabled: true,
          mediaReferences: [
            {
              mediaId: 'br_media_1',
              label: 'step1_screen.png',
              mediaKind: 'screenshot',
              mimeType: 'image/png',
              sizeBytes: 2048,
              magicVerified: true,
              sha256Prefix: 'abcd1234',
              gatedOff: false,
              updatedAt: 1000,
              provenance: {
                sourceKind: 'native_snapshot',
                freshness: 'snapshot',
                observedAt: 1000,
              },
            },
          ],
        }}
      />,
    );
    expect(enterpriseHtml).toContain('企业 Chrome MCP（受策略约束）');
    expect(enterpriseHtml).toContain('媒体参考门控已开启');
    expect(enterpriseHtml).toContain('step1_screen.png');
    expect(enterpriseHtml).toContain('magic-verified');
  });

  it('supports narrow 480px viewport, master gate off degradation, and legacy AgyArtifactReviewPanel compatibility', () => {
    const narrowFixture = createReadOnlyArtifactWorkspaceFixture({ isNarrowViewport: true });
    const narrowHtml = renderToStaticMarkup(<AgyArtifactReviewWorkspace {...narrowFixture} />);
    expect(narrowHtml).toContain('data-narrow="true"');

    const disabledMaster = createReadOnlyArtifactWorkspaceFixture({
      featureGates: {
        nativeArtifactsEnabled: false,
        reviewControlEnabled: false,
        mediaArtifactsEnabled: false,
      },
    });
    const disabledHtml = renderToStaticMarkup(<AgyArtifactReviewWorkspace {...disabledMaster} />);
    expect(disabledHtml).toContain('np14-workspace-gate-disabled');

    // Legacy mode disables unverified approval buttons while preserving read-only numbered preview
    const legacyHtml = renderToStaticMarkup(
      <AgyArtifactReviewPanel
        session={sampleSession}
        initialArtifacts={[{ name: 'plan.md', kind: 'markdown', sizeBytes: 12, updatedAt: 1000 }]}
        initialContent={{
          name: 'plan.md',
          kind: 'markdown',
          sizeBytes: 12,
          updatedAt: 1000,
          content: '# Legacy Plan',
          truncated: false,
        }}
      />,
    );
    expect(legacyHtml).toContain('# Legacy Plan');
    expect(legacyHtml).toContain('只读产物预览');
    expect(legacyHtml).toContain('disabled=""');
  });
});
