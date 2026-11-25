import {
  toPublicEvidenceDto,
  type Evidence,
  type PublicEvidenceDto,
  type RuntimeBinding,
  type WorkflowId,
} from '@harnessmate/protocol';
import type { NativeWorkflowDescriptorContribution } from '../../commands/descriptors.js';

export const DYNAMIC_ARTIFACT_PORT_REVISION = 'agy-np11-np14-artifact-port-v1.0.0' as const;

const OPAQUE_ARTIFACT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export function isValidOpaqueArtifactId(value: string): boolean {
  if (!value || value.length > 128) return false;
  if (
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('.')
  ) {
    // Note: colons are allowed in opaque IDs only when NOT a drive prefix like C:\ or file://
    if (/^[a-zA-Z]:/.test(value) || value.includes('://') || value.includes('/') || value.includes('\\') || value.includes('..')) {
      return false;
    }
  }
  return OPAQUE_ARTIFACT_ID_RE.test(value);
}

export type DynamicArtifactReadErrorCode =
  | 'UNAPPROVED_ARTIFACT_SCOPE'
  | 'ARTIFACT_NOT_FOUND'
  | 'BINDING_MISMATCH'
  | 'SOURCE_UNAVAILABLE';

export type DynamicArtifactTextPageResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly content: string;
      readonly totalChars: number;
      readonly nextPageToken: string | null;
      readonly hasMore: boolean;
      readonly truncated: boolean;
      readonly provenance: PublicEvidenceDto;
    }
  | {
      readonly ok: false;
      readonly errorCode: DynamicArtifactReadErrorCode;
      readonly message: string;
    };

export type DynamicStructuredResultPageResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly format: 'json_array' | 'json_object' | 'scalar' | 'text';
      readonly items: readonly unknown[];
      readonly totalItems: number;
      readonly nextPageToken: string | null;
      readonly hasMore: boolean;
      readonly provenance: PublicEvidenceDto;
    }
  | {
      readonly ok: false;
      readonly errorCode: DynamicArtifactReadErrorCode;
      readonly message: string;
    };

/**
 * Frozen NP-11 <-> NP-14 safe read-only artifact seam.
 *
 * Guarantees:
 * - Only approved opaque `artifactId` values scoped to `(runtimeId, generation, workflowId)` may be read.
 * - Unapproved filesystem paths (e.g. raw `ScriptPath`), drive letters, or traversal strings are rejected.
 * - Text previews and structured JSON result arrays are paginated with bounded chunk sizes.
 */
export interface DynamicWorkflowArtifactReaderPort {
  readonly contractRevision: typeof DYNAMIC_ARTIFACT_PORT_REVISION;
  isApprovedArtifactId(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
    artifactId: string,
  ): boolean;
  readScriptPreview(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly pageToken?: string;
    readonly maxChars?: number;
  }): DynamicArtifactTextPageResult;
  readStructuredResult(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly pageToken?: string;
    readonly limit?: number;
  }): DynamicStructuredResultPageResult;
}

interface StoredApprovedScriptEntry {
  readonly binding: RuntimeBinding;
  readonly workflowId: WorkflowId;
  readonly artifactId: string;
  readonly text: string;
  readonly evidence: Evidence;
}

interface StoredApprovedResultEntry {
  readonly binding: RuntimeBinding;
  readonly workflowId: WorkflowId;
  readonly artifactId: string;
  readonly payload: unknown;
  readonly evidence: Evidence;
}

