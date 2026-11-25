import crypto from 'node:crypto';
import {
  toPublicEvidenceDto,
  type AgentLineage,
  type Evidence,
  type NativeAgentId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { asNativeAgentId } from '@harnessmate/protocol';
import type { ChildScopeResolverPort } from '../child/contracts.js';
import type { NativeIngress } from '../wiring/types.js';
import {
  AGY_ARTIFACT_SCHEMA_VERSION,
  AGY_OFFICIAL_DOC_URLS,
  AgyPlanSnapshotDtoSchema,
  AgyToolDiffEntryDtoSchema,
  BrowserAgentObservationDtoSchema,
  type AgyPlanSnapshotDto,
  type AgyPlanStepDto,
  type AgyToolDiffEntryDto,
  type BrowserAgentObservationDto,
  type BrowserAgentRoleDto,
  type BrowserLogEntryDto,
  type BrowserMediaReferenceDto,
  type BrowserRuntimeSurfaceKind,
} from './contracts.js';
import {
  inspectManagedMediaReferenceSync,
  redactSensitiveContent,
  sanitizeRelativeDisplayPath,
} from './redaction.js';

const MAX_TOOL_DIFF_CHARS = 32_000;
const MAX_BROWSER_LOGS = 200;

interface BindingObservationState {
  readonly binding: RuntimeBinding;
  activeConnectionId: string | null;
  rootNativeSessionId: string | null;
  profileRef?: string;
  sourceRef?: string;
  appDataPath?: string;
  readonly seenIngressKeys: Set<string>;
  planModeActive: boolean;
  planEnforcement: 'native' | 'client_guard' | 'unknown';
  planSteps: AgyPlanStepDto[];
  planRevision: number;
  planUpdatedAt: number;
  planEvidence?: Evidence;
  planIsHistorical: boolean;
  readonly diffsById: Map<string, AgyToolDiffEntryDto>;
  browserSurface: BrowserRuntimeSurfaceKind;
  browserSurfaceReason: string;
  readonly browserRolesById: Map<string, BrowserAgentRoleDto>;
  readonly browserLogs: BrowserLogEntryDto[];
  browserLogSeq: number;
  browserDroppedLogCount: number;
  readonly browserMediaById: Map<string, BrowserMediaReferenceDto>;
  browserRevision: number;
  browserUpdatedAt: number;
  browserIsHistorical: boolean;
}

export interface AgyPlanDiffBrowserObserverOptions {
  readonly mediaArtifactsEnabled?: boolean;
  readonly childScopeResolver?: ChildScopeResolverPort;
  readonly now?: () => number;
}

function bindingGenKey(binding: RuntimeBinding): string {
  return `${binding.runtimeId}::${binding.sessionId}::${binding.instanceId}::${binding.generation}`;
}

function makeShortId(prefix: string, seed: string): string {
  return `${prefix}_${crypto.createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 12)}`;
}

function buildEnvelopeEvidence(envelope: NativeIngress, wireVariant: string, nowMs: number): Evidence {
  if (envelope.channel === 'history_replay') {
    return {
      kind: 'replay',
      captureId: `replay_${envelope.connectionId}`,
      ordinal: Math.max(0, envelope.ingressOrdinal),
      observedAt: nowMs,
    };
  }
  return {
    kind: 'live_protocol',
    connectionId: envelope.connectionId,
    ingressOrdinal: Math.max(0, envelope.ingressOrdinal),
    wireVariant,
    observedAt: nowMs,
  };
}

function mapStepStatus(raw: unknown): AgyPlanStepDto['status'] {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'pending' || s === 'queued') return 'pending';
  if (s === 'in_progress' || s === 'running' || s === 'active') return 'in_progress';
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'unknown';
}

function formatSimpleOldNewDiff(filePath: string, oldText: string, newText: string): string {
  const oldLines = oldText.split(/\r?\n/).map((l) => `-${l}`);
  const newLines = newText.split(/\r?\n/).map((l) => `+${l}`);
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines,
    ...newLines,
  ].join('\n');
}

