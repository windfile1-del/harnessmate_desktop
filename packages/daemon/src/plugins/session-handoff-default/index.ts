import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SESSION_HANDOFF_CONTRACT,
  SESSION_HANDOFF_CONTRACT_VERSION,
  type CompiledHandoffPacketDto,
  type HandoffComposeEvent,
  type ServiceMethodResult,
  type SessionHandoffServiceV1,
  type SessionRecordDto,
} from '@harnessmate/plugin-api';
import type {
  ContextSyncMode,
  GitStatusSummary,
  HarnessHistoryInjectionMode,
  HarnessKind,
  PermissionMode,
  ReasoningEffort,
  Session,
  SessionHarnessBinding,
} from '@harnessmate/protocol';
import { ContextCompiler, type CompiledContextPacket } from '../../core/context-compiler.js';
import type { ContextCompressorProvider } from '../../core/context-compression-service.js';
import { resolveDriverForScope } from '../../core/driver-peer-router.js';
import type { getGitStatusSummary } from '../../core/git-service.js';
import { findSessionWithProvider } from '../../core/session-peer-router.js';
import { renderTaskLedgerMarkdown } from '../../core/task-ledger-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { SessionAssistanceDependencies } from '../../plugin-host/builtin/session-assistance.js';
import type { PluginEvents } from '../../plugin-host/runtime/events.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { PluginManager } from '../plugin-manager.js';

export const SESSION_HANDOFF_DEFAULT_PLUGIN_ID = 'core.context-bridge';

export const handoffRedactionMap = new WeakMap<object, { categories: string[]; redactedCount: number }>();

export const handoffConfigSchema = z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict();

function peerOk<T>(value: T): ServiceMethodResult<T> {
  return { ok: true, value };
}

function peerErr<T = never>(
  code: 'invalid_request' | 'not_found' | 'plugin_disabled' | 'conflict',
  message: string,
): ServiceMethodResult<T> {
  return { ok: false, error: { code, message } };
}

