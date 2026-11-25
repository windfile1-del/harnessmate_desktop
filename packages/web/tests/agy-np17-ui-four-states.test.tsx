import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalRequest, Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgyArtifactReviewWorkspace, createReadOnlyArtifactWorkspaceFixture } from '../src/components/agy/native/review';
import { AgyNativeSettingsWorkspace, createAuthorizedSettingsSnapshotFixture } from '../src/components/agy/native/settings';
import {
  AgyWorkbenchShell,
  CapabilityUnavailable,
  DEFAULT_WORKBENCH_ROUTE,
  NativeRequestCard,
  createLiveReactiveFixture,
  createStaleReconcilingFixture,
  ensureDefaultWorkbenchViewsRegistered,
} from '../src/components/agy/native/shared';
import type { NativeRequestReceiptDto } from '../src/lib/native-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fourStateMatrix = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../scripts/agy-np/e2e/fixtures', 'e2e-ui-four-states.json'), 'utf8'),
);

const sampleSession: Session = {
  id: 'sess_np17_ui_states',
  workspaceId: 'ws_np17',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/synthetic/repo',
  title: 'NP-17 Four States Verification',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 4,
  usage: null,
  pendingApprovalCount: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
};

const pendingApproval: ApprovalRequest = {
  id: 'appr_np17_action_1',
  sessionId: sampleSession.id,
  nativeRequestId: '7101',
  kind: 'permission',
  toolName: 'Read diagnostic check',
  toolKind: 'read',
  summary: 'Read workspace status safely',
  input: null,
  diffPreview: null,
  riskLevel: 'low',
  supportedDecisions: ['allow_once', 'allow_session', 'deny'],
  status: 'pending',
  resolvedBy: null,
  decision: null,
  comment: null,
  createdAt: 1_500,
  resolvedAt: null,
};

describe('NP-17 Four UI Experience States (Actionable / Read-Only / No-Data / Stale-Request)', () => {
  it('1. Actionable state renders interactive approve/deny controls on live attached projection', () => {
    ensureDefaultWorkbenchViewsRegistered();
    const fx = createLiveReactiveFixture(sampleSession.id);
    const pendingReceipt: NativeRequestReceiptDto = {
      receiptId: 'rcpt_action_1',
      approvalId: pendingApproval.id,
      kind: 'permission',
      receiptState: 'pending',
      targetLineage: 'confirmed',
      agentId: fx.projection.agents[0]?.id,
      updatedAt: 1_600,
    };

    const html = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={sampleSession}
        projection={{
          ...fx.projection,
          receipts: { [pendingApproval.id]: pendingReceipt },
        }}
        syncState={{ phase: 'live', gapRetryCount: 0, requiresFullResync: false, lastSyncedAt: 1_600 }}
        capabilities={fx.capabilities}
        pendingApprovals={[pendingApproval]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({})}
      />,
    );

    for (const label of fourStateMatrix.states.actionable.expectButtons) {
      expect(html).toContain(label);
    }
    expect(html).toContain(`data-testid="${fourStateMatrix.states.actionable.expectDataTestId}"`);
    expect(html).toContain(`data-receipt-state="${fourStateMatrix.states.actionable.expectReceiptState}"`);
  });

  it('2. Read-only state disables write actions across disconnected workbench, review gate-off, and settings boundaries', () => {
    ensureDefaultWorkbenchViewsRegistered();
    const fx = createLiveReactiveFixture(sampleSession.id);

    const wbHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={sampleSession}
        projection={{ ...fx.projection, status: 'disconnected' }}
        syncState={{ phase: 'live', gapRetryCount: 0, requiresFullResync: false, lastSyncedAt: 1_700 }}
        capabilities={fx.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({})}
      />,
    );
    expect(wbHtml).toContain(fourStateMatrix.states.read_only.expectText);
    for (const forbidden of fourStateMatrix.states.read_only.forbidButtons) {
      expect(wbHtml).not.toContain(forbidden);
    }

    const reviewOffHtml = renderToStaticMarkup(
      <AgyArtifactReviewWorkspace
        {...createReadOnlyArtifactWorkspaceFixture({
          featureGates: {
            nativeArtifactsEnabled: false,
            lineCommentsWriteEnabled: false,
            browserMediaEnabled: false,
          },
        })}
      />,
    );
    expect(reviewOffHtml).toContain(fourStateMatrix.states.read_only.artifactGateDisabledText);

    const settingsHtml = renderToStaticMarkup(
      <AgyNativeSettingsWorkspace snapshot={createAuthorizedSettingsSnapshotFixture()} initialSection="ecosystem" />,
    );
    expect(settingsHtml).toContain(fourStateMatrix.states.read_only.ecosystemReadOnlyText);
  });

  it('3. No-data state surfaces honest empty/not-loaded boundaries instead of fabricating progress', () => {
    ensureDefaultWorkbenchViewsRegistered();
    const noProjHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={sampleSession}
        projection={null}
        syncState={null}
        capabilities={[]}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({})}
      />,
    );
    expect(noProjHtml).toContain(fourStateMatrix.states.no_data.expectTitle);

    const fx = createLiveReactiveFixture(sampleSession.id);
    const emptyWorkHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={sampleSession}
        projection={{ ...fx.projection, work: [] }}
        syncState={{ phase: 'live', gapRetryCount: 0, requiresFullResync: false, lastSyncedAt: 1_700 }}
        capabilities={fx.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({})}
      />,
    );
    expect(emptyWorkHtml).toContain(fourStateMatrix.states.no_data.expectEmptyWorkCopy);

    const noSettingsHtml = renderToStaticMarkup(<AgyNativeSettingsWorkspace snapshot={null} />);
    expect(noSettingsHtml).toContain(fourStateMatrix.states.no_data.expectUnloadedSettingsTitle);
  });

  it('4. Stale-request state renders connection_lost/reconciling receipts without replaying interactive approval buttons', () => {
    ensureDefaultWorkbenchViewsRegistered();
    const staleFx = createStaleReconcilingFixture(sampleSession.id);
    const staleReceipt: NativeRequestReceiptDto = {
      receiptId: 'rcpt_stale_1',
      approvalId: pendingApproval.id,
      kind: 'permission',
      receiptState: 'connection_lost',
      targetLineage: 'unconfirmed',
      updatedAt: 1_800,
    };

    const cardHtml = renderToStaticMarkup(
      <NativeRequestCard approval={{ ...pendingApproval, status: 'pending' }} receipt={staleReceipt} />,
    );
    expect(cardHtml).toContain(`data-receipt-state="${fourStateMatrix.states.stale_request.expectReceiptState}"`);
    expect(cardHtml).toContain(fourStateMatrix.states.stale_request.expectText);
    for (const forbidden of fourStateMatrix.states.stale_request.forbidButtons) {
      expect(cardHtml).not.toContain(forbidden);
    }

    const reconcilingHtml = renderToStaticMarkup(
      <AgyWorkbenchShell
        session={sampleSession}
        projection={staleFx.projection}
        syncState={{ phase: 'incomplete', gapRetryCount: 2, requiresFullResync: true, lastSyncedAt: 1_800 }}
        capabilities={staleFx.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'runtime' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({})}
      />,
    );
    expect(reconcilingHtml).toContain(fourStateMatrix.states.stale_request.expectReconcilingText);

    const fallbackHtml = renderToStaticMarkup(
      <CapabilityUnavailable
        title="能力探测过时"
        gate="unknown"
        reason="旧请求在重连后已失效"
        capabilityId="AGY-S03"
      />,
    );
    expect(fallbackHtml).toContain('data-capability-gate="unknown"');
  });
});
