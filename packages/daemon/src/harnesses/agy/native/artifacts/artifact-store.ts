import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  toPublicEvidenceDto,
  type AgentLineage,
  type Evidence,
  type NativeAgentId,
  type PublicEvidenceDto,
  type RuntimeBinding,
  type WorkflowId,
} from '@harnessmate/protocol';
import { isSafeArtifactSegment, MAX_ARTIFACT_FILES } from '../../agy-artifacts.js';
import { resolveManagedProfilePathSync } from '../../agy-profile-manager.js';
import type { ChildScopeResolverPort } from '../child/contracts.js';
import {
  DYNAMIC_ARTIFACT_PORT_REVISION,
  isValidOpaqueArtifactId,
  type DynamicArtifactTextPageResult,
  type DynamicStructuredResultPageResult,
  type DynamicWorkflowArtifactReaderPort,
} from '../workflows/dynamic/ports.js';
import type {
  TeamworkArtifactApprovalSubmission,
  TeamworkArtifactApprovalSubmissionResult,
  TeamworkArtifactReviewCapability,
  TeamworkArtifactReviewPort,
  TeamworkArtifactSummaryRecord,
} from '../workflows/teamwork/ports.js';
import {
  AGY_ARTIFACT_CONTRACT_REVISION,
  AGY_ARTIFACT_SCHEMA_VERSION,
  AGY_OFFICIAL_DOC_URLS,
  ArtifactResourceContentDtoSchema,
  ArtifactResourceSummaryDtoSchema,
  DEFAULT_AGY_ARTIFACT_FEATURE_GATES,
  createUnverifiedReviewTransportStub,
  type AgyArtifactFeatureGates,
  type ArtifactContentKind,
  type ArtifactOriginKind,
  type ArtifactResourceContentDto,
  type ArtifactResourceSummaryDto,
  type ArtifactReviewWireSupportStatus,
  type ArtifactScopeSummaryDto,
  type ArtifactVerifiedActionKey,
  type NativeArtifactReviewTransportPort,
} from './contracts.js';
import {
  inspectManagedMediaReferenceSync,
  redactSensitiveContent,
  sanitizeRelativeDisplayPath,
  verifyManagedTextArtifactSync,
} from './redaction.js';

interface StoredArtifactEntry {
  readonly artifactId: string;
  readonly binding: RuntimeBinding;
  readonly title: string;
  readonly originKind: ArtifactOriginKind;
  readonly contentKind: ArtifactContentKind;
  readonly rawText: string;
  readonly structuredPayload?: unknown;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  readonly contentDigest: string;
  revision: number;
  readonly scope: ArtifactScopeSummaryDto;
  readonly evidence: Evidence;
  readonly workflowId?: WorkflowId;
}

interface PendingReviewRequestBinding {
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly requestId: string;
  readonly wireSupport: ArtifactReviewWireSupportStatus;
  readonly allowedDecisions: ReadonlySet<'approve' | 'reject' | 'comment'>;
  settled: boolean;
  submitting?: boolean;
  decision?: 'approve' | 'reject';
  receiptId?: string;
}

interface StoredApprovalReceipt {
  readonly payloadDigest: string;
  readonly result: TeamworkArtifactApprovalSubmissionResult;
}

interface BindingArtifactScope {
  readonly binding: RuntimeBinding;
  activeConnectionId: string | null;
  rootNativeSessionId: string | null;
  profileRef?: string;
  sourceRef?: string;
  appDataPath?: string;
  isHistorical: boolean;
  readonly artifactsById: Map<string, StoredArtifactEntry>;
  readonly brainIdByFileName: Map<string, string>;
  readonly reviewRequestsByArtifactId: Map<string, PendingReviewRequestBinding>;
  readonly approvedDynamicIds: Set<string>;
}

export interface AgyNativeArtifactServiceOptions {
  readonly gates?: Partial<AgyArtifactFeatureGates>;
  readonly reviewTransport?: NativeArtifactReviewTransportPort;
  readonly childScopeResolver?: ChildScopeResolverPort;
  readonly now?: () => number;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId &&
    a.generation === b.generation
  );
}