function extractHostForBrowserLog(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.host.slice(0, 120);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Observes NP-14 Plan (`AGY-W13`), ACP Tool Diffs (`AGY-W15`), and Browser Agent (`AGY-W16`)
 * while enforcing strict separation from AGY Artifact Review (`AGY-W14`), generation/connection
 * fencing, history replay isolation, and App-embedded vs Chrome MCP surface boundaries.
 */
export class AgyPlanDiffBrowserObserver {
  private mediaArtifactsEnabled: boolean;
  private readonly childScopeResolver?: ChildScopeResolverPort;
  private readonly now: () => number;
  private readonly statesByGenKey = new Map<string, BindingObservationState>();

  constructor(options: AgyPlanDiffBrowserObserverOptions = {}) {
    this.mediaArtifactsEnabled = options.mediaArtifactsEnabled ?? false;
    this.childScopeResolver = options.childScopeResolver;
    this.now = options.now ?? (() => Date.now());
  }

  setMediaArtifactsEnabled(enabled: boolean): void {
    this.mediaArtifactsEnabled = enabled;
  }

  isMediaArtifactsEnabled(): boolean {
    return this.mediaArtifactsEnabled;
  }

  private ensureState(binding: RuntimeBinding): BindingObservationState {
    const key = bindingGenKey(binding);
    const existing = this.statesByGenKey.get(key);
    if (existing) return existing;
    const created: BindingObservationState = {
      binding,
      activeConnectionId: null,
      rootNativeSessionId: null,
      seenIngressKeys: new Set(),
      planModeActive: false,
      planEnforcement: 'unknown',
      planSteps: [],
      planRevision: 0,
      planUpdatedAt: this.now(),
      planIsHistorical: false,
      diffsById: new Map(),
      browserSurface: 'unknown',
      browserSurfaceReason: 'browser_surface_not_observed',
      browserRolesById: new Map(),
      browserLogs: [],
      browserLogSeq: 1,
      browserDroppedLogCount: 0,
      browserMediaById: new Map(),
      browserRevision: 0,
      browserUpdatedAt: this.now(),
      browserIsHistorical: false,
    };
    this.statesByGenKey.set(key, created);
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
    const state = this.ensureState(binding);
    state.activeConnectionId = opts.connectionId;
    state.rootNativeSessionId = opts.rootNativeSessionId;
    state.profileRef = opts.profileRef ?? state.profileRef;
    state.sourceRef = opts.sourceRef ?? state.sourceRef;
    state.appDataPath = opts.appDataPath ?? state.appDataPath;
  }

  handleTransportClosed(binding: RuntimeBinding, connectionId: string): void {
    const state = this.statesByGenKey.get(bindingGenKey(binding));
    if (!state || state.activeConnectionId !== connectionId) return;
    state.activeConnectionId = null;
  }

  acceptFrame(envelope: NativeIngress): {
    readonly accepted: boolean;
    readonly kind: 'plan' | 'diff' | 'browser' | 'ignored';
    readonly reasonCode: string;
  } {
    if (envelope.channel !== 'live') {
      return { accepted: false, kind: 'ignored', reasonCode: 'history_replay_isolated' };
    }
    return this.applyEnvelopeInternal(envelope, false);
  }

  /**
   * Reads historical replay frames into an isolated read-only snapshot binding.
   * Never mutates an active live connection binding.
   */
  ingestHistoricalReplay(envelope: NativeIngress): {
    readonly accepted: boolean;
    readonly kind: 'plan' | 'diff' | 'browser' | 'ignored';
    readonly reasonCode: string;
  } {
    const state = this.ensureState(envelope.binding);
    if (state.activeConnectionId) {
      return { accepted: false, kind: 'ignored', reasonCode: 'cannot_mix_history_into_live_binding' };
    }
    return this.applyEnvelopeInternal(envelope, true);
  }

  private applyEnvelopeInternal(
    envelope: NativeIngress,
    isReplay: boolean,
  ): {
    readonly accepted: boolean;
    readonly kind: 'plan' | 'diff' | 'browser' | 'ignored';
    readonly reasonCode: string;
  } {
    const state = this.ensureState(envelope.binding);
    if (!isReplay && (!state.activeConnectionId || state.activeConnectionId !== envelope.connectionId)) {
      return { accepted: false, kind: 'ignored', reasonCode: 'stale_connection_or_generation' };
    }

    const wire = envelope.wire as { method?: unknown; params?: Record<string, unknown> } | null;
    if (!wire || wire.method !== 'session/update' || !wire.params || typeof wire.params !== 'object') {
      return { accepted: false, kind: 'ignored', reasonCode: 'not_session_update' };
    }

    const dedupKey = `${envelope.channel}::${envelope.connectionId}::${envelope.ingressOrdinal}`;
    if (state.seenIngressKeys.has(dedupKey)) {
      return { accepted: false, kind: 'ignored', reasonCode: 'duplicate_ingress' };
    }
    state.seenIngressKeys.add(dedupKey);

    const update =
      wire.params.update && typeof wire.params.update === 'object'
        ? (wire.params.update as Record<string, unknown>)
        : wire.params;
    const sessionUpdate = String(update.sessionUpdate ?? update.type ?? '');
    const nowMs = this.now();

    // 1. Plan mode updates (`current_mode_update` / `config_option_update`)
    if (sessionUpdate === 'current_mode_update' || sessionUpdate === 'config_option_update') {
      const modeVal = String(update.currentModeId ?? update.modeId ?? update.value ?? '').trim();
      const optionId = String(update.configId ?? update.id ?? '').trim();
      if (sessionUpdate === 'current_mode_update' || optionId === 'mode') {
        if (modeVal === 'plan') {
          state.planModeActive = true;
          state.planEnforcement = 'native';
          state.planIsHistorical = isReplay;
          state.planRevision += 1;
          state.planUpdatedAt = nowMs;
          state.planEvidence = buildEnvelopeEvidence(envelope, sessionUpdate, nowMs);
          return { accepted: true, kind: 'plan', reasonCode: 'plan_mode_entered' };
        }
        if (modeVal === 'default' || modeVal === 'accept-edits' || modeVal === 'manual' || modeVal === 'auto') {
          state.planModeActive = false;
          state.planEnforcement = 'native';
          state.planIsHistorical = isReplay;
          state.planRevision += 1;
          state.planUpdatedAt = nowMs;
          state.planEvidence = buildEnvelopeEvidence(envelope, sessionUpdate, nowMs);
          return { accepted: true, kind: 'plan', reasonCode: 'plan_mode_exited' };
        }
      }
    }

    // 2. Standard ACP Plan (`sessionUpdate === 'plan'`)
    if (sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      const steps: AgyPlanStepDto[] = update.entries
        .map((raw, idx): AgyPlanStepDto | null => {
          if (!raw || typeof raw !== 'object') return null;
          const rec = raw as Record<string, unknown>;
          const title = redactSensitiveContent(String(rec.content ?? rec.title ?? '').trim()).content;
          if (!title) return null;
          const prio = String(rec.priority ?? '').toLowerCase();
          return {
            id: `acp_plan_${idx + 1}`,
            title: title.slice(0, 380),
            status: mapStepStatus(rec.status),
            ...(prio === 'high' || prio === 'medium' || prio === 'low' ? { priority: prio as 'high' | 'medium' | 'low' } : {}),
            source: 'acp_agent_plan',
          };
        })
        .filter((s): s is AgyPlanStepDto => s !== null);

      state.planSteps = steps;
      state.planIsHistorical = isReplay;
      state.planRevision += 1;
      state.planUpdatedAt = nowMs;
      state.planEvidence = buildEnvelopeEvidence(envelope, 'acp_plan', nowMs);
      return { accepted: true, kind: 'plan', reasonCode: 'acp_plan_updated' };
    }

    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
      return { accepted: false, kind: 'ignored', reasonCode: 'unhandled_session_update' };
    }

    const title = String(update.title ?? '').trim();
    const toolName = String(update.toolName ?? '').trim();
    const toolCallId = String(update.toolCallId ?? `tc_${envelope.ingressOrdinal}`);
    const rawInput =
      update.rawInput && typeof update.rawInput === 'object'
        ? (update.rawInput as Record<string, unknown>)
        : {};
    const rawOutput =
      update.rawOutput && typeof update.rawOutput === 'object'
        ? (update.rawOutput as Record<string, unknown>)
        : {};

    // 3. AGY `update_steps` Plan tool call
    if (title === 'Run update_steps' || title === 'update_steps' || toolName === 'update_steps') {
      const rawSteps = Array.isArray(rawInput.steps) ? rawInput.steps : [];
      const steps: AgyPlanStepDto[] = rawSteps
        .map((raw, idx): AgyPlanStepDto | null => {
          if (!raw || typeof raw !== 'object') return null;
          const rec = raw as Record<string, unknown>;
          const stepTitle = redactSensitiveContent(String(rec.title ?? '').trim()).content;
          if (!stepTitle) return null;
          return {
            id: `agy_step_${idx + 1}`,
            title: stepTitle.slice(0, 380),
            status: mapStepStatus(rec.status),
            source: 'agy_update_steps',
          };
        })
        .filter((s): s is AgyPlanStepDto => s !== null);

      state.planSteps = steps;
      state.planIsHistorical = isReplay;
      state.planRevision += 1;
      state.planUpdatedAt = nowMs;
      state.planEvidence = buildEnvelopeEvidence(envelope, 'agy_update_steps', nowMs);
      return { accepted: true, kind: 'plan', reasonCode: 'agy_update_steps_updated' };
    }

    // 4. ACP Tool Diffs (`content` items with `type === 'diff'` or `rawOutput.unifiedDiff`)
    const diffCandidate = this.extractToolDiff(update, rawInput, rawOutput);
    if (diffCandidate) {
      const evidence = buildEnvelopeEvidence(envelope, 'acp_tool_diff', nowMs);
      const owner = this.resolveOwnerAttribution(state, envelope, update, toolCallId);
      const diffId = makeShortId('diff', `${toolCallId}:${diffCandidate.filePath}`);
      const existing = state.diffsById.get(diffId);
      const redactedDiff = redactSensitiveContent(diffCandidate.unifiedDiff);
      const truncated = redactedDiff.content.length > MAX_TOOL_DIFF_CHARS;

      const entry = AgyToolDiffEntryDtoSchema.parse({
        diffId,
        toolCallId,
        relativeDisplayPath: diffCandidate.filePath,
        unifiedDiff: redactedDiff.content.slice(0, MAX_TOOL_DIFF_CHARS),
        truncated,
        origin: 'acp_tool_diff',
        ...(owner.agentId ? { ownerAgentId: owner.agentId } : {}),
        ownerLineage: owner.lineage,
        approvalState:
          update.status === 'completed'
            ? 'approved'
            : update.status === 'failed' || update.status === 'cancelled'
              ? 'rejected'
              : 'not_requested',
        revision: existing ? existing.revision + 1 : 1,
        isHistorical: isReplay,
        updatedAt: nowMs,
        provenance: toPublicEvidenceDto(evidence, nowMs),
      });
      state.diffsById.set(diffId, entry);
      return { accepted: true, kind: 'diff', reasonCode: 'acp_tool_diff_recorded' };
    }

    // 5. Browser Agent & Chrome MCP Observation (`AGY-W16`)
    const browserSignal = this.detectBrowserSignal(title, toolName, rawInput, rawOutput);
    if (browserSignal) {
      const evidence = buildEnvelopeEvidence(envelope, 'browser_agent', nowMs);
      const pubEvidence = toPublicEvidenceDto(evidence, nowMs);
      const owner = this.resolveOwnerAttribution(state, envelope, update, toolCallId);

      state.browserSurface = browserSignal.surface;
      state.browserSurfaceReason = browserSignal.surfaceReasonCode;
      state.browserIsHistorical = isReplay;
      state.browserRevision += 1;
      state.browserUpdatedAt = nowMs;

      const roleId = makeShortId('br_role', `${browserSignal.surface}:${owner.agentId ?? toolCallId}`);
      const roleState =
        update.status === 'completed'
          ? 'finished'
          : update.status === 'failed'
            ? 'failed'
            : update.status === 'cancelled'
              ? 'cancelled'
              : 'running';

      state.browserRolesById.set(roleId, {
        roleId,
        ...(owner.agentId ? { agentId: owner.agentId } : {}),
        lineage: owner.lineage,
        label: browserSignal.roleLabel,
        surface: browserSignal.surface,
        state: roleState,
        canControlBrowser: false,
        provenance: pubEvidence,
      });

      const targetHost = browserSignal.targetUrl ? extractHostForBrowserLog(browserSignal.targetUrl) : undefined;
      const logEntry: BrowserLogEntryDto = {
        seq: state.browserLogSeq++,
        timestamp: nowMs,
        surface: browserSignal.surface,
        actionSummary: redactSensitiveContent(browserSignal.actionSummary).content.slice(0, 300),
        ...(targetHost ? { redactedTargetHost: targetHost } : {}),
        status:
          update.status === 'completed'
            ? 'completed'
            : update.status === 'failed' || update.status === 'cancelled'
              ? 'failed'
              : 'running',
        provenance: pubEvidence,
      };
      state.browserLogs.push(logEntry);
      if (state.browserLogs.length > MAX_BROWSER_LOGS) {
        state.browserLogs.splice(0, state.browserLogs.length - MAX_BROWSER_LOGS);
        state.browserDroppedLogCount += 1;
      }

      if (browserSignal.mediaFileName && state.appDataPath && state.rootNativeSessionId) {
        const inspected = inspectManagedMediaReferenceSync(
          state.appDataPath,
          state.rootNativeSessionId,
          browserSignal.mediaFileName,
        );
        if (inspected) {
          const mediaId = makeShortId('br_media', inspected.name);
          state.browserMediaById.set(mediaId, {
            mediaId,
            label: sanitizeRelativeDisplayPath(inspected.name),
            mediaKind: inspected.mimeType.startsWith('video/') ? 'recording' : 'screenshot',
            mimeType: inspected.mimeType,
            sizeBytes: inspected.sizeBytes,
            magicVerified: inspected.magicVerified,
            sha256Prefix: inspected.sha256Prefix,
            gatedOff: !this.mediaArtifactsEnabled,
            updatedAt: inspected.updatedAt,
            provenance: pubEvidence,
          });
        }
      } else if (browserSignal.mediaMeta && browserSignal.mediaMeta.mimeType) {
        const mediaId = makeShortId('br_media', browserSignal.mediaMeta.label);
        state.browserMediaById.set(mediaId, {
          mediaId,
          label: sanitizeRelativeDisplayPath(browserSignal.mediaMeta.label),
          mediaKind: browserSignal.mediaMeta.mimeType.startsWith('video/') ? 'recording' : 'screenshot',
          mimeType: browserSignal.mediaMeta.mimeType,
          sizeBytes: browserSignal.mediaMeta.sizeBytes,
          magicVerified: browserSignal.mediaMeta.magicVerified,
          sha256Prefix: browserSignal.mediaMeta.sha256Prefix,
          gatedOff: !this.mediaArtifactsEnabled,
          updatedAt: nowMs,
          provenance: pubEvidence,
        });
      }

      return { accepted: true, kind: 'browser', reasonCode: browserSignal.surfaceReasonCode };
    }

    return { accepted: false, kind: 'ignored', reasonCode: 'non_np14_tool_call' };
  }

  private resolveOwnerAttribution(
    state: BindingObservationState,
    envelope: NativeIngress,
    update: Record<string, unknown>,
    toolCallId: string,
  ): { readonly agentId?: NativeAgentId; readonly lineage: AgentLineage } {
    const wireParams = (envelope.wire as { params?: Record<string, unknown> })?.params ?? {};
    const wireSessionId = typeof wireParams.sessionId === 'string' ? wireParams.sessionId : '';
    const childHint =
      typeof update.childSessionId === 'string'
        ? update.childSessionId
        : typeof update.subagentSessionId === 'string'
          ? update.subagentSessionId
          : undefined;

    if (
      this.childScopeResolver &&
      state.rootNativeSessionId &&
      state.profileRef &&
      wireSessionId
    ) {
      const res = this.childScopeResolver.resolveScope({
        binding: state.binding,
        wireSessionId,
        rootNativeSessionId: state.rootNativeSessionId,
        toolCallId,
        wireChildSessionId: childHint,
        profileRef: state.profileRef,
        sourceRef: state.sourceRef,
        connectionId: state.activeConnectionId ?? undefined,
      });
      return {
        agentId: res.allowConfirmedChildAttribution ? res.displayOwnerAgentId : undefined,
        lineage: res.lineage,
      };
    }

    if (typeof update.confirmedAgentId === 'string' && update.confirmedAgentId.trim()) {
      try {
        return {
          agentId: asNativeAgentId(update.confirmedAgentId.trim()),
          lineage: 'confirmed',
        };
      } catch {
        return { lineage: 'unresolved' };
      }
    }

    return { lineage: childHint ? 'unresolved' : 'confirmed' };
  }

  private extractToolDiff(
    update: Record<string, unknown>,
    rawInput: Record<string, unknown>,
    rawOutput: Record<string, unknown>,
  ): { readonly filePath: string; readonly unifiedDiff: string } | null {
    if (Array.isArray(update.content)) {
      for (const item of update.content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        if (rec.type === 'diff') {
          const filePath = sanitizeRelativeDisplayPath(String(rec.path ?? rec.filePath ?? 'changed-file'));
          if (typeof rec.unifiedDiff === 'string' && rec.unifiedDiff.trim()) {
            return { filePath, unifiedDiff: rec.unifiedDiff };
          }
          if (typeof rec.oldText === 'string' || typeof rec.newText === 'string') {
            return {
              filePath,
              unifiedDiff: formatSimpleOldNewDiff(
                filePath,
                String(rec.oldText ?? ''),
                String(rec.newText ?? ''),
              ),
            };
          }
        }
      }
    }
    if (typeof rawOutput.unifiedDiff === 'string' && rawOutput.unifiedDiff.trim()) {
      return {
        filePath: sanitizeRelativeDisplayPath(String(rawOutput.path ?? rawInput.path ?? 'changed-file')),
        unifiedDiff: rawOutput.unifiedDiff,
      };
    }
    return null;
  }

  private detectBrowserSignal(
    title: string,
    toolName: string,
    rawInput: Record<string, unknown>,
    rawOutput: Record<string, unknown>,
  ): {
    readonly surface: BrowserRuntimeSurfaceKind;
    readonly surfaceReasonCode: string;
    readonly roleLabel: string;
    readonly actionSummary: string;
    readonly targetUrl?: string;
    readonly mediaFileName?: string;
    readonly mediaMeta?: {
      readonly label: string;
      readonly mimeType: BrowserMediaReferenceDto['mimeType'] | null;
      readonly sizeBytes: number;
      readonly magicVerified: boolean;
      readonly sha256Prefix: string;
    };
  } | null {
    const typeName = String(rawInput.TypeName ?? rawInput.typeName ?? '').toLowerCase();
    const role = String(rawInput.Role ?? rawInput.role ?? '').trim();
    const combined = `${title} ${toolName}`.toLowerCase();

    const isChromeMcp =
      combined.includes('chrome_devtools') ||
      combined.includes('mcp__chrome') ||
      combined.includes('chrome-devtools') ||
      rawInput.chromeMcp === true ||
      rawOutput.browserSurface === 'cli_chrome_mcp' ||
      rawOutput.browserSurface === 'enterprise_chrome_mcp';

    const isEmbeddedBrowser =
      rawOutput.browserSurface === 'app_embedded_browser' ||
      combined.includes('embedded_browser') ||
      typeName === 'browser' ||
      combined.includes('browser_subagent') ||
      /\/browser\b/i.test(title);

    if (!isChromeMcp && !isEmbeddedBrowser) return null;

    let surface: BrowserRuntimeSurfaceKind = 'unknown';
    let surfaceReasonCode = 'browser_surface_unverified';
    if (rawOutput.browserSurface === 'enterprise_chrome_mcp' || rawInput.enterprisePolicy === true) {
      surface = 'enterprise_chrome_mcp';
      surfaceReasonCode = 'enterprise_chrome_mcp_observed';
    } else if (isChromeMcp) {
      surface = 'cli_chrome_mcp';
      surfaceReasonCode = 'cli_chrome_mcp_observed';
    } else if (isEmbeddedBrowser) {
      surface = 'app_embedded_browser';
      surfaceReasonCode = 'app_embedded_browser_read_only';
    }

    const targetUrl =
      typeof rawInput.url === 'string'
        ? rawInput.url
        : typeof rawInput.Url === 'string'
          ? rawInput.Url
          : undefined;
    const actionSummary =
      typeof rawOutput.summary === 'string' && rawOutput.summary.trim()
        ? rawOutput.summary.trim()
        : `${title || toolName || 'browser_action'}`;

    const mediaFileName =
      typeof rawOutput.screenshotFile === 'string'
        ? rawOutput.screenshotFile
        : typeof rawOutput.recordingFile === 'string'
          ? rawOutput.recordingFile
          : undefined;

    const rawMime = typeof rawOutput.mimeType === 'string' ? rawOutput.mimeType.toLowerCase() : '';
    const allowedMime: BrowserMediaReferenceDto['mimeType'] | null =
      rawMime === 'image/png' ||
      rawMime === 'image/jpeg' ||
      rawMime === 'image/webp' ||
      rawMime === 'video/webm' ||
      rawMime === 'video/mp4'
        ? rawMime
        : null;

    const mediaMeta =
      !mediaFileName && typeof rawOutput.mediaLabel === 'string' && allowedMime
        ? {
            label: rawOutput.mediaLabel,
            mimeType: allowedMime,
            sizeBytes: typeof rawOutput.sizeBytes === 'number' ? Math.max(0, Math.floor(rawOutput.sizeBytes)) : 0,
            magicVerified: rawOutput.magicVerified === true,
            sha256Prefix:
              typeof rawOutput.sha256Prefix === 'string' && rawOutput.sha256Prefix.length >= 8
                ? rawOutput.sha256Prefix.slice(0, 32)
                : makeShortId('sha', rawOutput.mediaLabel),
          }
        : undefined;

    return {
      surface,
      surfaceReasonCode,
      roleLabel: role || (isChromeMcp ? 'Chrome MCP Tool' : 'AGY Browser Agent'),
      actionSummary,
      targetUrl,
      mediaFileName,
      mediaMeta,
    };
  }

  getPlanSnapshot(binding: RuntimeBinding): AgyPlanSnapshotDto {
    const state = this.statesByGenKey.get(bindingGenKey(binding));
    const nowMs = this.now();
    return AgyPlanSnapshotDtoSchema.parse({
      schemaVersion: AGY_ARTIFACT_SCHEMA_VERSION,
      binding,
      planModeActive: state?.planModeActive ?? false,
      enforcement: state?.planEnforcement ?? 'unknown',
      steps: state?.planSteps ?? [],
      revision: state?.planRevision ?? 0,
      isHistorical: state?.planIsHistorical ?? false,
      updatedAt: state?.planUpdatedAt ?? nowMs,
      ...(state?.planEvidence ? { provenance: toPublicEvidenceDto(state.planEvidence, nowMs) } : {}),
    });
  }

  listToolDiffs(binding: RuntimeBinding): AgyToolDiffEntryDto[] {
    const state = this.statesByGenKey.get(bindingGenKey(binding));
    if (!state) return [];
    return [...state.diffsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getBrowserObservation(binding: RuntimeBinding): BrowserAgentObservationDto {
    const state = this.statesByGenKey.get(bindingGenKey(binding));
    const nowMs = this.now();
    const mediaList = [...(state?.browserMediaById.values() ?? [])].map((m) => ({
      ...m,
      gatedOff: !this.mediaArtifactsEnabled,
    }));

    return BrowserAgentObservationDtoSchema.parse({
      schemaVersion: AGY_ARTIFACT_SCHEMA_VERSION,
      binding,
      surface: state?.browserSurface ?? 'unknown',
      controlSupported: false,
      surfaceReasonCode: state?.browserSurfaceReason ?? 'browser_surface_not_observed',
      officialAppGuide: `Antigravity App 内嵌浏览器交互属 App-only 能力 (${AGY_OFFICIAL_DOC_URLS.browser})；Chrome MCP 仅以受审工具执行。`,
      roles: [...(state?.browserRolesById.values() ?? [])],
      logs: [...(state?.browserLogs ?? [])],
      droppedLogCount: state?.browserDroppedLogCount ?? 0,
      mediaReferences: this.mediaArtifactsEnabled ? mediaList : [],
      mediaGateEnabled: this.mediaArtifactsEnabled,
      isHistorical: state?.browserIsHistorical ?? false,
      revision: state?.browserRevision ?? 0,
      updatedAt: state?.browserUpdatedAt ?? nowMs,
    });
  }
}