function toSessionModel(dto: SessionRecordDto): Session {
  return {
    id: dto.id,
    workspaceId: dto.workspaceId,
    harnessId: dto.harnessId,
    harnessKind: dto.harnessKind,
    nativeSessionId: dto.nativeSessionId,
    parentSessionId: dto.parentSessionId ?? null,
    forkedFromTurnSeq: dto.forkedFromTurnSeq ?? null,
    forkMode: dto.forkMode === 'clean_fork' ? 'native' : dto.forkMode === 'with_context' ? 'portable' : null,
    importMode: dto.importMode ?? null,
    importSource: dto.importSource ?? null,
    participatingHarnesses: dto.participatingHarnesses ?? [dto.harnessId],
    contextSyncMode: dto.contextSyncMode ?? 'auto',
    cwd: dto.cwd,
    worktreeBranch: dto.worktreeBranch ?? null,
    title: dto.title,
    status: dto.status as Session['status'],
    model: dto.model,
    actualModel: dto.actualModel ?? null,
    modelReroutedReason: dto.modelReroutedReason ?? null,
    reasoningEffort: (dto.reasoningEffort as ReasoningEffort | null) ?? null,
    permissionMode: dto.permissionMode as PermissionMode,
    lastSeq: dto.lastSeq,
    usage: dto.usage ?? null,
    pendingApprovalCount: dto.pendingApprovalCount,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function mapDriverToDeliveryChannel(driver: string): HarnessHistoryInjectionMode {
  switch (driver) {
    case 'codex_inject_items':
      return 'native_items';
    case 'agy_embedded_context':
      return 'embedded_context';
    case 'claude_sysfile':
      return 'sysfile_delta';
    default:
      return 'inline';
  }
}

function toCompiledPacketDto(packet: CompiledContextPacket): CompiledHandoffPacketDto {
  return {
    preview: packet.preview,
    snapshot: packet.snapshot as unknown as Record<string, unknown>,
    deltaMarkdown: packet.deltaMarkdown,
    portableItems: packet.portableItems,
    objective: packet.objective,
    coveredUpToSeq: packet.coveredUpToSeq,
    syncNeeded: packet.syncNeeded,
    forceFreshNativeSession: packet.forceFreshNativeSession,
    forceFreshReason: packet.forceFreshReason,
    redaction: packet.redaction,
    omitted: packet.omitted,
    workspaceAnchor: packet.workspaceAnchor,
  };
}

export function createSessionHandoffPlugin(params: {
  store: HarnessMateStore;
  registry: HarnessRegistry;
  assistance: Omit<SessionAssistanceDependencies, 'store'>;
  events: () => PluginEvents;
  lookupGitStatus: (ctx: { get<T>(name: string): T | undefined }, cwd: string) => Promise<GitStatusSummary | undefined>;
  collectIsolatedSections?: (event: HandoffComposeEvent) => Promise<Array<{ id: string; source: string; order: number; text: string }>>;
  getPluginManager?: () => PluginManager;
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  let runSeq = 0;

  return {
    provides: [SESSION_HANDOFF_CONTRACT, 'handoff'],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(params.registry);
      const instanceId = ctx.instanceId ?? 'handoff';
      const runId = `handoff-run-${++runSeq}`;
      let active = true;

      const ledger = {
        get: async (sessionId: string) => {
          const session = params.store.getSession(sessionId);
          return session ? params.assistance.readLedger(session) : null;
        },
        renderLedgerMarkdown: renderTaskLedgerMarkdown,
      };
      const options = handoffConfigSchema.parse(settings);
      const compiler = new ContextCompiler(
        params.store,
        ledger,
        options,
        (cwd) => params.lookupGitStatus(ctx, cwd) as unknown as ReturnType<typeof getGitStatusSummary>,
        params.events(),
        params.collectIsolatedSections,
        undefined,
        () => ctx.get<ContextCompressorProvider>('compressor'),
      );

      const baseCompile = compiler.compile.bind(compiler);
      compiler.compile = async (compileOpts) => {
        const packet = await baseCompile(compileOpts);
        const redactor = ctx.host?.getHandoffRedactor();
        if (!redactor || !packet.syncNeeded) {
          return packet;
        }
        const targetDriverId = compileOpts.targetHarnessKind || compileOpts.targetHarnessId;
        const deltaRes = await redactor({
          text: packet.deltaMarkdown,
          targetDriverId,
          sessionId: compileOpts.session.id,
          workspaceId: compileOpts.session.workspaceId,
          targetInstanceId: compileOpts.targetHarnessId,
        });
        const allCategories = new Set<string>(deltaRes.categories);
        let totalRedacted = deltaRes.redactedCount;
        const redactText = async (inputText: string): Promise<string> => {
          if (!inputText) return inputText;
          const r = await redactor({
            text: inputText,
            targetDriverId,
            sessionId: compileOpts.session.id,
            workspaceId: compileOpts.session.workspaceId,
            targetInstanceId: compileOpts.targetHarnessId,
          });
          for (const cat of r.categories) allCategories.add(cat);
          totalRedacted = Math.max(totalRedacted, r.redactedCount);
          return r.text;
        };
        const redactedPortableItems = await Promise.all(
          packet.portableItems.map(async (item) => ({
            ...item,
            content: await Promise.all(
              item.content.map(async (part) => ({
                ...part,
                text: await redactText(part.text),
              })),
            ),
          })),
        );
        const redactedCompiledMarkdown = packet.preview.compiledMarkdown === packet.deltaMarkdown
          ? deltaRes.text
          : await redactText(packet.preview.compiledMarkdown);
        const redactedLedgerMarkdown = packet.preview.ledgerMarkdown
          ? await redactText(packet.preview.ledgerMarkdown)
          : packet.preview.ledgerMarkdown;
        const redactedObjective = packet.objective
          ? await redactText(packet.objective)
          : packet.objective;
        const updated = {
          ...packet,
          deltaMarkdown: deltaRes.text,
          objective: redactedObjective,
          portableItems: redactedPortableItems,
          preview: {
            ...packet.preview,
            compiledMarkdown: redactedCompiledMarkdown,
            ledgerMarkdown: redactedLedgerMarkdown,
            estimatedTokens: Math.max(1, Math.ceil(redactedCompiledMarkdown.length / 4)),
          },
        };
        if (allCategories.size > 0 || totalRedacted > 0) {
          handoffRedactionMap.set(updated, {
            categories: [...allCategories],
            redactedCount: totalRedacted,
          });
        }
        return updated;
      };

      const resolveSession = async (sessionId: string): Promise<Session | null> => {
        const pm = params.getPluginManager?.();
        if (pm) {
          const found = await findSessionWithProvider(pm, sessionId).catch(() => null);
          if (found) return toSessionModel(found.session);
        }
        return params.store.getSession(sessionId);
      };

      const serviceV1: SessionHandoffServiceV1 = {
        async getProviderInfo() {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          return peerOk({
            instanceId,
            runId,
            autoAttach: compiler.options.autoAttach,
            budgetTokens: compiler.options.budgetTokens,
          });
        },
        async preview(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          const session = await resolveSession(request.sessionId);
          if (!session) return peerErr('not_found', `Session not found: ${request.sessionId}`);
          const targetId = request.targetHarnessId || session.harnessId;
          const pm = params.getPluginManager?.();
          const resolvedAdapter = pm
            ? resolveDriverForScope(pm, params.registry, {
                harnessId: targetId,
                workspaceId: session.workspaceId,
                sessionId: session.id,
                store: params.store,
              })
            : null;
          const adapter = resolvedAdapter?.adapter ?? params.registry.get(targetId);
          if (!adapter) {
            return peerErr('not_found', `Harness not registered: ${targetId}`);
          }
          const binding = params.store.getSessionBinding(session.id, targetId);
          const packet = await compiler.compile({
            session,
            targetHarnessId: targetId,
            targetHarnessKind: adapter.kind,
            binding,
            syncMode: request.syncMode as ContextSyncMode | undefined,
          });
          const preview = compiler.options.autoAttach
            ? packet.preview
            : { ...packet.preview, syncNeeded: false };
          return peerOk({ preview: preview as unknown as Record<string, unknown> });
        },
        async compile(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          const session = await resolveSession(request.sessionId);
          if (!session) return peerErr('not_found', `Session not found: ${request.sessionId}`);
          const binding: SessionHarnessBinding | null = request.binding
            ? {
                sessionId: request.binding.sessionId,
                harnessId: request.binding.harnessId,
                harnessKind: request.binding.harnessKind as HarnessKind,
                nativeSessionId: request.binding.nativeSessionId,
                lastModel: request.binding.lastModel ?? null,
                lastActualModel: request.binding.lastActualModel ?? null,
                lastEffort: (request.binding.lastEffort as ReasoningEffort | null) ?? null,
                syncedUpToSeq: request.binding.syncedUpToSeq,
                driverUsed: (request.binding.driverUsed as SessionHarnessBinding['driverUsed']) ?? null,
                updatedAt: request.binding.updatedAt,
              }
            : null;
          const packet = await compiler.compile({
            session,
            targetHarnessId: request.targetHarnessId,
            targetHarnessKind: request.targetHarnessKind as HarnessKind,
            binding,
            syncMode: request.syncMode,
            excludeTurnId: request.excludeTurnId,
            upToSeq: request.upToSeq,
            budgetTokens: request.budgetTokens,
            modelContextWindow: request.modelContextWindow,
            nativeUsedTokens: request.nativeUsedTokens,
            currentUserText: request.currentUserText,
          });
          return peerOk({ packet: toCompiledPacketDto(packet) });
        },
        async stagePending(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          if (request.forceFreshNativeSession) {
            params.store.setSessionBindingExact(request.sessionId, request.targetHarnessId, {
              nativeSessionId: null,
              syncedUpToSeq: 0,
              driverUsed: null,
            });
            const currentSession = params.store.getSession(request.sessionId);
            if (currentSession && currentSession.harnessId === request.targetHarnessId) {
              params.store.updateSession(request.sessionId, { nativeSessionId: null });
            }
          }
          const handoffId = randomUUID();
          params.store.createHandoffRecord({
            handoffId,
            sessionId: request.sessionId,
            turnId: request.turnId ?? null,
            fromInstanceId: request.fromInstanceId ?? null,
            toInstanceId: request.targetHarnessId,
            mode: request.isWarmBinding ? 'delta_since_target_last_seen' : 'full_session_summary',
            deliveryChannel: mapDriverToDeliveryChannel(request.driver),
            deliveryStatus: 'pending',
            coveredUpToSeq: request.coveredUpToSeq,
            estimatedChars: request.estimatedChars,
            redactedCount: request.redactedCount,
            forceFreshReason: request.forceFreshReason ?? null,
            snapshot: request.snapshot,
            createdAt: Date.now(),
            confirmedAt: null,
          });
          return peerOk({ handoffId });
        },
        async confirmDelivery(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          params.store.updateHandoffDeliveryStatus(request.handoffId, 'confirmed', Date.now());
          return peerOk({ ok: true });
        },
        async failDelivery(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          const deliveryStatus = request.uncertain ? 'uncertain' : 'failed';
          params.store.updateHandoffDeliveryStatus(request.handoffId, deliveryStatus);
          if (request.resetBinding) {
            params.store.setSessionBindingExact(request.sessionId, request.targetHarnessId, {
              nativeSessionId: null,
              syncedUpToSeq: 0,
              driverUsed: null,
            });
            const currentSession = params.store.getSession(request.sessionId);
            if (currentSession && currentSession.harnessId === request.targetHarnessId) {
              params.store.updateSession(request.sessionId, { nativeSessionId: null });
            }
          }
          return peerOk({ deliveryStatus });
        },
        async listHandoffs(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          const records = params.store.listHandoffRecords(request.sessionId, request.limit ?? 50);
          return peerOk({
            handoffs: records.map((r) => ({
              handoffId: r.handoffId,
              sessionId: r.sessionId,
              turnId: r.turnId ?? null,
              fromInstanceId: r.fromInstanceId ?? null,
              toInstanceId: r.toInstanceId,
              mode: r.mode,
              deliveryChannel: r.deliveryChannel,
              deliveryStatus: r.deliveryStatus,
              coveredUpToSeq: r.coveredUpToSeq,
              estimatedChars: r.estimatedChars,
              redactedCount: r.redactedCount,
              forceFreshReason: r.forceFreshReason ?? null,
              snapshot: r.snapshot,
              createdAt: r.createdAt,
              deliveredAt: r.confirmedAt ?? null,
            })),
          });
        },
        async evaluateOffer(request) {
          if (!active) return peerErr('plugin_disabled', '交接插件已停用');
          const latest = params.store.getLatestHandoffRecord(request.sessionId, request.harnessId);
          const session = await resolveSession(request.sessionId);
          const binding = params.store.getSessionBinding(request.sessionId, request.harnessId);
          const uncertain = latest?.deliveryStatus === 'pending' || latest?.deliveryStatus === 'uncertain';
          const unsynced = session ? session.lastSeq > (binding?.syncedUpToSeq ?? 0) : false;
          return peerOk({
            decision: {
              shouldOffer: Boolean(compiler.options.autoAttach && (uncertain || unsynced)),
              uncertainPreviousDelivery: uncertain,
              latestDeliveryStatus: latest?.deliveryStatus ?? null,
              autoAttach: compiler.options.autoAttach,
            },
          });
        },
      };

      ctx.provide('handoff', compiler);
      ctx.provide(SESSION_HANDOFF_CONTRACT, serviceV1, {
        version: SESSION_HANDOFF_CONTRACT_VERSION,
        metadata: { title: '跨引擎上下文桥接插件' },
      });
      ctx.effect(() => () => {
        active = false;
      });
    },
  };
}
