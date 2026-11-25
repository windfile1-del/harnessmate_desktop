import type {
  ArtifactContentView,
  ArtifactSummaryView,
  AgyArtifactReviewWorkspaceProps,
  BrowserObservationView,
  PlanSnapshotView,
  ToolDiffView,
} from './types';

export function createReadOnlyArtifactWorkspaceFixture(
  overrides?: Partial<AgyArtifactReviewWorkspaceProps>,
): AgyArtifactReviewWorkspaceProps {
  const summaries: ArtifactSummaryView[] = [
    {
      artifactId: 'art_brain_plan_01',
      title: 'implementation_plan.md',
      originKind: 'brain_session',
      contentKind: 'markdown',
      revision: 2,
      sizeBytes: 240,
      updatedAt: 1_760_000_000_000,
      scope: {
        scopeKind: 'root',
        ownerLineage: 'confirmed',
        isHistorical: false,
        readOnly: true,
      },
      verifiedActionKeys: ['read_artifact'],
      reviewWireSupport: 'unverified_pending_live_capture',
      provenance: {
        sourceKind: 'native_snapshot',
        freshness: 'snapshot',
        observedAt: 1_760_000_000_000,
      },
    },
    {
      artifactId: 'art_tw_prompt_01',
      title: 'teamwork-prompt.md',
      originKind: 'teamwork_prompt',
      contentKind: 'markdown',
      revision: 1,
      sizeBytes: 180,
      updatedAt: 1_760_000_010_000,
      scope: {
        scopeKind: 'confirmed_workflow',
        ownerLineage: 'confirmed',
        isHistorical: false,
        readOnly: true,
      },
      verifiedActionKeys: ['read_artifact'],
      reviewWireSupport: 'unverified_pending_live_capture',
      provenance: {
        sourceKind: 'live_protocol',
        freshness: 'live',
        observedAt: 1_760_000_010_000,
      },
    },
  ];

  const content: ArtifactContentView = {
    artifactId: 'art_brain_plan_01',
    title: 'implementation_plan.md',
    originKind: 'brain_session',
    contentKind: 'markdown',
    revision: 2,
    content: [
      '# Safe Review Plan',
      '- Step 1: Validate managed paths',
      '- [Official Docs](https://antigravity.google/docs/artifact-review/)',
      '- [Untrusted Link](https://evil.example/steal)',
      '![Tracking](https://evil.example/pixel.png)',
      '<script>alert("xss")</script>',
    ].join('\n'),
    totalChars: 240,
    lineCount: 6,
    nextPageToken: null,
    hasMore: false,
    truncated: false,
    scope: summaries[0]!.scope,
    security: {
      secretsRedactedCount: 0,
      hostPathsRedactedCount: 0,
      htmlStrippedOrEscaped: true,
      unsafeLinksBlockedCount: 2,
      binaryRejected: false,
      redactionNotes: ['raw_html_neutralized_as_text', 'unreviewed_link_blocked'],
    },
    verifiedActionKeys: ['read_artifact'],
    provenance: summaries[0]!.provenance,
  };

  const planSnapshot: PlanSnapshotView = {
    planModeActive: true,
    enforcement: 'native',
    steps: [
      {
        id: 'acp_plan_1',
        title: 'Inspect AGY brain directory',
        status: 'completed',
        priority: 'high',
        source: 'acp_agent_plan',
      },
      {
        id: 'agy_step_2',
        title: 'Run update_steps checklist',
        status: 'in_progress',
        source: 'agy_update_steps',
      },
    ],
    revision: 2,
    isHistorical: false,
    updatedAt: 1_760_000_020_000,
    provenance: {
      sourceKind: 'live_protocol',
      freshness: 'live',
      observedAt: 1_760_000_020_000,
    },
  };

  const toolDiffs: ToolDiffView[] = [
    {
      diffId: 'diff_01',
      toolCallId: 'tc_diff_1',
      relativeDisplayPath: 'project/README.md',
      unifiedDiff: '--- a/project/README.md\n+++ b/project/README.md\n@@ -1,1 +1,1 @@\n-old\n+new',
      truncated: false,
      origin: 'acp_tool_diff',
      ownerLineage: 'confirmed',
      approvalState: 'approved',
      revision: 1,
      isHistorical: false,
      updatedAt: 1_760_000_025_000,
      provenance: {
        sourceKind: 'live_protocol',
        freshness: 'live',
        observedAt: 1_760_000_025_000,
      },
    },
  ];

  const browserObservation: BrowserObservationView = {
    surface: 'app_embedded_browser',
    controlSupported: false,
    surfaceReasonCode: 'app_embedded_browser_read_only',
    officialAppGuide:
      'Antigravity App 内嵌浏览器交互属 App-only 能力 (https://antigravity.google/docs/browser/)。',
    roles: [
      {
        roleId: 'br_role_1',
        lineage: 'confirmed',
        label: 'Browser Verification',
        surface: 'app_embedded_browser',
        state: 'running',
        canControlBrowser: false,
        provenance: {
          sourceKind: 'live_protocol',
          freshness: 'live',
          observedAt: 1_760_000_030_000,
        },
      },
    ],
    logs: [
      {
        seq: 1,
        timestamp: 1_760_000_030_000,
        surface: 'app_embedded_browser',
        actionSummary: 'Inspected preview page in App embedded browser',
        redactedTargetHost: 'example.test',
        status: 'running',
        provenance: {
          sourceKind: 'live_protocol',
          freshness: 'live',
          observedAt: 1_760_000_030_000,
        },
      },
    ],
    droppedLogCount: 0,
    mediaReferences: [],
    mediaGateEnabled: false,
    isHistorical: false,
    revision: 1,
    updatedAt: 1_760_000_030_000,
  };

  return {
    runtimeStatus: 'attached',
    featureGates: {
      nativeArtifactsEnabled: true,
      reviewControlEnabled: false,
      mediaArtifactsEnabled: false,
    },
    artifacts: summaries,
    selectedArtifactId: 'art_brain_plan_01',
    selectedContent: content,
    reviewCapability: {
      canRead: true,
      canComment: false,
      canApproveViaNativeProtocol: false,
      approveGate: 'upstream_limited',
      reasonCode: 'review_wire_schema_unverified',
      officialFallbackHint:
        '当前 ACP 尚未实录证实原生评论/批准线格式；请在官方 Antigravity App 或 CLI 中完成批准。',
    },
    planSnapshot,
    toolDiffs,
    browserObservation,
    ...overrides,
  };
}
