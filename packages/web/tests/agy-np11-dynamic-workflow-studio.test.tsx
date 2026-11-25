import type { Session } from '@harnessmate/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgyWorkbenchRegistry,
  AgyWorkbenchShell,
  DEFAULT_WORKBENCH_ROUTE,
  makeFixtureCapabilities,
  registerDefaultWorkbenchViews,
} from '../src/components/agy/native/shared';
import {
  DynamicWorkflowStudio,
  analyzeDynamicDag,
  buildSortableWorkflowTimeline,
  createDynamicDegradedAndForwardedFixture,
  createDynamicParallelSerialFixture,
  registerDynamicWorkflowStudioView,
} from '../src/components/agy/native/workflow';
import type { NativeStage } from '../src/lib/native-client';

const sampleSession: Session = {
  id: 'sess_np11_web',
  workspaceId: 'ws_np11',
  harnessId: 'agy',
  harnessKind: 'agy',
  participatingHarnesses: ['agy'],
  contextSyncMode: 'auto',
  cwd: 'D:/repo',
  title: 'NP-11 Dynamic Workflow Studio Test',
  status: 'idle',
  model: 'gemini-3.8-flash',
  actualModel: 'gemini-3.8-flash',
  reasoningEffort: 'medium',
  permissionMode: 'manual',
  lastSeq: 5,
  usage: null,
  pendingApprovalCount: 0,
  createdAt: 1000,
  updatedAt: 2000,
};

