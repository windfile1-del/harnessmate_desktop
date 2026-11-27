import crypto from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CanonicalEvent,
  Session,
  TerminalContextChip,
} from '@harnessmate/protocol';
import { PluginApiError } from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../db/sqlite.js';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import {
  assertAgyConsumerProvenance,
  type AgyDispatchProvenance,
} from '../harnesses/agy/native/wiring/provenance.js';
import type { AgyNativeRuntimeRegistry } from '../harnesses/agy/native/wiring/registry.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { AdapterSessionConfig, HarnessAdapter } from '../harnesses/types.js';
import {
  failoverContract,
  modelToolsContract,
  selectedHarnessService,
  type FailoverContract,
  type ModelToolRouter,
} from '../plugin-host/builtin/harness-integration.js';
import { sessionPluginEvent } from '../plugin-host/runtime/events.js';
import { pluginDevelopmentBrief } from '../plugins/plugin-development-prompt.js';
import type { PluginCapabilities, PluginToolLease } from '../plugins/plugin-capabilities.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { ApprovalCenterService } from './approval-center-service.js';
import type { ContextCompiler } from './context-compiler.js';
import type { DaemonEventBus } from './event-bus.js';
import { ORCHESTRATOR_PLUGIN_ID, type OrchestratorService } from './orchestrator-service.js';
import { stripAnsiAndClip } from './terminal-workspace-service.js';
import type {
  CollaborationBridgePort,
  NativeRuntimePort,
  RuntimeDriverPort,
  RuntimeRequestPort,
} from './runtime-ports.js';
import type { TaskLedgerService } from './task-ledger-service.js';
import { resolveDriverForScope } from './driver-peer-router.js';
import {
  resolveOptionalSessionHandoffProvider,
  resolveOptionalSessionOrchestrationProvider,
} from './collaboration-peer-router.js';
import { resolveGitCheckpointProvider, unwrapPeerServiceResult } from './w1-service-helpers.js';

export interface HostRuntimePortDeps {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  eventBus: DaemonEventBus;
  getPluginManager: () => PluginManager;
  getPluginCapabilities?: () => PluginCapabilities | undefined;
  getNativeRegistry?: () => AgyNativeRuntimeRegistry | undefined;
  getApprovalCenter?: () => ApprovalCenterService;
  getOrchestrator?: () => OrchestratorService | undefined;
  onAnnotatePendingApproval?: (session: Session, approval: ApprovalRequest) => Promise<void>;
  onAttachCompressorHooks?: () => void;
}