function bindingSlotKey(binding: Pick<RuntimeBinding, 'runtimeId' | 'sessionId' | 'instanceId'>): string {
  return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}`;
}

function parseOffsetToken(token: string | undefined): number {
  if (!token) return 0;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function hashSha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function deriveBrainArtifactId(fileName: string): string {
  const short = crypto.createHash('sha1').update(fileName, 'utf8').digest('hex').slice(0, 12);
  return `art_brain_${short}`;
}

function mapFileExtToContentKind(fileName: string): ArtifactContentKind {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.diff' || ext === '.patch') return 'diff';
  if (ext === '.json') return 'json';
  return 'text';
}

function mapContentKindToTeamworkKind(
  kind: ArtifactContentKind,
): 'markdown' | 'text' | 'diff' | 'script' | 'json' | 'media' | 'unknown' {
  if (kind === 'media_ref') return 'media';
  return kind;
}

/**
 * NP-14 Safe Native Artifact Store & Review Bridge.
 *
 * Enforces:
 * - Managed-profile non-reparse filesystem reads with extension/segment allowlists.
 * - Generation & connection fencing + historical read-only isolation.
 * - Secret/host-path/XSS redaction before DTO serialization.
 * - Verified-wire-only native Teamwork Prompt Artifact approval with same-binding,
 *   same-connection, same-artifact revision, same-requestId, and idempotency checks.
 * - Strict opaque-ID scope verification for NP-11 Dynamic Workflow scripts/results.
 */
export class AgyNativeArtifactService {
  private gates: AgyArtifactFeatureGates;
  private readonly reviewTransport: NativeArtifactReviewTransportPort;
  private readonly childScopeResolver?: ChildScopeResolverPort;
  private readonly now: () => number;
  private readonly scopesBySlot = new Map<string, BindingArtifactScope>();
  private readonly scopesByGenKey = new Map<string, BindingArtifactScope>();
  private readonly approvalReceipts = new Map<string, StoredApprovalReceipt>();

  constructor(options: AgyNativeArtifactServiceOptions = {}) {
    this.gates = Object.freeze({
      ...DEFAULT_AGY_ARTIFACT_FEATURE_GATES,
      ...options.gates,
    });
    this.reviewTransport = options.reviewTransport ?? createUnverifiedReviewTransportStub();
    this.childScopeResolver = options.childScopeResolver;
    this.now = options.now ?? (() => Date.now());
  }

  getGates(): AgyArtifactFeatureGates {
    return this.gates;
  }

  configureGates(patch: Partial<AgyArtifactFeatureGates>): AgyArtifactFeatureGates {
    this.gates = Object.freeze({
      ...this.gates,
      ...patch,
    });
    return this.gates;
  }

  private genKey(binding: RuntimeBinding): string {
    return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}::${binding.generation}`;
  }

  private getCurrentScope(binding: RuntimeBinding): BindingArtifactScope | null {
    const scope = this.scopesByGenKey.get(this.genKey(binding));
    if (!scope) return null;
    const latestSlot = this.scopesBySlot.get(bindingSlotKey(binding));
    if (latestSlot && latestSlot !== scope && !scope.isHistorical) {
      return null;
    }
    return scope;
  }

  private ensureScope(binding: RuntimeBinding, isHistorical = false): BindingArtifactScope {
    const gKey = this.genKey(binding);
    const existing = this.scopesByGenKey.get(gKey);
    if (existing) return existing;

    const created: BindingArtifactScope = {
      binding,
      activeConnectionId: null,
      rootNativeSessionId: null,
      isHistorical,
      artifactsById: new Map(),
      brainIdByFileName: new Map(),
      reviewRequestsByArtifactId: new Map(),
      approvedDynamicIds: new Set(),
    };
    this.scopesByGenKey.set(gKey, created);
    if (!isHistorical) {
      this.scopesBySlot.set(bindingSlotKey(binding), created);
    }
    return created;
  }

  attachConnection(
    binding: RuntimeBinding,
    opts: {
      readonly connectionId: string;
      readonly rootNativeSessionId: string;
      readonly profileRef?: string;
      readonly sourceRef?: string;
      readonly appDataPath?: string;
    },
  ): void {
    if (!opts.connectionId || !opts.rootNativeSessionId) return;
    const slotKey = bindingSlotKey(binding);
    const prior = this.scopesBySlot.get(slotKey);
    if (prior && (!sameBinding(prior.binding, binding) || prior.activeConnectionId !== opts.connectionId)) {
      if (prior.activeConnectionId) {
        this.handleTransportClosed(prior.binding, prior.activeConnectionId, 'connection_replaced');
      }
    }

    const scope = this.ensureScope(binding, false);
    scope.isHistorical = false;
    scope.activeConnectionId = opts.connectionId;
    scope.rootNativeSessionId = opts.rootNativeSessionId;
    scope.profileRef = opts.profileRef ?? scope.profileRef;
    scope.sourceRef = opts.sourceRef ?? scope.sourceRef;
    scope.appDataPath = opts.appDataPath ?? scope.appDataPath;
    this.scopesBySlot.set(slotKey, scope);
  }

  registerHistoricalSession(
    binding: RuntimeBinding,
    opts: {
      readonly nativeSessionId: string;
      readonly appDataPath?: string;
      readonly profileRef?: string;
      readonly sourceRef?: string;
    },
  ): void {
    const existing = this.scopesByGenKey.get(this.genKey(binding));
    if (existing && !existing.isHistorical) return;
    const scope = this.ensureScope(binding, true);
    scope.activeConnectionId = null;
    scope.rootNativeSessionId = opts.nativeSessionId;
    scope.appDataPath = opts.appDataPath ?? scope.appDataPath;
    scope.profileRef = opts.profileRef ?? scope.profileRef;
    scope.sourceRef = opts.sourceRef ?? scope.sourceRef;
  }

  handleTransportClosed(binding: RuntimeBinding, connectionId: string, _reason = 'transport_closed'): void {
    const scope = this.scopesByGenKey.get(this.genKey(binding));
    if (!scope || scope.activeConnectionId !== connectionId) return;
    scope.activeConnectionId = null;
    for (const req of scope.reviewRequestsByArtifactId.values()) {
      if (!req.settled) {
        req.settled = true;
      }
    }
  }

  handleGenerationChanged(prevBinding: RuntimeBinding, nextBinding: RuntimeBinding): void {
    const prev = this.scopesByGenKey.get(this.genKey(prevBinding));
    if (prev && prev.activeConnectionId) {
      this.handleTransportClosed(prevBinding, prev.activeConnectionId, 'generation_changed');
    }
    this.ensureScope(nextBinding, false);
  }

  /**
   * Strictly read-only scan of `<appDataPath>/brain/<nativeSessionId>/` into opaque artifact records.
   */
  syncBrainArtifacts(binding: RuntimeBinding): ArtifactResourceSummaryDto[] {
    const scope = this.getCurrentScope(binding);
    if (!scope || !scope.appDataPath || !scope.rootNativeSessionId) return [];
    const cleanSess = scope.rootNativeSessionId.trim();
    if (!isSafeArtifactSegment(cleanSess)) return [];

    const brainDir = resolveManagedProfilePathSync(scope.appDataPath, ['brain', cleanSess], 'directory');
    if (!brainDir) return [];

    const observedAt = this.now();
    const entries = fs.readdirSync(brainDir.path);
    let count = 0;

    for (const entry of entries) {
      if (count >= MAX_ARTIFACT_FILES) break;
      if (!isSafeArtifactSegment(entry)) continue;

      const textRead = verifyManagedTextArtifactSync(scope.appDataPath, cleanSess, entry);
      if (textRead) {
        count += 1;
        const artifactId = scope.brainIdByFileName.get(entry) ?? deriveBrainArtifactId(entry);
        scope.brainIdByFileName.set(entry, artifactId);
        const existing = scope.artifactsById.get(artifactId);
        const changed = !existing || existing.contentDigest !== textRead.sha256;
        const nextRevision = existing ? (changed ? existing.revision + 1 : existing.revision) : 1;

        const stored: StoredArtifactEntry = {
          artifactId,
          binding,
          title: sanitizeRelativeDisplayPath(entry),
          originKind: scope.isHistorical ? 'history_snapshot' : 'brain_session',
          contentKind: mapFileExtToContentKind(entry),
          rawText: textRead.content,
          sizeBytes: textRead.sizeBytes,
          updatedAt: textRead.updatedAt,
          contentDigest: textRead.sha256,
          revision: nextRevision,
          scope: {
            scopeKind: scope.isHistorical ? 'historical' : 'root',
            ownerLineage: 'confirmed',
            isHistorical: scope.isHistorical,
            readOnly: true,
          },
          evidence: {
            kind: 'native_snapshot',
            sourceId: `brain:${artifactId}`,
            schemaVersion: 'agy-brain-v1',
            observedAt,
            staleAt: observedAt + 60_000,
          },
        };
        scope.artifactsById.set(artifactId, stored);
        continue;
      }

      if (this.gates.mediaArtifactsEnabled) {
        const mediaRef = inspectManagedMediaReferenceSync(scope.appDataPath, cleanSess, entry);
        if (mediaRef) {
          count += 1;
          const artifactId = scope.brainIdByFileName.get(entry) ?? deriveBrainArtifactId(`media:${entry}`);
          scope.brainIdByFileName.set(entry, artifactId);
          const existing = scope.artifactsById.get(artifactId);
          const digest = hashSha256(`${mediaRef.name}:${mediaRef.sizeBytes}:${mediaRef.sha256Prefix}`);
          const nextRevision = existing ? (existing.contentDigest !== digest ? existing.revision + 1 : existing.revision) : 1;
          const summaryText = JSON.stringify({
            label: sanitizeRelativeDisplayPath(mediaRef.name),
            mimeType: mediaRef.mimeType,
            sizeBytes: mediaRef.sizeBytes,
            magicVerified: mediaRef.magicVerified,
            sha256Prefix: mediaRef.sha256Prefix,
          }, null, 2);

          scope.artifactsById.set(artifactId, {
            artifactId,
            binding,
            title: sanitizeRelativeDisplayPath(mediaRef.name),
            originKind: 'browser_reference',
            contentKind: 'media_ref',
            rawText: summaryText,
            sizeBytes: mediaRef.sizeBytes,
            updatedAt: mediaRef.updatedAt,
            contentDigest: digest,
            revision: nextRevision,
            scope: {
              scopeKind: scope.isHistorical ? 'historical' : 'root',
              ownerLineage: 'confirmed',
              isHistorical: scope.isHistorical,
              readOnly: true,
            },
            evidence: {
              kind: 'native_snapshot',
              sourceId: `media:${artifactId}`,
              schemaVersion: 'agy-media-ref-v1',
              observedAt,
              staleAt: observedAt + 60_000,
            },
          });
        }
      }
    }

    return this.listArtifacts(binding);
  }

  registerObservedArtifact(
    binding: RuntimeBinding,
    input: {
      readonly artifactId: string;
      readonly title: string;
      readonly originKind: ArtifactOriginKind;
      readonly contentKind: ArtifactContentKind;
      readonly content: string;
      readonly structuredPayload?: unknown;
      readonly evidence: Evidence;
      readonly ownerAgentId?: NativeAgentId;
      readonly ownerLineage?: AgentLineage;
      readonly wireSessionId?: string;
      readonly wireChildSessionId?: string;
      readonly toolCallId?: string;
      readonly workflowId?: WorkflowId;
      readonly activityId?: ArtifactScopeSummaryDto['activityId'];
      readonly updatedAt?: number;
    },
  ): ArtifactResourceSummaryDto | null {
    if (!isValidOpaqueArtifactId(input.artifactId)) return null;
    const replay = input.evidence.kind === 'replay';
    const existingScope = this.scopesByGenKey.get(this.genKey(binding));
    const currentScope = this.getCurrentScope(binding);
    if ((existingScope && !currentScope) || (replay && currentScope && !currentScope.isHistorical)) return null;
    const scope = currentScope ?? this.ensureScope(binding, replay);
    if (input.evidence.kind === 'live_protocol' && (scope.isHistorical || scope.activeConnectionId !== input.evidence.connectionId)) {
      return null;
    }

    const isHistorical = scope.isHistorical || input.evidence.kind === 'replay';
    let ownerLineage: AgentLineage = input.ownerLineage ?? 'confirmed';
    let ownerAgentId: NativeAgentId | undefined = input.ownerAgentId;
    let scopeKind: ArtifactScopeSummaryDto['scopeKind'] = isHistorical
      ? 'historical'
      : input.workflowId
        ? 'confirmed_workflow'
        : 'root';

    if (
      this.childScopeResolver &&
      scope.rootNativeSessionId &&
      scope.profileRef &&
      input.wireSessionId
    ) {
      const resolved = this.childScopeResolver.resolveScope({
        binding,
        wireSessionId: input.wireSessionId,
        rootNativeSessionId: scope.rootNativeSessionId,
        toolCallId: input.toolCallId,
        wireChildSessionId: input.wireChildSessionId,
        profileRef: scope.profileRef,
        sourceRef: scope.sourceRef,
        connectionId: scope.activeConnectionId ?? undefined,
      });
      ownerLineage = resolved.lineage;
      if (resolved.allowConfirmedChildAttribution && resolved.displayOwnerAgentId) {
        ownerAgentId = resolved.displayOwnerAgentId;
        if (!isHistorical) scopeKind = 'confirmed_child';
      } else if (resolved.matchKind !== 'root_session' && !isHistorical) {
        ownerAgentId = undefined;
        scopeKind = 'unknown_child';
      }
    } else if (ownerAgentId && ownerLineage !== 'confirmed') {
      ownerAgentId = undefined;
      if (!isHistorical) scopeKind = 'unknown_child';
    } else if (ownerAgentId && ownerLineage === 'confirmed' && !isHistorical && !input.workflowId) {
      scopeKind = 'confirmed_child';
    }

    const existing = scope.artifactsById.get(input.artifactId);
    const digest = hashSha256(input.content);
    const nextRevision = existing ? (existing.contentDigest !== digest ? existing.revision + 1 : existing.revision) : 1;
    const entry: StoredArtifactEntry = {
      artifactId: input.artifactId,
      binding,
      title: sanitizeRelativeDisplayPath(input.title),
      originKind: isHistorical ? 'history_snapshot' : input.originKind,
      contentKind: input.contentKind,
      rawText: input.content,
      ...(input.structuredPayload !== undefined ? { structuredPayload: input.structuredPayload } : {}),
      sizeBytes: Buffer.byteLength(input.content, 'utf8'),
      updatedAt: input.updatedAt ?? input.evidence.observedAt ?? this.now(),
      contentDigest: digest,
      revision: nextRevision,
      scope: {
        scopeKind,
        ...(ownerAgentId ? { ownerAgentId } : {}),
        ownerLineage,
        ...(input.activityId ? { activityId: input.activityId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        isHistorical,
        readOnly: true,
      },
      evidence: input.evidence,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    };

    scope.artifactsById.set(input.artifactId, entry);
    if (!isHistorical && input.workflowId &&
        (input.originKind === 'dynamic_script' || input.originKind === 'dynamic_result')) {
      scope.approvedDynamicIds.add(`${input.workflowId}::${input.artifactId}`);
    }

    return this.toSummaryDto(scope, entry);
  }

  registerPendingReviewRequest(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly artifactId: string;
    readonly requestId: string;
    readonly wireSupport: ArtifactReviewWireSupportStatus;
    readonly allowedDecisions?: readonly ('approve' | 'reject' | 'comment')[];
  }): boolean {
    const scope = this.getCurrentScope(input.binding);
    if (!scope || scope.isHistorical || scope.activeConnectionId !== input.connectionId) {
      return false;
    }
    const artifact = scope.artifactsById.get(input.artifactId);
    if (!artifact || artifact.scope.isHistorical) {
      return false;
    }
    const existing = scope.reviewRequestsByArtifactId.get(input.artifactId);
    if (existing?.requestId === input.requestId && existing.connectionId === input.connectionId) return false;
    scope.reviewRequestsByArtifactId.set(input.artifactId, {
      binding: input.binding,
      connectionId: input.connectionId,
      artifactId: input.artifactId,
      artifactRevision: artifact.revision,
      requestId: input.requestId,
      wireSupport: input.wireSupport,
      allowedDecisions: new Set(input.allowedDecisions ?? ['approve', 'reject']),
      settled: false,
    });
    return true;
  }

  private toSummaryDto(scope: BindingArtifactScope, entry: StoredArtifactEntry): ArtifactResourceSummaryDto {
    const req = scope.reviewRequestsByArtifactId.get(entry.artifactId);
    const wireSupport: ArtifactReviewWireSupportStatus =
      req && !req.settled && req.artifactRevision === entry.revision && req.connectionId === scope.activeConnectionId
        ? req.wireSupport
        : this.reviewTransport.getWireSupportStatus(scope.binding, entry.artifactId);

    const actions: ArtifactVerifiedActionKey[] = ['read_artifact'];
    if (entry.originKind === 'acp_plan') actions.push('read_plan');
    if (entry.originKind === 'acp_tool_diff') actions.push('read_diff');
    if (entry.originKind === 'browser_reference') actions.push('read_browser_evidence');

    const canNativeReview =
      this.gates.reviewControlEnabled &&
      !scope.isHistorical &&
      Boolean(scope.activeConnectionId) &&
      Boolean(req) &&
      !req?.settled &&
      !req?.submitting &&
      !entry.scope.isHistorical &&
      req?.artifactRevision === entry.revision &&
      req?.connectionId === scope.activeConnectionId &&
      wireSupport === 'verified_live_wire';

    if (canNativeReview && req) {
      if (req.allowedDecisions.has('comment')) actions.push('submit_native_comment');
      if (req.allowedDecisions.has('approve')) actions.push('submit_native_approval');
      if (req.allowedDecisions.has('reject')) actions.push('submit_native_rejection');
    }

    return ArtifactResourceSummaryDtoSchema.parse({
      artifactId: entry.artifactId,
      title: entry.title,
      originKind: entry.originKind,
      contentKind: entry.contentKind,
      revision: entry.revision,
      sizeBytes: entry.sizeBytes,
      updatedAt: entry.updatedAt,
      scope: {
        ...entry.scope,
        readOnly: !canNativeReview,
      },
      verifiedActionKeys: actions,
      reviewWireSupport: wireSupport,
      ...(canNativeReview && req ? { pendingRequestId: req.requestId } : {}),
      provenance: toPublicEvidenceDto(entry.evidence, this.now()),
    });
  }

  listArtifacts(
    binding: RuntimeBinding,
    filter?: {
      readonly originKind?: ArtifactOriginKind;
      readonly contentKind?: ArtifactContentKind;
      readonly query?: string;
    },
  ): ArtifactResourceSummaryDto[] {
    const scope = this.getCurrentScope(binding);
    if (!scope) return [];

    const q = filter?.query?.trim().toLowerCase() ?? '';
    const list: ArtifactResourceSummaryDto[] = [];
    for (const entry of scope.artifactsById.values()) {
      if (entry.contentKind === 'media_ref' && !this.gates.mediaArtifactsEnabled) {
        continue;
      }
      if (filter?.originKind && entry.originKind !== filter.originKind) continue;
      if (filter?.contentKind && entry.contentKind !== filter.contentKind) continue;
      if (q && !entry.title.toLowerCase().includes(q) && !entry.artifactId.toLowerCase().includes(q)) {
        continue;
      }
      list.push(this.toSummaryDto(scope, entry));
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  readArtifact(
    binding: RuntimeBinding,
    artifactId: string,
    opts?: { readonly pageToken?: string; readonly maxChars?: number },
  ): ArtifactResourceContentDto | null {
    if (!isValidOpaqueArtifactId(artifactId)) return null;
    const scope = this.getCurrentScope(binding);
    if (!scope) return null;

    const entry = scope.artifactsById.get(artifactId);
    if (!entry) return null;
    if (entry.contentKind === 'media_ref' && !this.gates.mediaArtifactsEnabled) {
      return null;
    }

    const redacted = redactSensitiveContent(entry.rawText);
    const maxChars = Math.max(64, Math.min(opts?.maxChars ?? 16_000, 65_536));
    const offset = Math.min(parseOffsetToken(opts?.pageToken), redacted.content.length);
    const slice = redacted.content.slice(offset, offset + maxChars);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < redacted.content.length;
    const summary = this.toSummaryDto(scope, entry);

    return ArtifactResourceContentDtoSchema.parse({
      schemaVersion: AGY_ARTIFACT_SCHEMA_VERSION,
      contractRevision: AGY_ARTIFACT_CONTRACT_REVISION,
      artifactId: entry.artifactId,
      title: summary.title,
      originKind: entry.originKind,
      contentKind: entry.contentKind,
      revision: entry.revision,
      content: slice,
      totalChars: redacted.content.length,
      lineCount: slice ? slice.split(/\r?\n/).length : 0,
      nextPageToken: hasMore ? String(nextOffset) : null,
      hasMore,
      truncated: hasMore || redacted.content.length > slice.length,
      scope: summary.scope,
      security: {
        secretsRedactedCount: redacted.secretsRedactedCount,
        hostPathsRedactedCount: redacted.hostPathsRedactedCount,
        htmlStrippedOrEscaped: redacted.htmlStrippedOrEscaped,
        unsafeLinksBlockedCount: redacted.unsafeLinksBlockedCount,
        binaryRejected: false,
        redactionNotes: [...redacted.redactionNotes],
      },
      verifiedActionKeys: summary.verifiedActionKeys,
      provenance: summary.provenance,
    });
  }

  // ── NP-10 TeamworkArtifactReviewPort Bridge ────────────────────────────

  createTeamworkArtifactReviewPort(): TeamworkArtifactReviewPort {
    return {
      getReviewCapability: (
        binding: RuntimeBinding,
        artifactId: string,
      ): TeamworkArtifactReviewCapability => {
        if (!isValidOpaqueArtifactId(artifactId)) {
          return {
            canRead: false,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'unsupported',
            reasonCode: 'invalid_opaque_artifact_id',
            officialFallbackHint: `请在官方 Antigravity App 或 CLI 中完成审阅 (${AGY_OFFICIAL_DOC_URLS.artifactReview})。`,
          };
        }

        const scope = this.getCurrentScope(binding);
        if (!scope) {
          return {
            canRead: false,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'unknown',
            reasonCode: 'binding_not_registered',
            officialFallbackHint: `当前运行时绑定未就绪；请在官方 Antigravity App 或 CLI 中完成审阅 (${AGY_OFFICIAL_DOC_URLS.artifactReview})。`,
          };
        }

        const artifact = scope.artifactsById.get(artifactId);
        const canRead = Boolean(artifact);
        if (!this.gates.reviewControlEnabled) {
          return {
            canRead,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'upstream_limited',
            reasonCode: 'review_control_gate_disabled',
            officialFallbackHint: `原生审阅控制开关未开启，保持只读预览；请在官方 Antigravity App 或 CLI 中完成批准 (${AGY_OFFICIAL_DOC_URLS.artifactReview})。`,
          };
        }

        if (scope.isHistorical || !scope.activeConnectionId) {
          return {
            canRead,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'unsupported',
            reasonCode: scope.isHistorical ? 'historical_snapshot_readonly' : 'no_live_connection',
            officialFallbackHint: `历史回放或断连状态仅允许只读预览；请在官方 Antigravity App 中操作。`,
          };
        }

        const req = scope.reviewRequestsByArtifactId.get(artifactId);
        if (!artifact || !req || req.settled || req.artifactRevision !== artifact.revision) {
          return {
            canRead,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'upstream_limited',
            reasonCode: 'missing_matching_review_request',
            officialFallbackHint: `未匹配到当前 Artifact 版本的实时审阅请求；请在官方 Antigravity App 中继续。`,
          };
        }

        if (req.wireSupport !== 'verified_live_wire') {
          return {
            canRead,
            canComment: false,
            canApproveViaNativeProtocol: false,
            approveGate: 'upstream_limited',
            reasonCode: 'review_wire_schema_unverified',
            officialFallbackHint: `当前 ACP 尚未实录证实原生评论/批准线格式；请在官方 Antigravity App 或 CLI 中完成批准 (${AGY_OFFICIAL_DOC_URLS.artifactReview})。`,
          };
        }

        return {
          canRead,
          canComment: req.allowedDecisions.has('comment'),
          canApproveViaNativeProtocol:
            req.allowedDecisions.has('approve') && req.allowedDecisions.has('reject'),
          approveGate: 'available',
          reasonCode: 'verified_native_artifact_review_ready',
          officialFallbackHint: `支持通过经验证的原生协议响应审阅请求。`,
        };
      },

      readArtifactSummary: (
        binding: RuntimeBinding,
        artifactId: string,
      ): TeamworkArtifactSummaryRecord | null => {
        if (!isValidOpaqueArtifactId(artifactId)) return null;
        const scope = this.getCurrentScope(binding);
        if (!scope) return null;
        const entry = scope.artifactsById.get(artifactId);
        if (!entry) return null;
        const redacted = redactSensitiveContent(entry.rawText);
        return {
          artifactId: entry.artifactId,
          title: entry.title,
          artifactKind: mapContentKindToTeamworkKind(entry.contentKind),
          revision: entry.revision,
          updatedAt: entry.updatedAt,
          previewExcerpt: redacted.content.slice(0, 1200),
        };
      },

      submitNativeArtifactApproval: async (
        input: TeamworkArtifactApprovalSubmission,
      ): Promise<TeamworkArtifactApprovalSubmissionResult> => {
        if (!isValidOpaqueArtifactId(input.artifactId)) {
          return {
            accepted: false,
            state: 'unsupported',
            reasonCode: 'invalid_opaque_artifact_id',
          };
        }

        const payloadDigest = hashSha256(
          JSON.stringify({
            binding: input.binding,
            artifactId: input.artifactId,
            decision: input.decision,
            requestId: input.requestId ?? null,
          }),
        );
        const receiptKey = `${input.binding.runtimeId}::${input.binding.generation}::${input.idempotencyKey}`;
        const priorReceipt = this.approvalReceipts.get(receiptKey);
        if (priorReceipt) {
          if (priorReceipt.payloadDigest !== payloadDigest) {
            return {
              accepted: false,
              state: 'conflict',
              reasonCode: 'idempotency_key_conflict',
            };
          }
          return priorReceipt.result;
        }

        if (!this.gates.reviewControlEnabled) {
          return {
            accepted: false,
            state: 'unsupported',
            reasonCode: 'review_control_gate_disabled',
          };
        }

        const scope = this.getCurrentScope(input.binding);
        if (!scope || scope.isHistorical || !scope.activeConnectionId) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'stale_binding_or_disconnected',
          };
        }

        const artifact = scope.artifactsById.get(input.artifactId);
        const req = scope.reviewRequestsByArtifactId.get(input.artifactId);
        if (!artifact || artifact.scope.isHistorical || !req) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'artifact_or_request_not_found',
          };
        }
        if (!input.requestId || req.requestId !== input.requestId) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'request_id_mismatch',
          };
        }
        if (req.connectionId !== scope.activeConnectionId || req.artifactRevision !== artifact.revision) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'artifact_revision_or_connection_changed',
          };
        }
        if (req.settled) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'review_request_already_settled',
          };
        }
        if (!req.allowedDecisions.has(input.decision)) {
          return { accepted: false, state: 'unsupported', reasonCode: 'review_decision_not_allowed' };
        }
        if (req.submitting) {
          return { accepted: false, state: 'conflict', reasonCode: 'review_submission_in_flight' };
        }
        if (req.wireSupport !== 'verified_live_wire') {
          return {
            accepted: false,
            state: 'unsupported',
            reasonCode: 'review_wire_schema_unverified',
          };
        }

        const expectedConn = scope.activeConnectionId;
        const expectedRev = artifact.revision;
        req.submitting = true;
        let transportResult: Awaited<ReturnType<NativeArtifactReviewTransportPort['submitReviewAction']>>;
        try {
          transportResult = await this.reviewTransport.submitReviewAction({
            binding: input.binding,
            connectionId: expectedConn,
            artifactId: input.artifactId,
            artifactRevision: expectedRev,
            requestId: req.requestId,
            decision: input.decision,
            idempotencyKey: input.idempotencyKey,
          });
        } catch {
          req.settled = true;
          return { accepted: false, state: 'conflict', reasonCode: 'review_delivery_unknown' };
        } finally {
          req.submitting = false;
        }
        if (transportResult.state === 'response_written') req.settled = true;

        // Async re-verification after await (G3-03 race fence)
        const currentScope = this.getCurrentScope(input.binding);
        const currentArtifact = currentScope?.artifactsById.get(input.artifactId);
        const currentReq = currentScope?.reviewRequestsByArtifactId.get(input.artifactId);
        if (
          !currentScope ||
          currentScope.activeConnectionId !== expectedConn ||
          !currentArtifact ||
          currentArtifact.revision !== expectedRev ||
          currentArtifact.scope.isHistorical ||
          currentReq !== req
        ) {
          return {
            accepted: false,
            state: 'conflict',
            reasonCode: 'binding_or_artifact_changed_during_submit',
          };
        }

        if (transportResult.accepted && transportResult.state === 'response_written') {
          currentReq.settled = true;
          currentReq.decision = input.decision;
          currentReq.receiptId = transportResult.receiptId;
        }

        const finalResult: TeamworkArtifactApprovalSubmissionResult = {
          accepted: transportResult.accepted,
          ...(transportResult.receiptId ? { receiptId: transportResult.receiptId } : {}),
          state: transportResult.state,
          reasonCode: transportResult.reasonCode,
        };
        this.approvalReceipts.set(receiptKey, {
          payloadDigest,
          result: finalResult,
        });
        return finalResult;
      },
    };
  }

  // ── NP-11 DynamicWorkflowArtifactReaderPort Bridge ─────────────────────

  registerApprovedWorkflowScript(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly text: string;
    readonly evidence: Evidence;
    readonly title?: string;
  }): boolean {
    if (!isValidOpaqueArtifactId(input.artifactId)) return false;
    const summary = this.registerObservedArtifact(input.binding, {
      artifactId: input.artifactId,
      title: input.title ?? `${input.artifactId}.py`,
      originKind: 'dynamic_script',
      contentKind: 'script',
      content: input.text,
      workflowId: input.workflowId,
      evidence: input.evidence,
    });
    return Boolean(summary);
  }

  registerApprovedWorkflowResult(input: {
    readonly binding: RuntimeBinding;
    readonly workflowId: WorkflowId;
    readonly artifactId: string;
    readonly payload: unknown;
    readonly evidence: Evidence;
    readonly title?: string;
  }): boolean {
    if (!isValidOpaqueArtifactId(input.artifactId)) return false;
    const rawText =
      typeof input.payload === 'string'
        ? input.payload
        : JSON.stringify(input.payload, null, 2) ?? 'null';
    const summary = this.registerObservedArtifact(input.binding, {
      artifactId: input.artifactId,
      title: input.title ?? `${input.artifactId}.json`,
      originKind: 'dynamic_result',
      contentKind: 'json',
      content: rawText,
      structuredPayload: input.payload,
      workflowId: input.workflowId,
      evidence: input.evidence,
    });
    return Boolean(summary);
  }

  createDynamicWorkflowArtifactReaderPort(): DynamicWorkflowArtifactReaderPort {
    return {
      contractRevision: DYNAMIC_ARTIFACT_PORT_REVISION,

      isApprovedArtifactId: (
        binding: RuntimeBinding,
        workflowId: WorkflowId,
        artifactId: string,
      ): boolean => {
        if (!isValidOpaqueArtifactId(artifactId)) return false;
        const scope = this.getCurrentScope(binding);
        if (!scope) return false;
        const entry = scope.artifactsById.get(artifactId);
        return Boolean(
          entry &&
            entry.workflowId === workflowId &&
            scope.approvedDynamicIds.has(`${workflowId}::${artifactId}`),
        );
      },

      readScriptPreview: (input): DynamicArtifactTextPageResult => {
        if (!isValidOpaqueArtifactId(input.artifactId)) {
          return {
            ok: false,
            errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
            message: 'Rejected non-opaque or path-like artifact identifier',
          };
        }
        const scope = this.getCurrentScope(input.binding);
        if (!scope) {
          return {
            ok: false,
            errorCode: 'BINDING_MISMATCH',
            message: 'Binding generation is not active in artifact store',
          };
        }
        const entry = scope.artifactsById.get(input.artifactId);
        if (
          !entry ||
          entry.workflowId !== input.workflowId ||
          entry.originKind !== 'dynamic_script' ||
          !scope.approvedDynamicIds.has(`${input.workflowId}::${input.artifactId}`)
        ) {
          return {
            ok: false,
            errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
            message: `Script artifact "${input.artifactId}" is not approved in this workflow scope`,
          };
        }

        const redacted = redactSensitiveContent(entry.rawText);
        const maxChars = Math.max(64, Math.min(input.maxChars ?? 4000, 16_000));
        const offset = Math.min(parseOffsetToken(input.pageToken), redacted.content.length);
        const slice = redacted.content.slice(offset, offset + maxChars);
        const nextOffset = offset + slice.length;
        const hasMore = nextOffset < redacted.content.length;
        const provenance: PublicEvidenceDto = toPublicEvidenceDto(entry.evidence, this.now());

        return {
          ok: true,
          artifactId: entry.artifactId,
          content: slice,
          totalChars: redacted.content.length,
          nextPageToken: hasMore ? String(nextOffset) : null,
          hasMore,
          truncated: hasMore,
          provenance,
        };
      },

      readStructuredResult: (input): DynamicStructuredResultPageResult => {
        if (!isValidOpaqueArtifactId(input.artifactId)) {
          return {
            ok: false,
            errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
            message: 'Rejected non-opaque or path-like artifact identifier',
          };
        }
        const scope = this.getCurrentScope(input.binding);
        if (!scope) {
          return {
            ok: false,
            errorCode: 'BINDING_MISMATCH',
            message: 'Binding generation is not active in artifact store',
          };
        }
        const entry = scope.artifactsById.get(input.artifactId);
        if (
          !entry ||
          entry.workflowId !== input.workflowId ||
          entry.originKind !== 'dynamic_result' ||
          !scope.approvedDynamicIds.has(`${input.workflowId}::${input.artifactId}`)
        ) {
          return {
            ok: false,
            errorCode: 'UNAPPROVED_ARTIFACT_SCOPE',
            message: `Result artifact "${input.artifactId}" is not approved in this workflow scope`,
          };
        }

        const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
        const offset = parseOffsetToken(input.pageToken);
        const provenance: PublicEvidenceDto = toPublicEvidenceDto(entry.evidence, this.now());
        const payload = entry.structuredPayload;

        const sanitizeItem = (item: unknown): unknown => {
          if (typeof item === 'string') return redactSensitiveContent(item).content;
          if (item && typeof item === 'object') {
            try {
              const serialized = JSON.stringify(item);
              const redacted = redactSensitiveContent(serialized);
              return JSON.parse(redacted.content) as unknown;
            } catch {
              return '[unserializable_item]';
            }
          }
          return item;
        };

        if (Array.isArray(payload)) {
          const sliced = payload.slice(offset, offset + limit).map(sanitizeItem);
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
            provenance,
          };
        }

        if (payload && typeof payload === 'object') {
          const entries = Object.entries(payload as Record<string, unknown>);
          const sliced = entries.slice(offset, offset + limit).map(([key, value]) => ({
            key,
            value: sanitizeItem(value),
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
            provenance,
          };
        }

        return {
          ok: true,
          artifactId: entry.artifactId,
          format: typeof payload === 'string' ? 'text' : 'scalar',
          items: offset === 0 ? [sanitizeItem(payload)] : [],
          totalItems: 1,
          nextPageToken: null,
          hasMore: false,
          provenance,
        };
      },
    };
  }
}
