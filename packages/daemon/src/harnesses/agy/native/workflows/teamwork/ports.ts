import path from 'node:path';
import type {
  AgentForeground,
  AgentLineage,
  Evidence,
  GateState,
  NativeAgentId,
  RuntimeBinding,
} from '@harnessmate/protocol';
import type { NativeWorkflowDescriptorContribution } from '../../commands/descriptors.js';
import {
  TEAMWORK_CAPABILITY_ID,
  TEAMWORK_PRIMARY_SLASH_COMMAND,
  type TeamworkPathAccessGate,
  type TeamworkScopeRelationship,
} from './schemas.js';

export interface TeamworkFeatureGateConfig {
  /** Master feature flag for Teamwork observer/controls. Default false; turning off preserves read-only history. */
  readonly teamworkEnabled: boolean;
  /** Independent gate for native Prompt Artifact review/approval control (owned by NP-14). Default false. */
  readonly reviewControlEnabled: boolean;
}

export const DEFAULT_TEAMWORK_FEATURE_GATES: Readonly<TeamworkFeatureGateConfig> = Object.freeze({
  teamworkEnabled: false,
  reviewControlEnabled: false,
});

// ── NP-14 Frozen Artifact Review & Approval Seam ───────────────────────

export interface TeamworkArtifactReviewCapability {
  readonly canRead: boolean;
  readonly canComment: boolean;
  readonly canApproveViaNativeProtocol: boolean;
  readonly approveGate: GateState;
  readonly reasonCode: string;
  readonly officialFallbackHint: string;
}

export interface TeamworkArtifactSummaryRecord {
  readonly artifactId: string;
  readonly title: string;
  readonly artifactKind: 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown';
  readonly revision: number;
  readonly updatedAt: number;
  readonly previewExcerpt?: string;
}

export interface TeamworkArtifactApprovalSubmission {
  readonly binding: RuntimeBinding;
  readonly artifactId: string;
  readonly decision: 'approve' | 'reject';
  readonly requestId?: string;
  readonly idempotencyKey: string;
}

export interface TeamworkArtifactApprovalSubmissionResult {
  readonly accepted: boolean;
  readonly receiptId?: string;
  readonly state: 'response_written' | 'rejected' | 'unsupported' | 'conflict';
  readonly reasonCode: string;
}

/**
 * Frozen contract seam consumed by NP-10 and implemented by NP-14 (Artifact & Review).
 * NP-10 never fabricates native artifact approvals via natural language chat turns.
 */
export interface TeamworkArtifactReviewPort {
  getReviewCapability(
    binding: RuntimeBinding,
    artifactId: string,
  ): TeamworkArtifactReviewCapability;
  readArtifactSummary(
    binding: RuntimeBinding,
    artifactId: string,
  ): TeamworkArtifactSummaryRecord | null;
  submitNativeArtifactApproval?(
    input: TeamworkArtifactApprovalSubmission,
  ): Promise<TeamworkArtifactApprovalSubmissionResult>;
}

export function createDegradedTeamworkArtifactReviewStub(): TeamworkArtifactReviewPort {
  return {
    getReviewCapability() {
      return {
        canRead: false,
        canComment: false,
        canApproveViaNativeProtocol: false,
        approveGate: 'upstream_limited',
        reasonCode: 'np14_artifact_review_control_unavailable',
        officialFallbackHint:
          '当前 ACP 尚未接通原生 Prompt Artifact 审阅批准接口（等待 NP-14 联测）；请在官方 Antigravity App 或 CLI 中完成审阅与批准。',
      };
    },
    readArtifactSummary() {
      return null;
    },
  };
}

// ── Project Scope & Path Authorization Seam ────────────────────────────

export interface TeamworkPathAuthorizationInput {
  readonly binding: RuntimeBinding;
  /** HarnessMate session workspace root (kept server-side only). */
  readonly hmWorkspaceRoot?: string | null;
  /** Candidate native Teamwork project directory reported by verified event or authorized source. */
  readonly nativeProjectPath?: string | null;
  /** Additional explicitly authorized roots bound to this session. */
  readonly authorizedRoots?: readonly string[];
  /** Provenance of the path candidate: guessed or assistant-text paths are always rejected. */
  readonly pathSource: 'native_event' | 'authorized_user_selection' | 'unknown';
  /** Caller-verified flag confirming realpath check passed with no reparse/symlink escape. */
  readonly reparseCheckPassed?: boolean;
}

export interface TeamworkPathAuthorizationDecision {
  readonly authorized: boolean;
  readonly scopeRelationship: TeamworkScopeRelationship;
  readonly pathAccessGate: TeamworkPathAccessGate;
  readonly reasonCode: string;
  readonly safeProjectLabel?: string;
}

export interface TeamworkPathAuthorizationPort {
  evaluateProjectPath(input: TeamworkPathAuthorizationInput): TeamworkPathAuthorizationDecision;
}

function normalizePosixOrWinPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  const unified = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || /^[a-zA-Z]:\//.test(unified)
    ? unified.toLowerCase()
    : unified;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normCandidate = normalizePosixOrWinPath(candidate);
  const normRoot = normalizePosixOrWinPath(root);
  if (!normCandidate || !normRoot) return false;
  return normCandidate === normRoot || normCandidate.startsWith(`${normRoot}/`);
}

function hasUnsafePathSegments(rawPath: string): boolean {
  if (!rawPath || rawPath.includes('\0')) return true;
  if (/^\\\\[?./]?\\/.test(rawPath) || rawPath.startsWith('\\\\')) return true;
  const parts = rawPath.replace(/\\/g, '/').split('/');
  return parts.some((segment) => segment === '..');
}