export function createHostRuntimePorts(deps: HostRuntimePortDeps): {
  driverPort: RuntimeDriverPort;
  nativePort: NativeRuntimePort;
  requestPort: RuntimeRequestPort;
  collabPort: CollaborationBridgePort;
} {
  const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearApprovalTimer = (id: string) => {
    const t = approvalTimers.get(id);
    if (t) {
      clearTimeout(t);
      approvalTimers.delete(id);
    }
  };

  const driverPort: RuntimeDriverPort = {
    getAdapter(harnessId, scope) {
      try {
        return resolveDriverForScope(deps.getPluginManager(), deps.registry, {
          harnessId,
          sessionId: scope?.sessionId,
          workspaceId: scope?.workspaceId,
          driverProviderInstanceId: scope?.driverProviderInstanceId,
          store: deps.store,
        }).adapter;
      } catch (err) {
        if (err instanceof PluginApiError && err.code === 'E_PLUGIN_DISABLED') {
          throw err;
        }
        return deps.registry.get(harnessId);
      }
    },
    assertDispatchTarget(instanceId, fallbackKind, provenance?: AgyDispatchProvenance, scope?) {
      let adapter = deps.registry.get(instanceId);
      try {
        adapter = resolveDriverForScope(deps.getPluginManager(), deps.registry, {
          harnessId: instanceId,
          sessionId: scope?.sessionId,
          workspaceId: scope?.workspaceId,
          driverProviderInstanceId: scope?.driverProviderInstanceId,
          store: deps.store,
        }).adapter;
      } catch (err) {
        if (err instanceof PluginApiError && err.code === 'E_PLUGIN_DISABLED') {
          throw err;
        }
      }
      assertAgyConsumerProvenance({
        instanceId,
        driverId: adapter?.driverId ?? adapter?.kind ?? fallbackKind,
        profile: adapter instanceof AgyAdapter ? adapter.getProfile() : null,
      }, provenance);
    },
    async openSession(harnessId, config: AdapterSessionConfig, scope) {
      const resolved = resolveDriverForScope(deps.getPluginManager(), deps.registry, {
        harnessId,
        sessionId: scope?.sessionId,
        workspaceId: scope?.workspaceId,
        driverProviderInstanceId: scope?.driverProviderInstanceId,
        store: deps.store,
      });
      return resolved.adapter.createSession(config);
    },
  };

  const nativePort: NativeRuntimePort = {
    isEnabled: () => Boolean(deps.getNativeRegistry?.()?.getFeatureFlags().enabled),
    isNativeLifecycleEnabled: () => {
      const flags = deps.getNativeRegistry?.()?.getFeatureFlags();
      return Boolean(flags?.enabled && flags.nativeLifecycle);
    },
    hasCancelHook: () => Boolean(deps.getNativeRegistry?.()?.getLifecyclePort()?.onCancelRequested),
    isNativePermissionsEnabled: () => {
      const flags = deps.getNativeRegistry?.()?.getFeatureFlags();
      return Boolean(flags?.enabled && flags.nativePermissions);
    },
    isObservatoryTapEnabled: () => Boolean(deps.getNativeRegistry?.()?.getFeatureFlags().observatoryTap),
    isSchemaCompatible: () => Boolean(deps.getNativeRegistry?.()?.getSchemaStatus().compatible),
    prepareSessionBinding({ sessionId, instanceId, sourceRef }) {
      const nativeRegistry = deps.getNativeRegistry?.();
      if (!nativeRegistry) return null;
      const storedBinding = nativeRegistry.ensureRuntimeBinding({
        sessionId,
        instanceId,
        profileRef: instanceId,
        sourceRef,
        advanceGeneration: true,
        status: 'attached',
      });
      const binding = {
        runtimeId: storedBinding.runtimeId,
        sessionId: storedBinding.sessionId,
        instanceId: storedBinding.instanceId,
        generation: storedBinding.generation,
      };
      return {
        binding,
        hooks: nativeRegistry.createAdapterRuntimeHooks(binding),
      };
    },
    createObservatoryHooks(sessionId, harnessId) {
      return deps.getNativeRegistry?.()?.createObservatoryOnlyHooks(sessionId, harnessId);
    },
    notifyReconnect(binding, mode) {
      deps.getNativeRegistry?.()?.notifyReconnect(binding, mode);
    },
    notifyCancelRequested(binding) {
      deps.getNativeRegistry?.()?.notifyCancelRequested(binding);
    },
    decideTurnSettlement(turnId, binding) {
      return deps.getNativeRegistry?.()?.decideTurnSettlement(turnId, binding) ?? null;
    },
    getActiveBinding(sessionId) {
      return deps.getNativeRegistry?.()?.getActiveBinding(sessionId) ?? null;
    },
    bindTurnSettlementSink(sink) {
      deps.getNativeRegistry?.()?.bindTurnSettlementSink(sink);
    },
  };

  const requestPort: RuntimeRequestPort = {
    createAndEmitApproval({
      session,
      harnessId,
      nativeRequestId,
      kind,
      toolName,
      toolKind,
      summary,
      input,
      diffPreview,
      riskLevel,
      supportedDecisions,
      questionSpec,
      secretSpec,
      onTimeoutDeny,
    }) {
      const approvalId = `appr_${crypto.randomBytes(6).toString('hex')}`;
      const localAnnotations = deps.getApprovalCenter?.().evaluateLocalRules({
        approvalId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        cwd: session.cwd,
        kind,
        toolName,
        toolKind,
        summary,
        input: input ?? null,
        diffPreview: diffPreview ?? null,
        riskLevel,
      }) ?? [];
      const riskRank: Record<ApprovalRequest['riskLevel'], number> = { low: 0, medium: 1, high: 2, critical: 3 };
      let effectiveRisk: ApprovalRequest['riskLevel'] = riskLevel;
      for (const note of localAnnotations) {
        if (note.risk && riskRank[note.risk] > riskRank[effectiveRisk]) {
          effectiveRisk = note.risk;
        }
      }
      const approval: ApprovalRequest = {
        id: approvalId,
        sessionId: session.id,
        parentSessionId: session.parentSessionId ?? null,
        instanceId: harnessId,
        nativeRequestId,
        kind,
        toolName,
        toolKind,
        summary,
        input: kind === 'secret_request' ? {} : (input ?? {}),
        diffPreview: diffPreview ?? null,
        riskLevel: effectiveRisk,
        supportedDecisions,
        questionSpec: questionSpec ?? null,
        secretSpec: secretSpec ?? null,
        ...(localAnnotations.length > 0 ? { annotations: localAnnotations } : {}),
        status: 'pending',
        resolvedBy: null,
        decision: null,
        comment: null,
        createdAt: Date.now(),
        resolvedAt: null,
      };
      deps.store.createApproval(approval);
      const timer = setTimeout(() => {
        clearApprovalTimer(approval.id);
        if (!deps.store.expireApprovalIfPending(approval.id)) return;
        const expired = deps.store.getApproval(approval.id) ?? { ...approval, resolvedAt: Date.now() };
        const ev = deps.store.appendEvent(approval.sessionId, 'approval.resolved', {
          approvalId: approval.id,
          status: 'expired',
          resolvedAt: expired.resolvedAt,
        });
        deps.eventBus.publishEvent(ev);
        onTimeoutDeny(expired);
      }, 120_000);
      timer.unref();
      approvalTimers.set(approval.id, timer);
      void deps.onAnnotatePendingApproval?.(session, approval).catch(() => {});
      return approval;
    },
    expireSessionApprovals(sessionId, onDenied) {
      for (const approval of deps.store.listPendingApprovals(sessionId)) {
        clearApprovalTimer(approval.id);
        if (!deps.store.expireApprovalIfPending(approval.id)) continue;
        const expired = deps.store.getApproval(approval.id) ?? { ...approval, resolvedAt: Date.now() };
        const ev = deps.store.appendEvent(approval.sessionId, 'approval.resolved', {
          approvalId: approval.id,
          status: 'expired',
          resolvedAt: expired.resolvedAt,
        });
        deps.eventBus.publishEvent(ev);
        onDenied?.(expired);
      }
    },
    cancelSessionApprovals(sessionId, reason, onDenied) {
      const cancelled = deps.store.cancelPendingApprovals(sessionId);
      for (const approval of cancelled) {
        clearApprovalTimer(approval.id);
        const ev = deps.store.appendEvent(approval.sessionId, 'approval.resolved', {
          approvalId: approval.id,
          kind: approval.kind ?? 'command_approval',
          status: 'cancelled',
          resolvedAt: approval.resolvedAt,
          comment: reason,
        });
        deps.eventBus.publishEvent(ev);
        const runtimeUpdated = deps.store.appendEvent(approval.sessionId, 'runtime_request.updated', {
          request: approval,
        });
        deps.eventBus.publishEvent(runtimeUpdated);
        onDenied?.(approval);
      }
    },
    countPendingApprovals(sessionId) {
      return deps.store.listPendingApprovals(sessionId).length;
    },
  };

  const collabPort: CollaborationBridgePort = {
    prepareModelTools(session, harnessId, adapter) {
      const pluginManager = deps.getPluginManager();
      const caps = deps.getPluginCapabilities?.();
      const router = adapter.pluginMcpTransport
        ? selectedHarnessService<ModelToolRouter>(pluginManager, modelToolsContract, { sessionId: session.id })
        : undefined;
      const validRouter = typeof router?.generation === 'string' ? router : undefined;
      const tools = validRouter?.list(session) ?? [];
      const pluginToolKey = validRouter
        ? `${validRouter.instanceId}:${validRouter.generation}:${tools.map((t) =>
            t.kind === 'isolated' ? `${t.name}:${t.permission.digest}:${t.runId}` : `${t.name}:${t.permission.digest}`,
          ).join(',')}`
        : '';
      const shouldAttach =
        Boolean(adapter.pluginMcpTransport) &&
        (tools.length > 0 || pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID));
      const lease = shouldAttach
        ? validRouter?.prepareLease(session, harnessId, tools, () => deps.registry.get(harnessId) === adapter)
        : undefined;
      return {
        pluginToolKey,
        lease,
        isLeaseActive: (l: PluginToolLease) => Boolean(caps?.isLeaseActive(l)),
      };
    },
    isOrchestratorEnabled() {
      const peer = resolveOptionalSessionOrchestrationProvider(deps.getPluginManager(), {
        allowSingleCandidate: true,
      });
      return Boolean(peer);
    },
    prepareTurnText({ text, literalText, mode, cliCommand, nativeSkill, terminalContexts }) {
      const hasNative = Boolean(cliCommand || nativeSkill);
      const { text: expandedText, expandedCommand } = hasNative || literalText || mode
        ? { text, expandedCommand: undefined }
        : deps.getPluginManager().expandSlashCommand(text);
      const baseEffectiveText = !hasNative && mode === 'plugin_development'
        ? `${expandedText}\n\n${pluginDevelopmentBrief}`
        : expandedText;
      const chips = !hasNative && terminalContexts?.length ? terminalContexts : undefined;
      let effectiveText = baseEffectiveText;
      if (chips) {
        const sections = chips.slice(0, 12).map((chip: TerminalContextChip) => {
          const sanitized = stripAnsiAndClip(chip.cleanText, {
            lineStart: 1,
            lineEnd: 500,
            maxBytes: 16_384,
          });
          const exitLabel =
            chip.exitCode !== null && chip.exitCode !== undefined ? ` · exit ${chip.exitCode}` : '';
          const truncLabel = chip.truncated || sanitized.truncated ? ' · truncated' : '';
          return [
            `### ${chip.terminalTitle} (lines ${chip.lineStart}–${chip.lineEnd}${exitLabel}${truncLabel})`,
            `- **CWD**: \`${chip.cwd}\``,
            '```text',
            sanitized.cleanText,
            '```',
          ].join('\n');
        });
        const block = [`## Attached Terminal Context (${sections.length})`, '', ...sections].join('\n');
        effectiveText = `${baseEffectiveText}\n\n${block}`;
      }
      const compactTerminalChips = chips?.map((c) => ({
        id: c.id,
        terminalId: c.terminalId,
        terminalTitle: c.terminalTitle,
        cwd: c.cwd,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        truncated: c.truncated,
        exitCode: c.exitCode ?? null,
      }));
      return { effectiveText, expandedCommand, compactTerminalChips };
    },
    async prepareTurnHandoff({ session, harnessId, harnessKind, binding, upToSeq, excludeTurnId, omitHandoff }) {
      if (omitHandoff) return null;
      const pm = deps.getPluginManager();
      const handoffPeer = resolveOptionalSessionHandoffProvider(pm, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
      if (!handoffPeer) return null;
      const compiler =
        pm.host.getServiceByInstance<ContextCompiler>(handoffPeer.instanceId, 'handoff') ??
        pm.host.get<ContextCompiler>('handoff');
      if (compiler) {
        if (!compiler.options.autoAttach) return null;
        return compiler.compile({
          session,
          targetHarnessId: harnessId,
          targetHarnessKind: harnessKind,
          binding,
          upToSeq,
          excludeTurnId,
        });
      }
      const info = unwrapPeerServiceResult(await handoffPeer.service.getProviderInfo());
      if (!info.autoAttach) return null;
      const { packet } = unwrapPeerServiceResult(
        await handoffPeer.service.compile({
          sessionId: session.id,
          targetHarnessId: harnessId,
          targetHarnessKind: harnessKind,
          binding: binding
            ? {
                sessionId: binding.sessionId,
                harnessId: binding.harnessId,
                harnessKind: binding.harnessKind,
                nativeSessionId: binding.nativeSessionId,
                lastModel: binding.lastModel,
                lastActualModel: binding.lastActualModel,
                lastEffort: binding.lastEffort,
                syncedUpToSeq: binding.syncedUpToSeq,
                driverUsed: binding.driverUsed,
                updatedAt: binding.updatedAt,
              }
            : null,
          upToSeq,
          excludeTurnId,
        }),
      );
      return {
        ...packet,
        preview: packet.preview as unknown as import('@harnessmate/protocol').ContextPreview,
        snapshot: packet.snapshot as unknown as import('./handoff-snapshot.js').HandoffSnapshot,
        deliveryLifecycle: {
          stagePending: ({ turnId, driver, fromInstanceId }) => {
            void handoffPeer.service.stagePending({
              sessionId: session.id,
              targetHarnessId: harnessId,
              turnId,
              driver,
              fromInstanceId,
              coveredUpToSeq: packet.coveredUpToSeq,
              estimatedChars: packet.deltaMarkdown.length,
              redactedCount: packet.redaction?.redactedCount ?? 0,
              isWarmBinding: packet.preview.isWarmBinding,
              forceFreshNativeSession: packet.forceFreshNativeSession,
              forceFreshReason: packet.forceFreshReason,
              snapshot: packet.snapshot,
            });
            return `${session.id}:${harnessId}:${turnId ?? Date.now()}`;
          },
          confirmDelivery: (handoffId) => {
            void handoffPeer.service.confirmDelivery({ handoffId });
          },
          failDelivery: (handoffId, resetBinding = false, uncertain = false) => {
            void handoffPeer.service.failDelivery({
              handoffId,
              sessionId: session.id,
              targetHarnessId: harnessId,
              resetBinding,
              uncertain,
            });
          },
        },
      };
    },
    async compileContext(params) {
      const pm = deps.getPluginManager();
      const handoffPeer = resolveOptionalSessionHandoffProvider(pm, {
        sessionId: params.session.id,
        workspaceId: params.session.workspaceId,
      });
      if (!handoffPeer) {
        throw new PluginApiError('E_PLUGIN_DISABLED', '交接插件已停用或不可用');
      }
      const compiler =
        pm.host.getServiceByInstance<ContextCompiler>(handoffPeer.instanceId, 'handoff') ??
        pm.host.get<ContextCompiler>('handoff');
      if (!compiler) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'handoff 服务不可用');
      }
      return compiler.compile(params);
    },
    async capturePreTurnCheckpoint({ sessionId, workspaceId, cwd, turnSeq }) {
      try {
        const provider = resolveGitCheckpointProvider(deps.getPluginManager(), {
          sessionId,
          workspaceId,
        }).provider;
        const pre = await provider.capture({
          sessionId,
          cwd,
          turnSeq,
          phase: 'turn_pre',
        });
        return pre ? { treeSha: pre.treeSha, skippedLargeFiles: pre.skippedLargeFiles } : null;
      } catch {
        return null;
      }
    },
    async capturePostTurnCheckpoint({ session, turnSeq, preTurnTreeSha, maintenance }) {
      if (maintenance || turnSeq === undefined) return null;
      try {
        const provider = resolveGitCheckpointProvider(deps.getPluginManager(), {
          sessionId: session.id,
          workspaceId: session.workspaceId,
        }).provider;
        const record = await provider.capture({
          sessionId: session.id,
          cwd: session.cwd,
          turnSeq,
          phase: 'turn_post',
          skipIfUnchangedFromTreeSha: preTurnTreeSha ?? null,
          compareAgainstTreeSha: preTurnTreeSha ?? null,
        });
        return record ?? null;
      } catch {
        return null;
      }
    },
    syncTaskLedger(session) {
      deps.getPluginManager().host.get<TaskLedgerService>('ledger')?.syncSession(session);
    },
    notifyOrchestratorTurnCompleted(sessionId) {
      const peer = resolveOptionalSessionOrchestrationProvider(deps.getPluginManager(), {
        sessionId,
        allowSingleCandidate: true,
      });
      if (peer?.service.notifyChildTurnCompleted) {
        void peer.service.notifyChildTurnCompleted(sessionId).catch(() => {});
        return;
      }
      const orch = deps.getOrchestrator?.();
      if (orch) {
        void orch.handleChildTurnCompleted(sessionId).catch(() => {});
      }
    },
    notifyOrchestratorParentIdle(sessionId) {
      const peer = resolveOptionalSessionOrchestrationProvider(deps.getPluginManager(), {
        sessionId,
        allowSingleCandidate: true,
      });
      if (peer?.service.notifyParentSessionIdle) {
        peer.service.notifyParentSessionIdle(sessionId);
        return;
      }
      deps.getOrchestrator?.()?.onParentSessionIdle(sessionId);
    },
    notifyOrchestratorTurnCancelled(sessionId) {
      const peer = resolveOptionalSessionOrchestrationProvider(deps.getPluginManager(), {
        sessionId,
        allowSingleCandidate: true,
      });
      if (peer?.service.notifyChildTurnCancelled) {
        void peer.service.notifyChildTurnCancelled(sessionId).catch(() => {});
        return;
      }
      const orch = deps.getOrchestrator?.();
      if (orch) {
        void orch.handleChildTurnCancelled(sessionId).catch(() => {});
      }
    },
    notifyOrchestratorChildApproval(sessionId, approvalId, toolName) {
      const peer = resolveOptionalSessionOrchestrationProvider(deps.getPluginManager(), {
        sessionId,
        allowSingleCandidate: true,
      });
      if (peer?.service.notifyChildApproval) {
        peer.service.notifyChildApproval(sessionId, approvalId, toolName);
        return;
      }
      deps.getOrchestrator?.()?.handleChildApprovalRequested(sessionId, approvalId, toolName);
    },
    recordFailoverFailure(sessionId, harnessId, failureClass, resetAt) {
      const failoverSvc = selectedHarnessService<FailoverContract>(
        deps.getPluginManager(),
        failoverContract,
        { sessionId },
      );
      const receipt = failoverSvc?.recordFailure?.(harnessId, failureClass, resetAt);
      if (receipt instanceof Promise) {
        void receipt.catch(() => {});
        return resetAt ?? null;
      }
      return receipt?.resetsAt ?? resetAt ?? null;
    },
    notifyAttention(event) {
      deps.eventBus.publishAttention(event);
    },
    publishCanonicalEvent(ev: CanonicalEvent) {
      deps.eventBus.publishEvent(ev);
    },
    async emitPluginLifecycleEvent(type, session) {
      await deps.getPluginManager().dispatchLifecycleEvent(sessionPluginEvent(type, session), session.workspaceId);
    },
  };

  return { driverPort, nativePort, requestPort, collabPort };
}