function parseOffsetToken(token: string | undefined): number {
  if (!token) return 0;
  const parsed = Number.parseInt(token, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Deterministic in-memory stub implementing `DynamicWorkflowArtifactReaderPort` until NP-14 lands.
 * Only serves artifacts explicitly registered for a given `(runtimeId, generation, workflowId)`.
 */
export class FrozenDynamicWorkflowArtifactReaderStub
  implements DynamicWorkflowArtifactReaderPort
{
  readonly contractRevision = DYNAMIC_ARTIFACT_PORT_REVISION;
  private readonly scripts = new Map<string, StoredApprovedScriptEntry>();
  private readonly results = new Map<string, StoredApprovedResultEntry>();

  private scopeKey(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
    artifactId: string,
  ): string {
    return `${binding.runtimeId}::${binding.generation}::${workflowId}::${artifactId}`;
  }

  registerApprovedScript(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly text: string;
    readonly evidence: Evidence;
  }): void {
    if (!isValidOpaqueArtifactId(input.artifactId)) {
      throw new Error(`Invalid opaque script artifactId: ${input.artifactId}`);
    }
    this.scripts.set(
      this.scopeKey(input.binding, input.workflowId, input.artifactId),
      input,
    );
  }

  registerApprovedStructuredResult(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly payload: unknown;
    readonly evidence: Evidence;
  }): void {
    if (!isValidOpaqueArtifactId(input.artifactId)) {
      throw new Error(`Invalid opaque result artifactId: ${input.artifactId}`);
    }
    this.results.set(
      this.scopeKey(input.binding, input.workflowId, input.artifactId),
      input,
    );
  }

  isApprovedArtifactId(
    binding: RuntimeBinding,
    workflowId: WorkflowId,
    artifactId: string,
  ): boolean {
    if (!isValidOpaqueArtifactId(artifactId)) return false;
    const key = this.scopeKey(binding, workflowId, artifactId);
    return this.scripts.has(key) || this.results.has(key);
  }

  readScriptPreview(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly pageToken?: string;
    readonly maxChars?: number;
  }): DynamicArtifactTextPageResult {
    if (!isValidOpaqueArtifactId(input.artifactId)) {
      return {
        ok: false,
        errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
        message: 'Rejected non-opaque or path-like artifact identifier',
      };
    }
    const entry = this.scripts.get(
      this.scopeKey(input.binding, input.workflowId, input.artifactId),
    );
    if (!entry) {
      return {
        ok: false,
        errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
        message: `Script artifact "${input.artifactId}" is not approved in this workflow scope`,
      };
    }

    const maxChars = Math.max(64, Math.min(input.maxChars ?? 4000, 16_000));
    const offset = Math.min(parseOffsetToken(input.pageToken), entry.text.length);
    const slice = entry.text.slice(offset, offset + maxChars);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < entry.text.length;

    return {
      ok: true,
      artifactId: entry.artifactId,
      content: slice,
      totalChars: entry.text.length,
      nextPageToken: hasMore ? String(nextOffset) : null,
      hasMore,
      truncated: hasMore,
      provenance: toPublicEvidenceDto(entry.evidence),
    };
  }

  readStructuredResult(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly pageToken?: string;
    readonly limit?: number;
  }): DynamicStructuredResultPageResult {
    if (!isValidOpaqueArtifactId(input.artifactId)) {
      return {
        ok: false,
        errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
        message: 'Rejected non-opaque or path-like artifact identifier',
      };
    }
    const entry = this.results.get(
      this.scopeKey(input.binding, input.workflowId, input.artifactId),
    );
    if (!entry) {
      return {
        ok: false,
        errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
        message: `Result artifact "${input.artifactId}" is not approved in this workflow scope`,
      };
    }

    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const offset = parseOffsetToken(input.pageToken);
    const payload = entry.payload;

    if (Array.isArray(payload)) {
      const sliced = payload.slice(offset, offset + limit);
      const nextOffset = offset + sliced.length;
      const hasMore = nextOffset < payload.length;
      return {
        ok: true,
        artifactId: entry.artifactId,
        format: 'json_array',
        items: sliced,
        totalItems: payload.length,
        nextPageToken: hasMore ? String(nextOffset) : null,
        hasMore,
        provenance: toPublicEvidenceDto(entry.evidence),
      };
    }

    if (payload && typeof payload === 'object') {
      const entries = Object.entries(payload as Record<string, unknown>);
      const sliced = entries.slice(offset, offset + limit).map(([key, value]) => ({
        key,
        value,
      }));
      const nextOffset = offset + sliced.length;
      const hasMore = nextOffset < entries.length;
      return {
        ok: true,
        artifactId: entry.artifactId,
        format: 'json_object',
        items: sliced,
        totalItems: entries.length,
        nextPageToken: hasMore ? String(nextOffset) : null,
        hasMore,
        provenance: toPublicEvidenceDto(entry.evidence),
      };
    }

    return {
      ok: true,
      artifactId: entry.artifactId,
      format: typeof payload === 'string' ? 'text' : 'scalar',
      items: offset === 0 ? [payload] : [],
      totalItems: 1,
      nextPageToken: null,
      hasMore: false,
      provenance: toPublicEvidenceDto(entry.evidence),
    };
  }
}

/**
 * Capability descriptor contribution for NP-06 Command Catalog (`AGY-W08` / `agy.workflow.dynamic`).
 * Keeps `launch` at `not_tested` and `control` at `unknown` until live T13 Windows capture verifies
 * `/run-workflow` ACP triggering and workflow cancellation.
 */
export const DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION: NativeWorkflowDescriptorContribution =
  Object.freeze<NativeWorkflowDescriptorContribution>({
    contributorId: 'np-11.dynamic-workflow',
    capabilityId: 'AGY-W08',
    aliasIds: ['agy.workflow.dynamic'],
    slashName: 'run-workflow',
    title: 'Dynamic Workflow 动态工作流',
    description:
      '观察 AGY 生成的工作流脚本审阅、phase/DAG 执行轨迹、日志分页与结构化结果；缺边时诚实降级为时序时间线。',
    surfaces: ['desktop', 'cli', 'acp'],
    officialEntry: '官方 App / CLI /run-workflow <task>',
    evidenceRefs: ['E01', 'T13-synthetic'],
    verifiedLevel: null,
    launchGateOverride: 'not_tested',
    observeGateOverride: 'upstream_limited',
    controlGateOverride: 'unknown',
    localReadGateOverride: 'not_tested',
  });