describe('NP-11 Dynamic Workflow Studio Frontend & View Model', () => {
  it('registers into AgyWorkbenchRegistry (order=110) and overrides NP-03 default dynamic shell cleanly', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);
    const dispose = registerDynamicWorkflowStudioView(registry);

    const view = registry.getView('dynamic');
    expect(view?.owner).toBe('np-11.dynamic-workflow-studio');
    expect(view?.order).toBe(110);

    const fixture = createDynamicParallelSerialFixture(sampleSession.id);
    const html = renderToStaticMarkup(
      <AgyWorkbenchShell
        registry={registry}
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        loadWorkflowResource={fixture.loadWorkflowResource}
      />,
    );

    expect(html).toContain('np11-dynamic-workflow-studio');
    expect(html).toContain('np11-dag-layers');
    expect(html).toContain('Phase 1 · 并发分支');
    expect(html).toContain('Phase 2 · 串行阶段');

    dispose();
    expect(registry.getView('dynamic')?.owner).not.toBe('np-11.dynamic-workflow-studio');
  });

  it('renders T13 parallel+serial DAG, read-only script preview, node inspector, and confirmed child links', () => {
    const fixture = createDynamicParallelSerialFixture(sampleSession.id);
    const html = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        scriptPreviewByWorkflowId={fixture.scriptPreviewByWorkflowId}
        resultPreviewByArtifactId={fixture.resultPreviewByArtifactId}
        loadWorkflowResource={fixture.loadWorkflowResource}
      />,
    );

    expect(html).toContain('np11-script-review');
    expect(html).toContain('不在客户端执行 Python');
    expect(html).toContain('脚本已获批准');
    expect(html).toContain('np11-script-preview-code');
    expect(html).toContain('np11-selected-step-inspector');
    expect(html).toContain('ag_child_lint');
    expect(html).toContain('np11-result-card-art_res_t13_summary');
    expect(html).toContain('不信任或渲染产物内嵌 HTML');
  });

  it('honestly degrades missing DAG edges or cyclic edges into sortable timeline without fabricating DAG', () => {
    const fixture = createDynamicDegradedAndForwardedFixture(
      sampleSession.id,
      'missing_edges_partial_fail',
    );
    const html = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={fixture.projection}
        capabilities={fixture.capabilities}
        pendingApprovals={fixture.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        resultPreviewByArtifactId={fixture.resultPreviewByArtifactId}
        stepErrorByStepId={fixture.stepErrorByStepId}
      />,
    );

    expect(html).toContain('np11-no-dag-notice');
    expect(html).toContain('np11-sortable-timeline');
    expect(html).not.toContain('np11-dag-layers');
    expect(html).toContain('部分节点失败 · 已保留部分结果');
    expect(html).toContain('Step exited with code 2');
    expect(html).toContain('art_res_partial_a');

    // View-model unit checks for timeline sort order & cycle fallback
    const wf = fixture.projection.workflows[0]!;
    const asc = buildSortableWorkflowTimeline({
      workflow: wf,
      works: fixture.projection.work,
      requests: [],
      sortOrder: 'asc',
    });
    const desc = buildSortableWorkflowTimeline({
      workflow: wf,
      works: fixture.projection.work,
      requests: [],
      sortOrder: 'desc',
    });
    expect(asc.map((i) => i.stepId)).toEqual(['step_ok', 'step_fail']);
    expect(desc.map((i) => i.stepId)).toEqual(['step_fail', 'step_ok']);

    const cyclicSteps: NativeStage[] = [
      {
        id: 'a',
        label: 'A',
        state: { kind: 'known', value: 'running', evidence: { sourceKind: 'replay', freshness: 'replay', observedAt: 100 } },
        after: ['b'],
      },
      {
        id: 'b',
        label: 'B',
        state: { kind: 'known', value: 'running', evidence: { sourceKind: 'replay', freshness: 'replay', observedAt: 100 } },
        after: ['a'],
      },
    ];
    const cyclicAnalysis = analyzeDynamicDag(cyclicSteps);
    expect(cyclicAnalysis.hasVerifiedDag).toBe(false);
    expect(cyclicAnalysis.hasCycle).toBe(true);
    expect(cyclicAnalysis.unavailableReason).toBe('cyclic_dependency_edges_detected');
  });

  it('renders denied script status and AGY 1.5.16 forwarded questions with fixed options and zero free-text box', () => {
    const denied = createDynamicDegradedAndForwardedFixture(sampleSession.id, 'script_denied');
    const deniedHtml = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={denied.projection}
        capabilities={denied.capabilities}
        pendingApprovals={denied.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={true}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        requestMetadataByApprovalId={denied.requestMetadataByApprovalId}
        scriptPreviewByWorkflowId={denied.scriptPreviewByWorkflowId}
      />,
    );
    expect(deniedHtml).toContain('脚本已被拒绝');
    expect(deniedHtml).toContain('动态工作流脚本未获批准');
    expect(deniedHtml).toContain('data-narrow="true"');

    const forwarded = createDynamicDegradedAndForwardedFixture(
      sampleSession.id,
      'forwarded_1516_question',
    );
    const forwardedHtml = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={forwarded.projection}
        capabilities={forwarded.capabilities}
        pendingApprovals={forwarded.approvals}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        requestMetadataByApprovalId={forwarded.requestMetadataByApprovalId}
        scriptPreviewByWorkflowId={forwarded.scriptPreviewByWorkflowId}
      />,
    );
    expect(forwardedHtml).toContain('工作流脚本批准与 1.5.16 问题转发');
    expect(forwardedHtml).toContain('仅检查 docs/');
    expect(forwardedHtml).toContain('经父会话转发');
    expect(forwardedHtml).not.toContain('<textarea');
  });

  it('renders disconnected/stale banner, empty state, and escapes untrusted HTML inside result previews', () => {
    const emptyHtml = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={null}
        capabilities={makeFixtureCapabilities()}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={true}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
      />,
    );
    expect(emptyHtml).toContain('AGY-W08');
    expect(emptyHtml).toContain('/run-workflow');

    const fixture = createDynamicParallelSerialFixture(sampleSession.id);
    const staleHtml = renderToStaticMarkup(
      <DynamicWorkflowStudio
        session={sampleSession}
        projection={{ ...fixture.projection, status: 'disconnected' }}
        capabilities={fixture.capabilities}
        pendingApprovals={[]}
        route={{ ...DEFAULT_WORKBENCH_ROUTE, surface: 'dynamic' }}
        isNarrowViewport={false}
        onNavigate={() => {}}
        onBackToChat={() => {}}
        onRefresh={() => {}}
        onResolveRequest={async () => ({ conflict: false })}
        resultPreviewByArtifactId={{
          art_res_t13_summary: {
            artifactId: 'art_res_t13_summary',
            title: 'Untrusted HTML Payload',
            format: 'unparsed_text',
            previewText: '<script>alert("xss")</script><img src=x onerror=alert(1)>',
            truncated: false,
          },
        }}
      />,
    );
    expect(staleHtml).toContain('观测连接已断开 · 状态已过期');
    expect(staleHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(staleHtml).not.toContain('<script>alert');
  });
});
