import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AgyWorkbenchRegistry,
  DEFAULT_WORKBENCH_ROUTE,
  registerDefaultWorkbenchViews,
  type NativeWorkbenchViewProps,
} from '../src/components/agy/native/shared';
import {
  TeamworkStudioView,
  createTeamworkApprovedMilestone1Fixture,
  createTeamworkCapabilitiesFixture,
  createTeamworkDisconnectedStaleFixture,
  createTeamworkPromptReviewDegradedFixture,
  createTeamworkRejectedFixture,
  createTeamworkSessionFixture,
  deriveTeamworkApprovalGate,
  deriveTeamworkRoles,
  registerTeamworkStudioView,
  type TeamworkStudioProps,
} from '../src/components/agy/native/teamwork';

function makeBaseProps(overrides?: Partial<TeamworkStudioProps>): TeamworkStudioProps {
  return {
    session: createTeamworkSessionFixture(),
    projection: null,
    capabilities: createTeamworkCapabilitiesFixture(),
    pendingApprovals: [],
    route: {
      ...DEFAULT_WORKBENCH_ROUTE,
      surface: 'teamwork',
      layout: 'full',
    },
    isNarrowViewport: false,
    onNavigate: vi.fn(),
    onBackToChat: vi.fn(),
    onRefresh: vi.fn(),
    onResolveRequest: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('NP-10 Teamwork Studio UI & Workbench Registration', () => {
  it('registers Teamwork Studio at order 200 (full layout) overriding built-in shell and restores cleanly on dispose', () => {
    const registry = new AgyWorkbenchRegistry();
    registerDefaultWorkbenchViews(registry);

    const before = registry.getView('teamwork');
    expect(before?.owner).toBe('core.agy-workbench');
    expect(before?.order).toBe(900);

    const dispose = registerTeamworkStudioView(registry);
    const active = registry.getView('teamwork');
    expect(active?.owner).toBe('np-10.teamwork');
    expect(active?.order).toBe(200);
    expect(active?.preferredLayout).toBe('full');
    expect(active?.capabilityIds).toContain('AGY-W07');

    const { projection } = createTeamworkApprovedMilestone1Fixture();
    expect(active?.badgeCount?.(projection, [])).toBe(1);

    dispose();
    expect(registry.getView('teamwork')?.owner).toBe('core.agy-workbench');
  });

  it('renders honest degraded empty state and legacy /teamwork-preview warning when unobserved', () => {
    const html = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection: null,
          commandDiscoveryState: 'legacy_preview_unverified',
        }),
      ),
    );

    expect(html).toContain('data-testid="np10-teamwork-studio"');
    expect(html).toContain('data-teamwork-state="empty"');
    expect(html).toContain('data-testid="np10-legacy-preview-warning"');
    expect(html).toContain('/teamwork-preview');
    expect(html).toContain('AGY-W07');
    expect(html).toContain('https://antigravity.google/docs/teamwork/');
  });

  it('renders scoping Q&A and Prompt Artifact awaiting approval with NP-14 disabled props (guides to official App, no natural-language approve button)', () => {
    const { projection, pendingApprovals, scopingItems } =
      createTeamworkPromptReviewDegradedFixture();
    const html = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection,
          pendingApprovals,
          scopingItemsOverride: scopingItems,
          reviewControl: {
            reviewControlEnabled: false,
            canApproveViaNativeProtocol: false,
            promptArtifactTitle: 'Payments Migration Prompt Spec',
            promptArtifactPreview: 'Goal: migrate ledger with strict audit gates.',
            promptArtifactRevision: 1,
          },
        }),
      ),
    );

    expect(html).toContain('data-testid="np10-scoping-questions-list"');
    expect(html).toContain('幂等去重：已忽略 1 次重复投递');
    expect(html).toContain('data-testid="np10-prompt-artifact-panel"');
    expect(html).toContain('data-approval-gate="upstream_limited_manual_app"');
    expect(html).toContain('data-native-approval-enabled="false"');
    expect(html).toContain('art_tw_prompt_v1');
    expect(html).toContain('严禁通过自然语言聊天消息伪造 Prompt Artifact 批准');
    expect(html).not.toContain('data-testid="np10-native-approve-btn"');
    expect(html).toContain('data-testid="np10-milestones-hidden-notice"');
  });

  it('renders formal rejection state confirming zero project, roles, or milestones created', () => {
    const projection = createTeamworkRejectedFixture();
    const html = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection,
          approvalGateOverride: 'rejected',
        }),
      ),
    );

    expect(html).toContain('data-approval-gate="rejected"');
    expect(html).toContain('data-testid="np10-rejection-confirmed-banner"');
    expect(html).toContain('未创建 Teamwork 项目目录、Sentinel / Project Orchestrator 角色或里程碑');
    expect(html).toContain('data-testid="np10-milestones-hidden-notice"');
    expect(html).not.toContain('data-testid="np10-milestones-list"');
  });

  it('renders approved project with distinct HM vs Native scope, confirmed multi-role trace, unconfirmed candidate separation, Milestone 1, Audit, and zero raw host paths', () => {
    const { projection, projectScope, auditEntries, artifacts } =
      createTeamworkApprovedMilestone1Fixture();

    const roles = deriveTeamworkRoles(projection, projection.workflows[0] as never);
    expect(roles.confirmedRoles.map((r) => r.roleKind)).toEqual([
      'sentinel',
      'project_orchestrator',
      'auditor',
    ]);
    expect(roles.unconfirmedCandidates).toHaveLength(1);

    const html = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection,
          projectScopeOverride: projectScope,
          auditEntriesOverride: auditEntries,
          artifactsOverride: artifacts,
        }),
      ),
    );

    expect(html).toContain('payments-migration-v2');
    expect(html).toContain('data-testid="np10-scope-boundary"');
    expect(html).toContain('与原生 Teamwork 目录隔离');
    expect(html).toContain('需明确路径授权');
    expect(html).toContain('data-testid="np10-open-project-path-btn"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-testid="np10-role-sentinel"');
    expect(html).toContain('data-testid="np10-role-project_orchestrator"');
    expect(html).toContain('data-testid="np10-role-auditor"');
    expect(html).toContain('data-testid="np10-unconfirmed-roles-section"');
    expect(html).toContain('data-testid="np10-milestone-ms_1"');
    expect(html).toContain('data-testid="np10-audit-list"');
    expect(html).toContain('审计通过');
    expect(html).toContain('data-testid="np10-artifacts-list"');
    expect(html).not.toMatch(/[a-zA-Z]:\\/);
  });

  it('preserves read-only history on disconnect and feature-gate rollback, and unlocks formal NP-14 buttons only when explicitly verified & attached', () => {
    // Disconnected stale projection
    const staleProjection = createTeamworkDisconnectedStaleFixture();
    const staleHtml = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection: staleProjection,
          isNarrowViewport: true,
        }),
      ),
    );
    expect(staleHtml).toContain('data-readonly="true"');
    expect(staleHtml).toContain('data-narrow="true"');
    expect(staleHtml).toContain('data-testid="np10-runtime-stale-banner"');
    expect(staleHtml).toContain('payments-migration-v2');

    // Feature gate disabled keeps observed history read-only
    const { projection } = createTeamworkApprovedMilestone1Fixture();
    const disabledHtml = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection,
          teamworkFeatureEnabled: false,
        }),
      ),
    );
    expect(disabledHtml).toContain('data-testid="np10-feature-disabled-banner"');
    expect(disabledHtml).toContain('data-readonly="true"');
    expect(disabledHtml).toContain('payments-migration-v2');

    // NP-14 wired & enabled on live attached binding enables formal native Approve/Reject buttons
    const { projection: reviewProj } = createTeamworkPromptReviewDegradedFixture();
    const gate = deriveTeamworkApprovalGate({
      projection: reviewProj,
      workflow: reviewProj.workflows[0] as never,
      capability: createTeamworkCapabilitiesFixture({ control: 'available' })[0],
      reviewControl: {
        reviewControlEnabled: true,
        canApproveViaNativeProtocol: true,
        onNativeApprove: vi.fn(async () => {}),
        onNativeReject: vi.fn(async () => {}),
      },
      teamworkFeatureEnabled: true,
    });
    expect(gate.canActNativeApproval).toBe(true);

    const enabledHtml = renderToStaticMarkup(
      createElement(
        TeamworkStudioView,
        makeBaseProps({
          projection: reviewProj,
          capabilities: createTeamworkCapabilitiesFixture({ control: 'available' }),
          reviewControl: {
            reviewControlEnabled: true,
            canApproveViaNativeProtocol: true,
            onNativeApprove: vi.fn(async () => {}),
            onNativeReject: vi.fn(async () => {}),
          },
        }),
      ),
    );
    expect(enabledHtml).toContain('data-testid="np10-native-approve-btn"');
    expect(enabledHtml).toContain('data-testid="np10-native-reject-btn"');

    // Type-check compatibility with pure NativeWorkbenchViewProps
    const baseViewProps: NativeWorkbenchViewProps = makeBaseProps({ projection });
    expect(baseViewProps.route.surface).toBe('teamwork');
  });
});