function deriveSafeLabelFromPath(rawPath: string): string | undefined {
  const cleaned = rawPath.trim().replace(/[\\/]+$/, '');
  if (!cleaned) return undefined;
  const base = path.win32.basename(cleaned) || path.posix.basename(cleaned);
  const safe = base.replace(/[^a-zA-Z0-9._ -]/g, '').trim();
  return safe ? safe.slice(0, 120) : undefined;
}

/**
 * Default fail-closed Teamwork path authorizer.
 * Guarantees:
 * - HM workspace scope and native Teamwork project directory are explicitly distinguished.
 * - Unknown-source, traversal (`..`), UNC/device, or reparse-unverified paths are NEVER authorized.
 * - Only paths inside explicitly authorized roots (with reparse check passed) allow read-only open.
 */
export function createStrictTeamworkPathAuthorizer(): TeamworkPathAuthorizationPort {
  return {
    evaluateProjectPath(input: TeamworkPathAuthorizationInput): TeamworkPathAuthorizationDecision {
      const candidate = input.nativeProjectPath?.trim() ?? '';
      if (!candidate) {
        return {
          authorized: false,
          scopeRelationship: 'unverified',
          pathAccessGate: 'unavailable',
          reasonCode: 'native_project_path_not_observed',
        };
      }

      if (input.pathSource === 'unknown') {
        return {
          authorized: false,
          scopeRelationship: 'unverified',
          pathAccessGate: 'requires_explicit_authorization',
          reasonCode: 'project_path_source_unverified',
        };
      }

      if (hasUnsafePathSegments(candidate)) {
        return {
          authorized: false,
          scopeRelationship: 'unverified',
          pathAccessGate: 'requires_explicit_authorization',
          reasonCode: 'project_path_unsafe_segments_blocked',
        };
      }

      const safeProjectLabel = deriveSafeLabelFromPath(candidate);
      const hmRoot = input.hmWorkspaceRoot?.trim() ?? '';
      const additionalRoots = (input.authorizedRoots ?? []).filter((r) => r.trim().length > 0);
      const inHmWorkspace = hmRoot ? isWithinRoot(candidate, hmRoot) : false;
      const inAdditionalRoot = additionalRoots.some((root) => isWithinRoot(candidate, root));

      if (!inHmWorkspace && !inAdditionalRoot) {
        return {
          authorized: false,
          scopeRelationship: 'distinct_from_hm_workspace',
          pathAccessGate: 'requires_explicit_authorization',
          reasonCode: 'native_project_outside_authorized_roots',
          ...(safeProjectLabel ? { safeProjectLabel } : {}),
        };
      }

      if (input.reparseCheckPassed !== true) {
        return {
          authorized: false,
          scopeRelationship: inHmWorkspace ? 'within_authorized_root' : 'distinct_from_hm_workspace',
          pathAccessGate: 'requires_explicit_authorization',
          reasonCode: 'reparse_verification_required_before_open',
          ...(safeProjectLabel ? { safeProjectLabel } : {}),
        };
      }

      return {
        authorized: true,
        scopeRelationship: 'within_authorized_root',
        pathAccessGate: 'authorized_read_only',
        reasonCode: 'authorized_within_verified_root',
        ...(safeProjectLabel ? { safeProjectLabel } : {}),
      };
    },
  };
}

// ── NP-05 Confirmed Child Lineage Seam ─────────────────────────────────

export interface TeamworkConfirmedRoleLookup {
  readonly binding: RuntimeBinding;
  readonly agentId?: NativeAgentId;
  readonly wireChildSessionId?: string;
  readonly toolCallId?: string;
}

export interface TeamworkResolvedRoleAgent {
  readonly agentId: NativeAgentId;
  readonly lineage: AgentLineage;
  readonly displayLabel?: string;
  readonly foreground: AgentForeground;
  readonly evidence: Evidence;
}

export interface TeamworkChildLineagePort {
  resolveRoleAgent(input: TeamworkConfirmedRoleLookup): TeamworkResolvedRoleAgent | null;
}

// ── NP-06 Command Catalog Descriptor Contribution ──────────────────────

/**
 * Extensible descriptor contribution for `AgyNativeCommandCatalogService` (NP-06).
 * Strictly records `/teamwork` and explicitly documents that legacy `/teamwork-preview`
 * is NOT assumed supported.
 */
export const TEAMWORK_CAPABILITY_CONTRIBUTION: Readonly<NativeWorkflowDescriptorContribution> =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-10.teamwork',
    capabilityId: TEAMWORK_CAPABILITY_ID,
    aliasIds: ['agy.workflow.teamwork'],
    slashName: TEAMWORK_PRIMARY_SLASH_COMMAND,
    title: 'Teamwork 访谈、项目与里程碑',
    description:
      '观察官方 /teamwork 需求访谈、Prompt Artifact 审阅门控、项目作用域边界、已证实角色（Sentinel / Project Orchestrator / Auditor）与里程碑。不假定旧 /teamwork-preview 可用，不通过自然语言伪造批准。',
    surfaces: ['desktop', 'cli', 'acp'],
    tierHint: 'Pro/Ultra',
    versionNote: 'Only /teamwork is tracked; legacy /teamwork-preview is rejected unless explicitly advertised and verified.',
    officialEntry: '官方 App / CLI /teamwork <goal>',
    evidenceRefs: ['E01', 'S21', 'T12-synthetic'],
    verifiedLevel: null,
    launchGateOverride: 'not_tested',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'upstream_limited',
    localReadGateOverride: 'not_tested',
  });
