import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PEER_CONTRACTS,
  PluginApiError,
  isReservedServiceName,
  pluginEventContracts,
  serviceResolutionErrorCode,
  type ContextHandoffPreviewV2,
  type ForkSessionOptions,
  type GetSessionItemOptions,
  type GitWorkspaceServiceV1,
  type ListSessionItemsOptions,
  type PluginEventName,
  type PluginEventV4,
  type PublicApprovalAnnotationInput,
  type PublicComposerSuggestion,
  type PublicFsEntry,
  type PublicFsStat,
  type PublicHarnessBinding,
  type PublicHarnessDriverDescriptor,
  type PublicHarnessInstanceInfo,
  type PublicNetInit,
  type PublicNetResponse,
  type PublicNetStreamInit,
  type PublicSession,
  type PublicSessionCapabilities,
  type PublicSessionNotice,
  type PublicTaskLedger,
  type PublicTaskLedgerAppend,
  type PublicTurnBlock,
  type ResolveServiceSelectionOptions,
  type ServiceResolutionV1,
  type SessionDataServiceV1,
  type SessionRecordDto,
  type SessionWorkspaceDto,
  type SpawnCliSpec,
  type SwitchSessionInstanceOptions,
} from '@harnessmate/plugin-api';
import {
  PluginNativeCommandSchema,
  type CanonicalEvent,
  type CanonicalEventType,
  type InstalledPluginInfo,
  type Session,
  type SessionHarnessBinding,
  type SessionTaskState,
  type TurnBlockRecord,
  type Workspace,
} from '@harnessmate/protocol';
import type { ContextCompiler } from '../../core/context-compiler.js';
import type { TaskLedgerService } from '../../core/task-ledger-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { AdapterSessionConfig } from '../../harnesses/types.js';
import { AGY_RUNTIME_CONTRACT, type AgyRuntimeServiceV1 } from '@harnessmate/plugin-api';
import { handoffRedactionMap, type GitService } from '../builtin/services.js';
import { GLOBAL_WORKSPACE_SCOPE, type PluginPermissionService } from '../permissions/permissions.js';
import type { PluginHost } from '../runtime/lifecycle.js';
import { toPluginEvent } from '../runtime/map-event.js';
import type { CliProcessManager } from './cli-process-manager.js';
import { parseSecretNamespace, type PluginSecretStore } from './plugin-secrets.js';

const MAX_FS_BYTES = 2 * 1024 * 1024;
const MAX_NET_BYTES = 2 * 1024 * 1024;
const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_LOGS_PER_PLUGIN = 200;

import { isHostHarnessOperation } from '../service-access.js';

export interface PluginLogEntry {
  timestamp: number;
  pluginId: string;
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

export interface PluginRouterDeps {
  store: HarnessMateStore;
  host: PluginHost;
  permissions: PluginPermissionService;
  getPluginInfo: (pluginId: string) => InstalledPluginInfo | undefined;
  isCurrentRun: (pluginId: string, runId: string) => boolean;
  cliProcesses?: CliProcessManager;
  pluginSecrets?: PluginSecretStore;
  onCliOutput?: (pluginId: string, runId: string, processId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  onCliExit?: (pluginId: string, runId: string, processId: string, code: number | null, signal: string | null) => void;
  onNetStreamChunk?: (pluginId: string, runId: string, streamId: string, chunk: string) => void;
  onNetStreamEnd?: (pluginId: string, runId: string, streamId: string) => void;
  onNetStreamError?: (pluginId: string, runId: string, streamId: string, message: string) => void;
  onDriverRegister?: (pluginId: string, runId: string, driver: PublicHarnessDriverDescriptor) => void;
  onDriverUnregister?: (pluginId: string, runId: string, driverId: string) => void;
  onDriverSessionEvent?: (pluginId: string, runId: string, handleId: string, event: Record<string, unknown>) => void;
  onSubscriptionChange?: (pluginId: string, runId: string, event: string, subscribed: boolean) => void;
  onServiceChannelSubscriptionChange?: (pluginId: string, runId: string, contract: string, subscribed: boolean) => void;
  openHarnessSession?: (
    plugin: InstalledPluginInfo,
    instanceId: string,
    runId: string,
    input: { harnessId: string; config: AdapterSessionConfig },
  ) => Promise<{
    leaseId: string;
    nativeSessionId: string | null;
    pluginMcpAvailable: boolean;
    supportsSteer: boolean;
    supportsInjectContext: boolean;
  }>;
  harnessSessionCall?: (
    instanceId: string,
    runId: string,
    leaseId: string,
    op: 'sendTurn' | 'steerTurn' | 'interrupt' | 'updateConfig' | 'resolveApproval' | 'dispose',
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  onComposerSuggest?: (pluginId: string, sessionId: string, suggestion: PublicComposerSuggestion) => void;
  onNotify?: (pluginId: string, input: { title: string; body?: string; level?: 'info' | 'warn' | 'error' }) => void;
  onClipboardWrite?: (pluginId: string, text: string) => void;
  runNativeCommand?: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>;
  onDynamicUnregister?: (pluginId: string, runId: string, kind: 'service' | 'command' | 'tool' | 'section' | 'slot' | 'route', name: string) => void;
  resolveServiceSelection?: (contract: string, options: ResolveServiceSelectionOptions) => ServiceResolutionV1;
}

function toPublicTurnBlock(item: TurnBlockRecord, truncateOmitted = false): PublicTurnBlock {
  const textBody = truncateOmitted && item.outputOmitted && item.textBody.length > 512
    ? item.textBody.slice(0, 512)
    : item.textBody;
  return {
    itemId: item.itemId,
    schemaVersion: item.schemaVersion,
    sessionId: item.sessionId,
    turnId: item.turnId,
    seq: item.seq,
    instanceId: item.instanceId,
    driverId: item.driverId,
    blockType: item.blockType,
    status: item.status,
    title: item.title,
    textBody,
    payload: item.payload,
    outputOmitted: item.outputOmitted,
    omittedBytes: item.omittedBytes,
    rawRef: item.rawRef ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function fromSessionRecordDto(dto: SessionRecordDto): Session {
  return {
    id: dto.id,
    workspaceId: dto.workspaceId,
    harnessId: dto.harnessId,
    harnessKind: dto.harnessKind,
    nativeSessionId: dto.nativeSessionId,
    parentSessionId: dto.parentSessionId ?? null,
    forkedFromTurnSeq: dto.forkedFromTurnSeq ?? null,
    forkMode: (dto.forkMode as Session['forkMode']) ?? null,
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
    reasoningEffort: dto.reasoningEffort,
    permissionMode: dto.permissionMode,
    lastSeq: dto.lastSeq,
    usage: dto.usage ?? null,
    pendingApprovalCount: dto.pendingApprovalCount,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function fromWorkspaceDto(dto: SessionWorkspaceDto): Workspace {
  return {
    id: dto.id,
    name: dto.name,
    rootPath: dto.rootPath,
    isGitRepo: dto.isGitRepo,
    gitBranch: dto.gitBranch ?? null,
    createdAt: dto.createdAt,
  };
}

function toPublicBinding(binding: SessionHarnessBinding): PublicHarnessBinding {
  return {
    sessionId: binding.sessionId,
    harnessId: binding.harnessId,
    harnessKind: binding.harnessKind,
    nativeSessionId: binding.nativeSessionId,
    lastModel: binding.lastModel ?? null,
    lastActualModel: binding.lastActualModel ?? null,
    lastEffort: binding.lastEffort ?? null,
    syncedUpToSeq: binding.syncedUpToSeq,
    driverUsed: binding.driverUsed ?? null,
    updatedAt: binding.updatedAt,
  };
}

function toPublicSession(session: Session): PublicSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    harnessId: session.harnessId,
    harnessKind: session.harnessKind,
    title: session.title,
    status: session.status,
    model: session.model,
    permissionMode: session.permissionMode,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toPublicLedger(state: SessionTaskState): PublicTaskLedger {
  return {
    sessionId: state.sessionId,
    objective: state.objective,
    steps: state.steps.map(({ id, title, status }) => ({ id, title, status })),
    decisions: [...state.decisions],
    touchedFiles: [...state.touchedFiles],
    blockers: [...state.blockers],
    pinnedFacts: [...state.pinnedFacts],
    version: state.version,
    updatedAt: state.updatedAt,
  };
}

function resolveWorkspacePath(rootPath: string, relativePath: string, mustExist: boolean): { fullPath: string; rel: string } {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new PluginApiError('E_INVALID_INPUT', '无效的文件路径');
  }
  const realRoot = fs.realpathSync(rootPath);
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(realRoot, cleaned);
  const relFromRoot = path.relative(realRoot, candidate);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止访问工作区之外的路径');
  }
  if (relFromRoot === '.git' || relFromRoot.startsWith(`.git${path.sep}`)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止直接访问 .git 目录');
  }
  if (fs.existsSync(candidate)) {
    const realTarget = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PluginApiError('E_PERMISSION_DENIED', '禁止通过符号链接逃逸工作区');
    }
    return { fullPath: realTarget, rel: realRel.replace(/\\/g, '/') };
  }
  if (mustExist) {
    throw new PluginApiError('E_INVALID_INPUT', `路径不存在: ${cleaned}`);
  }
  // Check nearest existing parent directory for symlink escape
  let parent = path.dirname(candidate);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (fs.existsSync(parent)) {
    const realParent = fs.realpathSync(parent);
    const parentRel = path.relative(realRoot, realParent);
    if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
      throw new PluginApiError('E_PERMISSION_DENIED', '禁止写入工作区之外的路径');
    }
  }
  return { fullPath: candidate, rel: relFromRoot.replace(/\\/g, '/') };
}

export class IsolatedPluginRpcRouter {
  private readonly logs = new Map<string, PluginLogEntry[]>();
  private readonly pendingSuggestions = new Map<string, Array<{ pluginId: string; suggestion: PublicComposerSuggestion; createdAt: number }>>();
  private readonly preparedTurns = new Map<string, Array<{ pluginId: string; text: string; parts?: Array<{ label: string; text: string }>; createdAt: number }>>();
  private readonly activeNetStreams = new Map<string, { pluginId: string; runId: string; controller: AbortController }>();
  readonly notifications: Array<{ pluginId: string; title: string; body?: string; level: string; timestamp: number }> = [];
  readonly clipboardWrites: Array<{ pluginId: string; text: string; timestamp: number }> = [];

  constructor(private readonly deps: PluginRouterDeps) {}

  abortNetStreamsForRun(pluginId: string, runId?: string): void {
    for (const [streamId, entry] of [...this.activeNetStreams.entries()]) {
      if (entry.pluginId === pluginId && (!runId || entry.runId === runId)) {
        this.activeNetStreams.delete(streamId);
        try { entry.controller.abort(); } catch {}
      }
    }
  }

  abortAllNetStreams(): void {
    for (const [streamId, entry] of [...this.activeNetStreams.entries()]) {
      this.activeNetStreams.delete(streamId);
      try { entry.controller.abort(); } catch {}
    }
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return [...(this.logs.get(pluginId) ?? [])];
  }

  getAllLogs(): PluginLogEntry[] {
    return [...this.logs.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  clearLogs(pluginId?: string): void {
    if (pluginId) this.logs.delete(pluginId);
    else this.logs.clear();
  }

  getComposerSuggestions(sessionId: string) {
    return [...(this.pendingSuggestions.get(sessionId) ?? [])];
  }

  getPreparedTurns(sessionId: string) {
    return [...(this.preparedTurns.get(sessionId) ?? [])];
  }

  private appendLog(entry: PluginLogEntry): void {
    const list = this.logs.get(entry.pluginId) ?? [];
    list.push(entry);
    if (list.length > MAX_LOGS_PER_PLUGIN) list.splice(0, list.length - MAX_LOGS_PER_PLUGIN);
    this.logs.set(entry.pluginId, list);
  }

  private resolveSessionDataAccess(options?: {
    sessionId?: string;
    workspaceId?: string;
  }): { mode: 'peer'; service: SessionDataServiceV1; instanceId: string } | { mode: 'multi_peer' } | { mode: 'legacy_store' } {
    const providers = this.deps.host.listServiceProviders('session.data.v1');
    const resolution = this.resolveServiceWithFallback('session.data.v1', {
      sessionId: options?.sessionId,
      workspaceId: options?.workspaceId,
      allowSingleCandidate: true,
    });
    if (resolution.status === 'ready') {
      const service = this.deps.host.getServiceByInstance<SessionDataServiceV1>(resolution.instanceId, 'session.data.v1');
      if (service) {
        return { mode: 'peer', service, instanceId: resolution.instanceId };
      }
    }
    if (resolution.status === 'unavailable') {
      throw new PluginApiError(serviceResolutionErrorCode(resolution.status), '会话数据服务当前不可用或已停用');
    }
    if (resolution.status === 'selection_required' && providers.length > 0) {
      return { mode: 'multi_peer' };
    }
    if (providers.length === 0 && !this.deps.resolveServiceSelection) {
      return { mode: 'legacy_store' };
    }
    throw new PluginApiError('E_SERVICE_UNAVAILABLE', '会话数据服务当前不可用或未就绪');
  }

  private async resolveSessionWithProvider(sessionId: unknown): Promise<{
    session: Session;
    service?: SessionDataServiceV1;
    instanceId?: string;
  }> {
    if (typeof sessionId !== 'string' || !sessionId) throw new PluginApiError('E_INVALID_INPUT', '缺少 sessionId');
    const access = this.resolveSessionDataAccess({ sessionId });
    if (access.mode === 'legacy_store') {
      const session = this.deps.store.getSession(sessionId);
      if (!session) throw new PluginApiError('E_INVALID_INPUT', `会话不存在: ${sessionId}`);
      return { session };
    }
    if (access.mode === 'peer') {
      const res = await access.service.getSession({ sessionId });
      if (res.ok && res.value.session) {
        return { session: fromSessionRecordDto(res.value.session), service: access.service, instanceId: access.instanceId };
      }
    } else {
      for (const provider of this.deps.host.listServiceProviders('session.data.v1')) {
        const svc = this.deps.host.getServiceByInstance<SessionDataServiceV1>(provider.instanceId, 'session.data.v1');
        if (!svc) continue;
        const res = await svc.getSession({ sessionId });
        if (res.ok && res.value.session) {
          return { session: fromSessionRecordDto(res.value.session), service: svc, instanceId: provider.instanceId };
        }
      }
    }
    throw new PluginApiError('E_INVALID_INPUT', `会话不存在: ${sessionId}`);
  }

  private async getSessionOrThrow(sessionId: unknown): Promise<Session> {
    const resolved = await this.resolveSessionWithProvider(sessionId);
    return resolved.session;
  }

  private readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private resolveServiceWithFallback(
    contract: string,
    options: ResolveServiceSelectionOptions,
  ): ServiceResolutionV1 {
    if (this.deps.resolveServiceSelection) {
      return this.deps.resolveServiceSelection(contract, options);
    }
    const versionRange = options.versionRange ?? '*';
    const providers = this.deps.host.listServiceProviders(contract);
    const candidates = providers.map(({ instanceId, pluginId, version }) => ({ instanceId, pluginId, version }));
    const boundId = options.explicitInstanceId
      ?? (options.callerInstanceId ? this.deps.host.getInstanceBinding(options.callerInstanceId, contract) : undefined)
      ?? this.deps.host.getDefaultBindings()[contract];
    const source = options.explicitInstanceId
      ? 'explicit'
      : (options.callerInstanceId && this.deps.host.getInstanceBinding(options.callerInstanceId, contract))
        ? 'dependency'
        : this.deps.host.getDefaultBindings()[contract]
          ? 'composition'
          : undefined;
    if (boundId && source) {
      const ready = candidates.some((c) => c.instanceId === boundId);
      return {
        contract,
        versionRange,
        instanceId: boundId,
        source,
        status: ready ? 'ready' : 'unavailable',
        candidates,
      };
    }
    if (candidates.length === 0) {
      return { contract, versionRange, instanceId: null, source: 'none', status: 'unconfigured', candidates: [] };
    }
    if (candidates.length === 1 && options.allowSingleCandidate) {
      return { contract, versionRange, instanceId: candidates[0]!.instanceId, source: 'single', status: 'ready', candidates };
    }
    return { contract, versionRange, instanceId: null, source: 'none', status: 'selection_required', candidates };
  }

  private async getWorkspaceOrThrow(workspaceId: unknown): Promise<Workspace> {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new PluginApiError('E_INVALID_INPUT', '缺少 workspaceId');
    const access = this.resolveSessionDataAccess({ workspaceId });
    if (access.mode === 'legacy_store') {
      const workspace = this.deps.store.getWorkspace(workspaceId);
      if (!workspace) throw new PluginApiError('E_INVALID_INPUT', `工作区不存在: ${workspaceId}`);
      return workspace;
    }
    if (access.mode === 'peer') {
      const res = await access.service.getWorkspace({ workspaceId });
      if (res.ok && res.value.workspace) {
        return fromWorkspaceDto(res.value.workspace);
      }
    } else {
      for (const provider of this.deps.host.listServiceProviders('session.data.v1')) {
        const svc = this.deps.host.getServiceByInstance<SessionDataServiceV1>(provider.instanceId, 'session.data.v1');
        if (!svc) continue;
        const res = await svc.getWorkspace({ workspaceId });
        if (res.ok && res.value.workspace) {
          return fromWorkspaceDto(res.value.workspace);
        }
      }
    }
    throw new PluginApiError('E_INVALID_INPUT', `工作区不存在: ${workspaceId}`);
  }

  async handle(
    method: string,
    params: Record<string, unknown>,
    meta: { pluginId: string; instanceId?: string; runId: string },
  ): Promise<unknown> {
    const instanceId = meta.instanceId ?? meta.pluginId;
    if (!this.deps.isCurrentRun(instanceId, meta.runId)) {
      throw new PluginApiError('E_STALE_RUN', '插件实例标识已过期');
    }
    const plugin = this.deps.getPluginInfo(instanceId) ?? this.deps.getPluginInfo(meta.pluginId);
    if (!plugin) throw new PluginApiError('E_STALE_RUN', '插件未加载');

    switch (method) {
      case 'log': {
        const level = params.level === 'debug' || params.level === 'warn' || params.level === 'error' ? params.level : 'info';
        this.appendLog({
          timestamp: Date.now(),
          pluginId: meta.pluginId,
          runId: meta.runId,
          level,
          message: String(params.message ?? '').slice(0, 2000),
          meta: params.meta && typeof params.meta === 'object' ? params.meta as Record<string, unknown> : undefined,
        });
        return { ok: true };
      }

      case 'events.subscribe':
      case 'events.unsubscribe': {
        if (typeof params.event === 'string') {
          this.deps.onSubscriptionChange?.(instanceId, meta.runId, params.event, method === 'events.subscribe');
        }
        return { ok: true };
      }

      case 'service.unprovide':
        if (typeof params.name === 'string') this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'service', params.name);
        return { ok: true };
      case 'commands.unregister':
        if (typeof params.command === 'string') this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'command', params.command);
        return { ok: true };
      case 'tools.unregister':
        if (typeof params.name === 'string') this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'tool', params.name);
        return { ok: true };
      case 'handoff.section.unregister':
        if (typeof params.id === 'string') this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'section', params.id);
        return { ok: true };
      case 'slots.unregister':
        if (typeof params.slot === 'string' && typeof params.id === 'string') {
          this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'slot', `${params.slot}:${params.id}`);
        }
        return { ok: true };
      case 'routes.unregister': {
        const routePath = typeof params.path === 'string'
          ? params.path
          : (typeof params.pathPrefix === 'string' ? params.pathPrefix : undefined);
        if (routePath) {
          this.deps.onDynamicUnregister?.(instanceId, meta.runId, 'route', routePath);
        }
        return { ok: true };
      }

      case 'services.list': {
        const contract = typeof params.contract === 'string' && params.contract.trim() ? params.contract.trim() : undefined;
        return this.deps.host.listServiceProviders(contract).map(({ pluginId, instanceId: provId, contract: c, version, metadata }) => ({
          pluginId,
          instanceId: provId,
          contract: c,
          version,
          ...(metadata ? { metadata } : {}),
        }));
      }

      case 'services.resolve': {
        const contract = typeof params.contract === 'string' ? params.contract.trim() : '';
        if (!contract) throw new PluginApiError('E_INVALID_INPUT', '缺少服务契约名');
        if (isReservedServiceName(contract)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `隔离插件不能直接解析内部服务 ${contract}`);
        }
        return this.resolveServiceWithFallback(contract, {
          callerInstanceId: instanceId,
          explicitInstanceId: this.readOptionalString(params.explicitInstanceId) ?? this.readOptionalString(params.instanceId),
          versionRange: this.readOptionalString(params.versionRange),
          sessionId: this.readOptionalString(params.sessionId),
          workspaceId: this.readOptionalString(params.workspaceId),
          allowSingleCandidate: params.allowSingleCandidate === true,
        });
      }

      case 'services.call': {
        const contract = String(params.contract ?? '');
        const fnName = String(params.method ?? '');
        const args = Array.isArray(params.args) ? params.args : [];
        const targetInstanceId = this.readOptionalString(params.instanceId);
        const explicitInstanceId = this.readOptionalString(params.explicitInstanceId) ?? targetInstanceId;
        const versionRange = this.readOptionalString(params.versionRange);
        const sessionId = this.readOptionalString(params.sessionId);
        const workspaceId = this.readOptionalString(params.workspaceId);
        const allowSingleCandidate = typeof params.allowSingleCandidate === 'boolean' ? params.allowSingleCandidate : undefined;
        const useNewResolution =
          versionRange !== undefined
          || sessionId !== undefined
          || workspaceId !== undefined
          || allowSingleCandidate !== undefined
          || this.readOptionalString(params.explicitInstanceId) !== undefined;

        if (!contract || !fnName) throw new PluginApiError('E_INVALID_INPUT', '缺少服务契约名或方法名');
        if (isReservedServiceName(contract) || isHostHarnessOperation(contract, fnName)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `隔离插件不能直接调用内部服务 ${contract}`);
        }
        if (useNewResolution) {
          const resolution = this.resolveServiceWithFallback(contract, {
            callerInstanceId: instanceId,
            explicitInstanceId,
            versionRange,
            sessionId,
            workspaceId,
            allowSingleCandidate,
          });
          if (resolution.status !== 'ready') {
            throw new PluginApiError(
              serviceResolutionErrorCode(resolution.status),
              `服务 ${contract} 不可用 (${resolution.status})`,
            );
          }
          const service = this.deps.host.getServiceByInstance<Record<string, unknown>>(resolution.instanceId, contract);
          if (!service) {
            throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${contract}@${resolution.instanceId} 不可用`);
          }
          const fn = service[fnName];
          if (typeof fn !== 'function') {
            throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${contract}.${fnName} 不存在`);
          }
          return await fn(...args);
        }
        const service = this.deps.host.resolveServiceFor<Record<string, unknown>>(instanceId, contract, targetInstanceId);
        if (!service) {
          throw new PluginApiError(
            'E_SERVICE_UNAVAILABLE',
            targetInstanceId ? `服务 ${contract}@${targetInstanceId} 不可用` : `服务 ${contract} 不可用`,
          );
        }
        const fn = service[fnName];
        if (typeof fn !== 'function') {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${contract}.${fnName} 不存在`);
        }
        return await fn(...args);
      }

      case 'services.publish': {
        const contract = typeof params.contract === 'string' ? params.contract.trim() : '';
        if (!contract) throw new PluginApiError('E_INVALID_INPUT', '缺少服务契约名');
        const ownerRecord = this.deps.host.getServiceRecordByInstance(instanceId, contract);
        if (!ownerRecord) {
          throw new PluginApiError('E_PERMISSION_DENIED', `实例 ${instanceId} 未处于活动提供 ${contract} 的状态`);
        }
        const payload = params.payload && typeof params.payload === 'object' && !Array.isArray(params.payload)
          ? params.payload as Record<string, unknown>
          : {};
        this.deps.host.publishServiceChannel(contract, instanceId, payload);
        return { ok: true };
      }

      case 'services.subscribe':
      case 'services.unsubscribe': {
        const contract = typeof params.contract === 'string' ? params.contract.trim() : '';
        if (!contract) throw new PluginApiError('E_INVALID_INPUT', '缺少服务契约名');
        this.deps.onServiceChannelSubscriptionChange?.(
          instanceId,
          meta.runId,
          contract,
          method === 'services.subscribe',
        );
        return { ok: true };
      }

      case 'service.call': {
        const serviceName = String(params.service ?? '');
        const fnName = String(params.method ?? '');
        const args = Array.isArray(params.args) ? params.args : [];
        if (!serviceName || !fnName) throw new PluginApiError('E_INVALID_INPUT', '缺少服务名或方法名');
        if (serviceName === 'harness' || serviceName.startsWith('harness.') || serviceName === 'mcpHub' || serviceName === 'remote'
          || isHostHarnessOperation(serviceName, fnName)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `隔离插件不能直接调用内部服务 ${serviceName}`);
        }
        const service = this.deps.host.resolveServiceFor<Record<string, unknown>>(instanceId, serviceName);
        if (!service) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${serviceName} 不可用`);
        if (serviceName === 'ledger') {
          return this.handleLedgerServiceCall(plugin, meta, fnName, args);
        }
        if (serviceName === 'git') {
          return this.handleGitServiceCall(plugin, fnName, args);
        }
        if (serviceName === 'handoff' || serviceName === 'usage' || serviceName === 'native-commands' || serviceName === 'failover') {
          throw new PluginApiError('E_PERMISSION_DENIED', `请使用对应的公共 ctx API 访问 ${serviceName}`);
        }
        // Third-party provided service: invoke across process boundary via proxy!
        const fn = service[fnName];
        if (typeof fn !== 'function') {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${serviceName}.${fnName} 不存在`);
        }
        return await fn(...args);
      }

      case 'events.query': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const requestedTypes = Array.isArray(params.types) ? (params.types as PluginEventName[]) : undefined;
        const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? Math.max(0, Math.floor(params.afterSeq)) : 0;
        const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.min(200, Math.max(1, Math.floor(params.limit))) : 50;
        let raw: CanonicalEvent[];
        if (resolved.service) {
          const peerRes = await resolved.service.listEvents({ sessionId: session.id, afterSeq, limit: limit * 4 });
          if (!peerRes.ok) {
            const code = peerRes.error.code === 'permission_denied' ? 'E_PERMISSION_DENIED' : 'E_SERVICE_UNAVAILABLE';
            throw new PluginApiError(code, peerRes.error.message);
          }
          raw = peerRes.value.events.map((ev) => ({
            sessionId: ev.sessionId,
            seq: ev.seq,
            type: ev.type as CanonicalEventType,
            turnId: ev.turnId,
            payload: ev.payload,
            createdAt: ev.createdAt,
          }));
        } else {
          raw = this.deps.store.getEventsAfter(session.id, afterSeq, limit * 4);
        }
        const mapped: PluginEventV4[] = [];
        for (const ev of raw) {
          const dto = toPluginEvent(ev);
          if (!dto) continue;
          if (requestedTypes && !requestedTypes.includes(dto.type)) continue;
          const perm = pluginEventContracts[dto.type]?.permission;
          if (perm && !this.deps.permissions.isGranted(plugin, perm, session.workspaceId)) continue;
          mapped.push(dto);
          if (mapped.length >= limit) break;
        }
        return mapped;
      }

      case 'sessions.list': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        const harnessId = typeof params.harnessId === 'string' ? params.harnessId : undefined;
        const access = this.resolveSessionDataAccess(workspaceId ? { workspaceId } : undefined);
        let list: Session[] = [];
        if (access.mode === 'legacy_store') {
          list = this.deps.store.listSessions({ workspaceId, harnessId });
        } else if (access.mode === 'peer') {
          const res = await access.service.listSessions({ workspaceId, harnessId });
          list = res.ok ? res.value.sessions.map(fromSessionRecordDto) : [];
        } else {
          for (const provider of this.deps.host.listServiceProviders('session.data.v1')) {
            const svc = this.deps.host.getServiceByInstance<SessionDataServiceV1>(provider.instanceId, 'session.data.v1');
            if (!svc) continue;
            const res = await svc.listSessions({ workspaceId, harnessId });
            if (res.ok) list.push(...res.value.sessions.map(fromSessionRecordDto));
          }
        }
        if (workspaceId) {
          this.deps.permissions.assertGranted(plugin, 'session:read', workspaceId);
          return list.map(toPublicSession);
        }
        const allowed = list.filter((session) => this.deps.permissions.isGranted(plugin, 'session:read', session.workspaceId));
        if (allowed.length === 0 && list.length > 0) {
          throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得权限 session:read`);
        }
        return allowed.map(toPublicSession);
      }

      case 'sessions.get': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        return toPublicSession(session);
      }

      case 'sessions.capabilities': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const registry = this.deps.host.getRegistryBridge();
        const resolved = registry?.resolveAdapter({
          harnessId: session.harnessId,
          driverId: session.harnessKind,
        });
        const adapter = resolved?.adapter;
        const caps: PublicSessionCapabilities = {
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          supportsAttachments: adapter ? adapter.capabilities.imageInput : true,
          supportsNativeCommands: Boolean(
            this.deps.host.get('native-commands')
            && (adapter?.supportedCommands?.some((c) => c.supported) ?? (adapter?.capabilitiesV2?.nativeCommands?.length ?? 0) > 0),
          ),
          supportsModelTools: Boolean(
            adapter?.pluginMcpTransport
            ?? (session.harnessKind === 'codex' || session.harnessKind === 'claude' || session.harnessKind === 'agy' || session.harnessKind === 'acp'),
          ),
        };
        return caps;
      }

      case 'sessions.prepareTurn': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:send', session.workspaceId);
        const text = typeof params.text === 'string' ? params.text : '';
        if (!text.trim() || text.length > 100_000) throw new PluginApiError('E_INVALID_INPUT', '轮次内容无效');
        const parts = Array.isArray(params.parts)
          ? (params.parts as Array<{ label?: unknown; text?: unknown }>)
              .filter((p) => typeof p?.label === 'string' && typeof p?.text === 'string')
              .map((p) => ({ label: String(p.label).slice(0, 80), text: String(p.text).slice(0, 12_000) }))
          : undefined;
        const list = this.preparedTurns.get(session.id) ?? [];
        list.push({ pluginId: meta.pluginId, text, parts, createdAt: Date.now() });
        this.preparedTurns.set(session.id, list.slice(-10));
        return { accepted: true };
      }

      case 'sessions.runNative': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:command', session.workspaceId);
        const parsedCmd = PluginNativeCommandSchema.safeParse(params.command);
        if (!parsedCmd.success) throw new PluginApiError('E_INVALID_INPUT', '仅允许调用白名单原生命令');
        if (!this.deps.runNativeCommand) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用原生命令桥接');
        const args = typeof params.args === 'string' ? params.args.slice(0, 2_000) : undefined;
        return await this.deps.runNativeCommand(session.id, parsedCmd.data, args);
      }

      case 'sessions.listItems': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const opts = params as unknown as ListSessionItemsOptions;
        const afterSeq = typeof opts.afterSeq === 'number' && Number.isFinite(opts.afterSeq)
          ? Math.max(0, Math.floor(opts.afterSeq))
          : undefined;
        const beforeSeq = typeof opts.beforeSeq === 'number' && Number.isFinite(opts.beforeSeq)
          ? Math.max(0, Math.floor(opts.beforeSeq))
          : undefined;
        const types = Array.isArray(opts.types)
          ? opts.types.filter((t): t is string => typeof t === 'string' && t.length > 0)
          : undefined;
        const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit)
          ? Math.min(200, Math.max(1, Math.floor(opts.limit)))
          : 50;
        const includeOmittedBodies = opts.includeOmittedBodies === true;
        if (resolved.service) {
          const peerRes = await resolved.service.listTurnItems({
            sessionId: session.id,
            afterSeq,
            beforeSeq,
            blockTypes: types && types.length > 0 ? types : undefined,
            limit,
          });
          if (!peerRes.ok) {
            throw new PluginApiError('E_SERVICE_UNAVAILABLE', peerRes.error.message);
          }
          return {
            items: peerRes.value.items.map((item) => (!includeOmittedBodies && item.outputOmitted && item.textBody.length > 512
              ? { ...item, textBody: item.textBody.slice(0, 512) }
              : item)),
            nextSeq: peerRes.value.nextSeq,
          };
        }
        const raw = this.deps.store.listTurnItems(session.id, {
          afterSeq,
          blockTypes: types && types.length > 0 ? types : undefined,
          limit: 2000,
        });
        const filtered = beforeSeq !== undefined ? raw.filter((item) => item.seq < beforeSeq) : raw;
        const sliced = filtered.slice(0, limit);
        const nextSeq = filtered.length > limit && sliced.length > 0 ? sliced[sliced.length - 1]!.seq : null;
        return {
          items: sliced.map((item) => toPublicTurnBlock(item, !includeOmittedBodies)),
          nextSeq,
        };
      }

      case 'sessions.getItem': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        if (!itemId) throw new PluginApiError('E_INVALID_INPUT', '缺少 itemId');
        const opts = params as unknown as GetSessionItemOptions;
        const hasSliceOpts = opts.textOffset !== undefined || opts.maxChars !== undefined;
        const offset = typeof opts.textOffset === 'number' && Number.isFinite(opts.textOffset)
          ? Math.max(0, Math.floor(opts.textOffset))
          : 0;
        const maxChars = typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars)
          ? Math.min(64_000, Math.max(1, Math.floor(opts.maxChars)))
          : 16_000;
        if (resolved.service) {
          const peerRes = await resolved.service.getTurnItem({
            sessionId: session.id,
            itemId,
            ...(hasSliceOpts ? { textOffset: offset, maxChars } : {}),
          });
          if (!peerRes.ok) {
            const code = peerRes.error.code === 'permission_denied' ? 'E_PERMISSION_DENIED' : 'E_SERVICE_UNAVAILABLE';
            throw new PluginApiError(code, peerRes.error.message);
          }
          if (!peerRes.value) return null;
          return {
            item: peerRes.value.item,
            bodyChunk: peerRes.value.text,
            nextTextOffset: peerRes.value.nextTextOffset,
          };
        }
        const item = this.deps.store.getTurnItem(itemId);
        if (!item) return null;
        if (item.sessionId !== session.id) {
          throw new PluginApiError('E_PERMISSION_DENIED', '无权读取其他会话的 TurnItem');
        }
        if (hasSliceOpts) {
          const bodyChunk = item.textBody.slice(offset, offset + maxChars);
          const nextTextOffset = offset + maxChars < item.textBody.length ? offset + maxChars : null;
          return {
            item: toPublicTurnBlock(item, false),
            bodyChunk,
            nextTextOffset,
          };
        }
        return {
          item: toPublicTurnBlock(item, false),
          bodyChunk: item.textBody,
          nextTextOffset: null,
        };
      }

      case 'sessions.getBindings': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        if (resolved.service) {
          const peerRes = await resolved.service.listHarnessBindings({ sessionId: session.id });
          if (!peerRes.ok) {
            const code = peerRes.error.code === 'permission_denied' ? 'E_PERMISSION_DENIED' : 'E_SERVICE_UNAVAILABLE';
            throw new PluginApiError(code, peerRes.error.message);
          }
          return peerRes.value.bindings.map((b) => ({
            sessionId: b.sessionId,
            harnessId: b.harnessId,
            harnessKind: b.harnessKind,
            nativeSessionId: b.nativeSessionId,
            lastModel: b.lastModel ?? null,
            lastActualModel: b.lastActualModel ?? null,
            lastEffort: b.lastEffort ?? null,
            syncedUpToSeq: b.syncedUpToSeq,
            driverUsed: b.driverUsed ?? null,
            updatedAt: b.updatedAt,
          }));
        }
        return this.deps.store.listSessionBindings(session.id).map(toPublicBinding);
      }

      case 'sessions.fork': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const source = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:fork', source.workspaceId);
        const opts = params as unknown as ForkSessionOptions;
        const targetId = typeof opts.targetInstanceId === 'string' && opts.targetInstanceId.trim()
          ? opts.targetInstanceId.trim()
          : source.harnessId;
        const registry = this.deps.host.getRegistryBridge();
        const targetAdapter = registry?.get(targetId);
        if (registry && !targetAdapter) {
          throw new PluginApiError('E_INVALID_INPUT', `目标 Harness 实例不存在: ${targetId}`);
        }
        const targetKind = targetAdapter?.kind ?? (targetId === source.harnessId ? source.harnessKind : null);
        if (!targetKind) {
          throw new PluginApiError('E_INVALID_INPUT', `无法解析目标 Harness 类型: ${targetId}`);
        }
        let cwd = source.cwd;
        let worktreeBranch = source.worktreeBranch ?? null;
        if (opts.createWorktree === true) {
          this.deps.permissions.assertGranted(plugin, 'workspace:git:write', source.workspaceId);
          const workspace = await this.getWorkspaceOrThrow(source.workspaceId);
          const branchName = `fork-${Date.now()}`;
          const gitResolution = this.resolveServiceWithFallback(PEER_CONTRACTS.gitWorkspace, {
            callerInstanceId: instanceId,
            sessionId: source.id,
            workspaceId: source.workspaceId,
            allowSingleCandidate: true,
          });
          if (gitResolution.status === 'ready') {
            const peerGit = this.deps.host.getServiceByInstance<GitWorkspaceServiceV1>(
              gitResolution.instanceId,
              PEER_CONTRACTS.gitWorkspace,
            );
            if (peerGit && typeof peerGit.createWorktree === 'function') {
              const wtRes = await peerGit.createWorktree({ repoRoot: workspace.rootPath, branchName });
              if (!wtRes.ok) {
                throw new PluginApiError('E_SERVICE_UNAVAILABLE', wtRes.error.message);
              }
              cwd = wtRes.value.worktreePath;
              worktreeBranch = wtRes.value.branch;
            }
          }
          if (cwd === source.cwd) {
            const git = this.deps.host.get<GitService>('git');
            if (!git?.worktree) {
              throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'git worktree 服务不可用');
            }
            const wt = await git.worktree(workspace.rootPath, branchName);
            cwd = wt.worktreePath;
            worktreeBranch = wt.branch;
          }
        }
        const now = Date.now();
        const forkedTitle = typeof opts.title === 'string' && opts.title.trim()
          ? opts.title.trim().slice(0, 120)
          : `分支 · ${source.title}`;
        let forkedSession: Session;
        if (resolved.service) {
          const createdRes = await resolved.service.createSession({
            session: {
              id: randomUUID(),
              workspaceId: source.workspaceId,
              harnessId: targetId,
              harnessKind: targetKind,
              nativeSessionId: null,
              participatingHarnesses: [targetId],
              contextSyncMode: source.contextSyncMode,
              cwd,
              worktreeBranch,
              title: forkedTitle,
              status: 'idle',
              model: targetId === source.harnessId ? source.model : null,
              actualModel: null,
              modelReroutedReason: null,
              reasoningEffort: targetId === source.harnessId ? source.reasoningEffort : null,
              permissionMode: source.permissionMode,
              lastSeq: 0,
              usage: null,
              pendingApprovalCount: 0,
              createdAt: now,
              updatedAt: now,
            },
          });
          if (!createdRes.ok) throw new PluginApiError('E_SERVICE_UNAVAILABLE', createdRes.error.message);
          forkedSession = fromSessionRecordDto(createdRes.value.session);
          if (resolved.instanceId) {
            this.deps.store.upsertResourceOwner({
              resourceType: 'session',
              resourceId: forkedSession.id,
              contract: 'session.data.v1',
              instanceId: resolved.instanceId,
              workspaceId: forkedSession.workspaceId,
            });
          }
        } else {
          forkedSession = this.deps.store.createSession({
            id: randomUUID(),
            workspaceId: source.workspaceId,
            harnessId: targetId,
            harnessKind: targetKind,
            nativeSessionId: null,
            participatingHarnesses: [targetId],
            contextSyncMode: source.contextSyncMode,
            cwd,
            worktreeBranch,
            title: forkedTitle,
            status: 'idle',
            model: targetId === source.harnessId ? source.model : null,
            actualModel: null,
            modelReroutedReason: null,
            reasoningEffort: targetId === source.harnessId ? source.reasoningEffort : null,
            permissionMode: source.permissionMode,
            lastSeq: 0,
            usage: null,
            pendingApprovalCount: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
        const sourceLedger = this.deps.store.getTaskState(source.id);
        if (sourceLedger) {
          this.deps.store.upsertTaskState({
            ...sourceLedger,
            sessionId: forkedSession.id,
            version: 1,
            ledgerFilePath: null,
            updatedAt: now,
          });
        }
        return toPublicSession(forkedSession);
      }

      case 'sessions.switchInstance': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:switch', session.workspaceId);
        if (session.status === 'running' || session.status === 'awaiting_approval') {
          throw new PluginApiError('E_CONFLICT', '会话正在运行或等待审批，无法切换实例');
        }
        const opts = params as unknown as SwitchSessionInstanceOptions;
        const targetId = typeof opts.targetInstanceId === 'string' ? opts.targetInstanceId.trim() : '';
        if (!targetId) throw new PluginApiError('E_INVALID_INPUT', '缺少 targetInstanceId');
        const registry = this.deps.host.getRegistryBridge();
        const targetAdapter = registry?.get(targetId);
        if (!targetAdapter) {
          throw new PluginApiError('E_INVALID_INPUT', `目标 Harness 实例不存在: ${targetId}`);
        }
        const targetDriverId = targetAdapter.driverId ?? targetAdapter.kind;
        if (targetDriverId === 'agy' && targetAdapter.providerInstanceId) {
          const agyRuntime = this.deps.host.getServiceByInstance<AgyRuntimeServiceV1>(
            targetAdapter.providerInstanceId,
            AGY_RUNTIME_CONTRACT,
          );
          if (agyRuntime?.verifyDispatchProvenance) {
            const check = await agyRuntime.verifyDispatchProvenance({
              harnessId: targetAdapter.id,
              driverId: targetDriverId,
              provenance: {
                channel: 'plugin_automated',
                actor: 'plugin',
                issuedAt: Date.now(),
                reason: 'sessions.switchInstance',
                verifiedByHost: true,
              },
            });
            if (check.ok && !check.value.allowed) {
              throw new PluginApiError('E_PERMISSION_DENIED', check.value.reason ?? 'AGY switch provenance denied');
            }
          }
        }
        const forceFresh = opts.forceFreshNativeSession === true;
        if (resolved.service) {
          const existingRes = await resolved.service.getHarnessBinding({ sessionId: session.id, harnessId: targetAdapter.id });
          const existingBinding = existingRes.ok ? existingRes.value.binding : null;
          const nextNativeSessionId = forceFresh ? null : (existingBinding?.nativeSessionId ?? null);
          const participating = Array.from(
            new Set([...(session.participatingHarnesses ?? []), session.harnessId, targetAdapter.id]),
          );
          const commitRes = await resolved.service.commitBatch({
            sessionId: session.id,
            sessionPatch: {
              harnessId: targetAdapter.id,
              harnessKind: targetAdapter.kind,
              nativeSessionId: nextNativeSessionId,
              participatingHarnesses: participating,
              status: session.status === 'error' ? 'idle' : session.status,
            },
            bindingUpsert: existingBinding
              ? (forceFresh
                  ? {
                      ...existingBinding,
                      nativeSessionId: null,
                      syncedUpToSeq: 0,
                      driverUsed: null,
                      updatedAt: Date.now(),
                    }
                  : {
                      ...existingBinding,
                      harnessKind: targetAdapter.kind,
                      updatedAt: Date.now(),
                    })
              : {
                  sessionId: session.id,
                  harnessId: targetAdapter.id,
                  harnessKind: targetAdapter.kind,
                  nativeSessionId: null,
                  lastModel: session.model,
                  lastActualModel: null,
                  lastEffort: session.reasoningEffort,
                  syncedUpToSeq: 0,
                  driverUsed: null,
                  updatedAt: Date.now(),
                },
            events: [{
              type: 'session.harness_switched',
              payload: {
                fromHarnessId: session.harnessId,
                fromHarnessKind: session.harnessKind,
                toHarnessId: targetAdapter.id,
                toHarnessKind: targetAdapter.kind,
                forceFreshNativeSession: forceFresh,
                initiatedByPlugin: meta.pluginId,
              },
            }],
          });
          if (!commitRes.ok) throw new PluginApiError('E_SERVICE_UNAVAILABLE', commitRes.error.message);
          return { ok: true };
        }
        const existingBinding = this.deps.store.getSessionBinding(session.id, targetAdapter.id);
        const nextNativeSessionId = forceFresh ? null : (existingBinding?.nativeSessionId ?? null);
        const participating = Array.from(
          new Set([...(session.participatingHarnesses ?? []), session.harnessId, targetAdapter.id]),
        );
        this.deps.store.updateSession(session.id, {
          harnessId: targetAdapter.id,
          harnessKind: targetAdapter.kind,
          nativeSessionId: nextNativeSessionId,
          participatingHarnesses: participating,
          status: session.status === 'error' ? 'idle' : session.status,
        });
        if (existingBinding) {
          if (forceFresh) {
            this.deps.store.setSessionBindingExact(session.id, targetAdapter.id, {
              nativeSessionId: null,
              syncedUpToSeq: 0,
              driverUsed: null,
            });
          } else {
            this.deps.store.upsertSessionBinding({
              ...existingBinding,
              harnessKind: targetAdapter.kind,
              updatedAt: Date.now(),
            });
          }
        } else {
          this.deps.store.upsertSessionBinding({
            sessionId: session.id,
            harnessId: targetAdapter.id,
            harnessKind: targetAdapter.kind,
            nativeSessionId: null,
            lastModel: session.model,
            lastActualModel: null,
            lastEffort: session.reasoningEffort,
            syncedUpToSeq: 0,
            driverUsed: null,
            updatedAt: Date.now(),
          });
        }
        this.deps.store.appendEvent(session.id, 'session.harness_switched', {
          fromHarnessId: session.harnessId,
          fromHarnessKind: session.harnessKind,
          toHarnessId: targetAdapter.id,
          toHarnessKind: targetAdapter.kind,
          forceFreshNativeSession: forceFresh,
          initiatedByPlugin: meta.pluginId,
        });
        return { ok: true };
      }

      case 'sessions.postNotice': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:orchestrate', session.workspaceId);
        const notice = (params.notice ?? {}) as Partial<PublicSessionNotice>;
        if (notice.level !== 'info' && notice.level !== 'warn' && notice.level !== 'error') {
          throw new PluginApiError('E_INVALID_INPUT', '通知 level 必须为 info、warn 或 error');
        }
        const message = typeof notice.message === 'string' ? notice.message.trim() : '';
        if (!message || message.length > 2_000) {
          throw new PluginApiError('E_INVALID_INPUT', '通知内容必须为 1-2000 个字符');
        }
        const code = typeof notice.code === 'string' && notice.code.trim()
          ? notice.code.trim().slice(0, 80)
          : undefined;
        if (resolved.service) {
          const commitRes = await resolved.service.commitBatch({
            sessionId: session.id,
            events: [{
              type: 'handoff.system_notice',
              payload: {
                level: notice.level,
                message,
                ...(code ? { code } : {}),
                pluginId: meta.pluginId,
              },
            }],
          });
          if (!commitRes.ok) throw new PluginApiError('E_SERVICE_UNAVAILABLE', commitRes.error.message);
          return { ok: true };
        }
        this.deps.store.appendEvent(session.id, 'handoff.system_notice', {
          level: notice.level,
          message,
          ...(code ? { code } : {}),
          pluginId: meta.pluginId,
        });
        return { ok: true };
      }

      case 'handoff.preview': {
        const resolved = await this.resolveSessionWithProvider(params.sessionId);
        const session = resolved.session;
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const targetInstanceId = typeof params.targetInstanceId === 'string' && params.targetInstanceId.trim()
          ? params.targetInstanceId.trim()
          : session.harnessId;
        const registry = this.deps.host.getRegistryBridge();
        const targetAdapter = registry?.get(targetInstanceId);
        const targetKind = targetAdapter?.kind ?? (targetInstanceId === session.harnessId ? session.harnessKind : null);
        if (!targetKind) {
          throw new PluginApiError('E_INVALID_INPUT', `目标 Harness 实例不存在: ${targetInstanceId}`);
        }
        const compiler = this.deps.host.get<ContextCompiler>('handoff');
        if (!compiler) {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'handoff 服务不可用');
        }
        const binding = resolved.service
          ? await resolved.service.getHarnessBinding({ sessionId: session.id, harnessId: targetInstanceId }).then((r) => (r.ok && r.value.binding ? {
              sessionId: r.value.binding.sessionId,
              harnessId: r.value.binding.harnessId,
              harnessKind: r.value.binding.harnessKind,
              nativeSessionId: r.value.binding.nativeSessionId,
              lastModel: r.value.binding.lastModel ?? null,
              lastActualModel: r.value.binding.lastActualModel ?? null,
              lastEffort: r.value.binding.lastEffort ?? null,
              syncedUpToSeq: r.value.binding.syncedUpToSeq,
              driverUsed: (r.value.binding.driverUsed as SessionHarnessBinding['driverUsed']) ?? null,
              updatedAt: r.value.binding.updatedAt,
            } : null))
          : this.deps.store.getSessionBinding(session.id, targetInstanceId);
        const packet = await compiler.compile({
          session,
          targetHarnessId: targetInstanceId,
          targetHarnessKind: targetKind,
          binding,
        });
        const redactionSummary = handoffRedactionMap.get(packet);
        const result: ContextHandoffPreviewV2 = {
          sessionId: session.id,
          mode: packet.preview.isWarmBinding ? 'delta_since_target_last_seen' : 'full_session_summary',
          deliveryChannel: packet.preview.driverPlanned,
          sourceInstanceId: session.harnessId,
          targetInstanceId,
          coveredSeqRange: {
            fromSeq: packet.preview.syncedUpToSeq,
            toSeq: packet.coveredUpToSeq,
          },
          unsyncedTurnCount: packet.preview.unsyncedTurnCount,
          estimatedChars: packet.preview.compiledMarkdown.length,
          estimatedTokens: packet.preview.estimatedTokens,
          budgetTokens: packet.preview.budgetTokens,
          syncNeeded: packet.syncNeeded,
          ...(redactionSummary ? { redactionSummary } : {}),
          renderedPayload: packet.preview.compiledMarkdown,
        };
        return result;
      }

      case 'harnesses.listInstances': {
        const registry = this.deps.host.getRegistryBridge();
        if (!registry) return [];
        const entries = registry.listEntries();
        const result: PublicHarnessInstanceInfo[] = [];
        const coveredAdapters = new Set<object>();
        for (const entry of entries) {
          coveredAdapters.add(entry.adapter);
          result.push({
            id: entry.harnessId,
            driverId: entry.driverId,
            pluginId: entry.pluginId,
            providerInstanceId: entry.providerInstanceId,
            runId: entry.providerRunId,
            isDefault: entry.isDefault,
            displayName: entry.instanceConfig.displayName ?? entry.adapter.displayName,
            description: entry.instanceConfig.description ?? entry.adapter.description ?? '',
            protocolLabel: entry.adapter.protocolLabel ?? entry.driverId,
            enabled: entry.instanceConfig.enabled,
            isCustom: entry.adapter.isCustom,
            ...(entry.adapter.supportedCommands ? { supportedCommands: entry.adapter.supportedCommands } : {}),
          });
        }
        for (const inst of registry.listInstances()) {
          const adapter = registry.get(inst.instanceId);
          if (adapter && coveredAdapters.has(adapter)) continue;
          result.push({
            id: inst.instanceId,
            driverId: inst.driverId,
            ...(inst.providerPluginId ? { pluginId: inst.providerPluginId } : {}),
            ...(inst.providerInstanceId ? { providerInstanceId: inst.providerInstanceId } : {}),
            displayName: inst.displayName,
            description: inst.description ?? adapter?.description ?? '',
            protocolLabel: adapter?.protocolLabel ?? inst.driverId,
            enabled: inst.enabled,
            isCustom: adapter?.isCustom,
          });
        }
        return result;
      }

      case 'harnesses.openSession': {
        if (!this.deps.openHarnessSession) {
          throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用可撤销 Harness 会话租约');
        }
        const harnessId = typeof params.harnessId === 'string' ? params.harnessId.trim() : '';
        if (!harnessId) throw new PluginApiError('E_INVALID_INPUT', '缺少 harnessId');
        const config = (params.config && typeof params.config === 'object' ? params.config : {}) as AdapterSessionConfig;
        return await this.deps.openHarnessSession(plugin, instanceId, meta.runId, { harnessId, config });
      }

      case 'harnesses.session.sendTurn':
      case 'harnesses.session.steerTurn':
      case 'harnesses.session.interrupt':
      case 'harnesses.session.updateConfig':
      case 'harnesses.session.resolveApproval':
      case 'harnesses.session.dispose': {
        if (!this.deps.harnessSessionCall) {
          throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用可撤销 Harness 会话租约');
        }
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId.trim() : '';
        if (!leaseId) throw new PluginApiError('E_INVALID_INPUT', '缺少 leaseId');
        const op = method.slice('harnesses.session.'.length) as
          | 'sendTurn'
          | 'steerTurn'
          | 'interrupt'
          | 'updateConfig'
          | 'resolveApproval'
          | 'dispose';
        return await this.deps.harnessSessionCall(instanceId, meta.runId, leaseId, op, params);
      }

      case 'harnesses.registerDriver': {
        const driver = params.driver as PublicHarnessDriverDescriptor | undefined;
        if (!driver || typeof driver.driverId !== 'string') {
          throw new PluginApiError('E_INVALID_INPUT', '驱动描述符无效');
        }
        this.deps.onDriverRegister?.(instanceId, meta.runId, driver);
        return { ok: true };
      }

      case 'harnesses.unregisterDriver': {
        if (typeof params.driverId === 'string') {
          this.deps.onDriverUnregister?.(instanceId, meta.runId, params.driverId);
        }
        return { ok: true };
      }

      case 'driver.session.event': {
        const handleId = typeof params.handleId === 'string' ? params.handleId : '';
        const event = params.event && typeof params.event === 'object' ? params.event as Record<string, unknown> : null;
        if (handleId && event) {
          this.deps.onDriverSessionEvent?.(instanceId, meta.runId, handleId, event);
        }
        return { ok: true };
      }

      case 'runtime.spawnCli': {
        if (!this.deps.cliProcesses) {
          throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用 CLI 进程托管');
        }
        return await this.deps.cliProcesses.spawn(
          { ...plugin, id: instanceId },
          meta.runId,
          params as unknown as SpawnCliSpec,
          {
            onOutput: (processId, stream, chunk) => {
              this.deps.onCliOutput?.(instanceId, meta.runId, processId, stream, chunk);
            },
            onExit: (processId, code, signal) => {
              this.deps.onCliExit?.(instanceId, meta.runId, processId, code, signal);
            },
          },
        );
      }

      case 'runtime.cli.writeStdin': {
        if (!this.deps.cliProcesses) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用 CLI 进程托管');
        const processId = typeof params.processId === 'string' ? params.processId : '';
        const data = typeof params.data === 'string' ? params.data : '';
        this.deps.cliProcesses.writeStdin(instanceId, meta.runId, processId, data);
        return { ok: true };
      }

      case 'runtime.cli.closeStdin': {
        if (!this.deps.cliProcesses) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用 CLI 进程托管');
        const processId = typeof params.processId === 'string' ? params.processId : '';
        this.deps.cliProcesses.closeStdin(instanceId, meta.runId, processId);
        return { ok: true };
      }

      case 'runtime.cli.kill': {
        if (!this.deps.cliProcesses) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用 CLI 进程托管');
        const processId = typeof params.processId === 'string' ? params.processId : '';
        const signal = params.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
        await this.deps.cliProcesses.kill(instanceId, meta.runId, processId, signal);
        return { ok: true };
      }

      case 'ledger.get': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const ledger = this.deps.host.get<TaskLedgerService | Record<string, (...args: unknown[]) => unknown>>('ledger');
        if (!ledger) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 服务不可用');
        if ((ledger as { __thirdParty?: boolean }).__thirdParty) {
          const getter = (ledger as Record<string, (...args: unknown[]) => unknown>).get;
          if (typeof getter !== 'function') throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方缺少 get 方法');
          return await getter(session.id);
        }
        if (typeof (ledger as TaskLedgerService).getOrCreate === 'function') {
          return toPublicLedger((ledger as TaskLedgerService).getOrCreate(session));
        }
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方缺少 get 方法');
      }

      case 'ledger.append': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const entry = (params.entry ?? {}) as PublicTaskLedgerAppend;
        const ledger = this.deps.host.get<TaskLedgerService | Record<string, (...args: unknown[]) => unknown>>('ledger');
        if (!ledger) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 服务不可用');
        if ((ledger as { __thirdParty?: boolean }).__thirdParty) {
          const appender = (ledger as Record<string, (...args: unknown[]) => unknown>).append;
          if (typeof appender !== 'function') throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方不支持写入');
          return await appender(session.id, entry);
        }
        if (typeof (ledger as TaskLedgerService).getOrCreate === 'function' && typeof (ledger as TaskLedgerService).updateManual === 'function') {
          const current = (ledger as TaskLedgerService).getOrCreate(session);
          const updated = (ledger as TaskLedgerService).updateManual(session, {
            ...(entry.objective ? { objective: entry.objective } : {}),
            ...(entry.decision ? { decisions: [...current.decisions, entry.decision] } : {}),
            ...(entry.blocker ? { blockers: [...current.blockers, entry.blocker] } : {}),
            ...(entry.pinnedFact ? { pinnedFacts: [...current.pinnedFacts, entry.pinnedFact] } : {}),
            ...(entry.step ? {
              steps: [
                ...current.steps,
                { id: `step_${Date.now()}`, title: entry.step.title, status: entry.step.status ?? 'pending', updatedAt: Date.now() },
              ],
            } : {}),
          });
          return toPublicLedger(updated);
        }
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方不支持写入');
      }

      case 'composer.suggest': {
        const session = await this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'composer:suggest', session.workspaceId);
        const suggestion = (params.suggestion ?? {}) as PublicComposerSuggestion;
        const list = this.pendingSuggestions.get(session.id) ?? [];
        list.push({ pluginId: meta.pluginId, suggestion, createdAt: Date.now() });
        this.pendingSuggestions.set(session.id, list.slice(-10));
        this.deps.onComposerSuggest?.(meta.pluginId, session.id, suggestion);
        return { ok: true };
      }

      case 'approvals.annotate': {
        const approvalId = typeof params.approvalId === 'string' ? params.approvalId : '';
        const approval = approvalId ? this.deps.store.getApproval(approvalId) : null;
        if (!approval) throw new PluginApiError('E_INVALID_INPUT', '审批项不存在');
        const session = await this.getSessionOrThrow(approval.sessionId);
        this.deps.permissions.assertGranted(plugin, 'approvals:annotate', session.workspaceId);
        const providers = this.deps.host.listServiceProviders('runtime.requests.internal');
        for (const provider of providers) {
          const requests = this.deps.host.getServiceByInstance<{
            get(id: string): unknown;
            addAnnotation(id: string, pluginId: string, note: PublicApprovalAnnotationInput): void;
          }>(provider.instanceId, 'runtime.requests.internal');
          if (!requests?.get(approvalId)) continue;
          requests.addAnnotation(approvalId, meta.pluginId, (params.note ?? {}) as PublicApprovalAnnotationInput);
          return { ok: true };
        }
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '原请求提供方不可用');
      }

      case 'storage.plugin.get':
      case 'storage.plugin.set':
      case 'storage.plugin.delete':
      case 'storage.plugin.keys': {
        this.deps.permissions.assertGranted(plugin, 'storage:plugin');
        return this.handleStorage('plugin', instanceId, method.slice('storage.plugin.'.length), params);
      }

      case 'storage.workspace.get':
      case 'storage.workspace.set':
      case 'storage.workspace.delete':
      case 'storage.workspace.keys': {
        const workspace = await this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'storage:workspace', workspace.id);
        return this.handleStorage(`workspace:${workspace.id}`, instanceId, method.slice('storage.workspace.'.length), params);
      }

      case 'fs.read': {
        const workspace = await this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new PluginApiError('E_INVALID_INPUT', '目标不是普通文件');
        if (stat.size > MAX_FS_BYTES) throw new PluginApiError('E_LIMIT_EXCEEDED', '文件超过读取大小限制');
        return fs.readFileSync(fullPath, 'utf8');
      }

      case 'fs.list': {
        const workspace = await this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath, rel } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) throw new PluginApiError('E_INVALID_INPUT', '目标不是目录');
        const entries: PublicFsEntry[] = [];
        for (const entry of fs.readdirSync(fullPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name === '.git') continue;
          const entryPath = path.join(fullPath, entry.name);
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          let sizeBytes = 0;
          try { sizeBytes = entry.isFile() ? fs.statSync(entryPath).size : 0; } catch { continue; }
          entries.push({ name: entry.name, relativePath: entryRel, isDirectory: entry.isDirectory(), sizeBytes });
          if (entries.length >= 500) break;
        }
        return entries;
      }

      case 'fs.stat': {
        const workspace = await this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath, rel } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        const result: PublicFsStat = {
          relativePath: rel,
          isDirectory: stat.isDirectory(),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        return result;
      }

      case 'fs.write': {
        const workspace = await this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:write', workspace.id);
        const content = typeof params.content === 'string' ? params.content : null;
        if (content === null) throw new PluginApiError('E_INVALID_INPUT', '写入内容必须为字符串');
        if (Buffer.byteLength(content, 'utf8') > MAX_FS_BYTES) {
          throw new PluginApiError('E_LIMIT_EXCEEDED', '写入文件超过大小限制');
        }
        const { fullPath } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), false);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return { ok: true };
      }

      case 'net.fetch': {
        const rawUrl = typeof params.url === 'string' ? params.url : '';
        let parsedUrl: URL;
        try { parsedUrl = new URL(rawUrl); } catch {
          throw new PluginApiError('E_INVALID_INPUT', '无效的请求 URL');
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new PluginApiError('E_INVALID_INPUT', '仅支持 http/https 协议');
        }
        const host = parsedUrl.hostname.toLowerCase();
        const capability = `net:${host}`;
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        const granted = workspaceId
          ? this.deps.permissions.isGranted(plugin, capability, workspaceId)
          : this.deps.permissions.isGranted(plugin, capability) ||
            this.deps.store.listWorkspaces().some((ws) => this.deps.permissions.isGranted(plugin, capability, ws.id));
        if (!granted) {
          throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得网络权限 ${capability}`);
        }
        const init = (params.init ?? {}) as PublicNetInit;
        const controller = new AbortController();
        const timeout = Math.min(60_000, Math.max(500, init.timeoutMs ?? 10_000));
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(parsedUrl.toString(), {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
            signal: controller.signal,
          });
          const buf = Buffer.from(await response.arrayBuffer());
          if (buf.length > MAX_NET_BYTES) throw new PluginApiError('E_LIMIT_EXCEEDED', '响应体超过 2 MiB 限制');
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          const out: PublicNetResponse = {
            status: response.status,
            ok: response.ok,
            headers,
            body: buf.toString('utf8'),
          };
          return out;
        } finally {
          clearTimeout(timer);
        }
      }

      case 'net.stream.open': {
        const rawUrl = typeof params.url === 'string' ? params.url : '';
        let parsedUrl: URL;
        try { parsedUrl = new URL(rawUrl); } catch {
          throw new PluginApiError('E_INVALID_INPUT', '无效的流式请求 URL');
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new PluginApiError('E_INVALID_INPUT', '仅支持 http/https 协议');
        }
        const host = parsedUrl.hostname.toLowerCase();
        const capability = `net:${host}`;
        const init = (params.init ?? {}) as PublicNetStreamInit;
        const workspaceId = typeof init.workspaceId === 'string'
          ? init.workspaceId
          : (typeof params.workspaceId === 'string' ? params.workspaceId : undefined);
        const granted = workspaceId
          ? this.deps.permissions.isGranted(plugin, capability, workspaceId)
          : this.deps.permissions.isGranted(plugin, capability) ||
            this.deps.store.listWorkspaces().some((ws) => this.deps.permissions.isGranted(plugin, capability, ws.id));
        if (!granted) {
          throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得网络权限 ${capability}`);
        }
        const controller = new AbortController();
        const connectTimeout = Math.min(60_000, Math.max(500, init.connectTimeoutMs ?? 10_000));
        const connectTimer = setTimeout(() => controller.abort(new Error('Stream connection timeout')), connectTimeout);
        let response: Response;
        try {
          response = await fetch(parsedUrl.toString(), {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(connectTimer);
          const msg = err instanceof Error ? err.message : String(err);
          throw new PluginApiError(
            controller.signal.aborted ? 'E_TIMEOUT' : 'E_SERVICE_UNAVAILABLE',
            msg,
          );
        }
        clearTimeout(connectTimer);

        const streamId = randomUUID();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        this.activeNetStreams.set(streamId, {
          pluginId: instanceId,
          runId: meta.runId,
          controller,
        });

        const pump = async () => {
          try {
            if (!response.body) {
              this.deps.onNetStreamEnd?.(instanceId, meta.runId, streamId);
              return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: false });
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!this.activeNetStreams.has(streamId)) {
                await reader.cancel().catch(() => {});
                return;
              }
              if (value && value.byteLength > 0) {
                const text = decoder.decode(value, { stream: true });
                if (text) {
                  this.deps.onNetStreamChunk?.(instanceId, meta.runId, streamId, text);
                }
              }
            }
            const flushText = decoder.decode();
            if (flushText) {
              this.deps.onNetStreamChunk?.(instanceId, meta.runId, streamId, flushText);
            }
            if (this.activeNetStreams.has(streamId)) {
              this.deps.onNetStreamEnd?.(instanceId, meta.runId, streamId);
            }
          } catch (err) {
            if (this.activeNetStreams.has(streamId)) {
              const msg = err instanceof Error ? err.message : String(err);
              this.deps.onNetStreamError?.(instanceId, meta.runId, streamId, msg);
            }
          } finally {
            this.activeNetStreams.delete(streamId);
          }
        };
        queueMicrotask(() => { void pump(); });

        return {
          streamId,
          status: response.status,
          ok: response.ok,
          headers,
        };
      }

      case 'net.stream.close': {
        const streamId = typeof params.streamId === 'string' ? params.streamId : '';
        const existing = this.activeNetStreams.get(streamId);
        if (existing && existing.pluginId === instanceId && existing.runId === meta.runId) {
          this.activeNetStreams.delete(streamId);
          try { existing.controller.abort(); } catch {}
        }
        return { ok: true };
      }

      case 'secrets.resolve': {
        const secretRef = typeof params.secretRef === 'string' ? params.secretRef : '';
        const namespace = parseSecretNamespace(secretRef);
        this.deps.permissions.assertGranted(plugin, `secrets:read:${namespace}`, GLOBAL_WORKSPACE_SCOPE);
        const value = this.deps.pluginSecrets?.resolve(secretRef) ?? null;
        return { value };
      }

      case 'notify.send': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        this.deps.permissions.assertGranted(plugin, 'notify', workspaceId);
        const title = String(params.title ?? '').trim().slice(0, 120);
        if (!title) throw new PluginApiError('E_INVALID_INPUT', '通知标题不能为空');
        const body = typeof params.body === 'string' ? params.body.slice(0, 500) : undefined;
        const level = params.level === 'warn' || params.level === 'error' ? params.level : 'info';
        this.notifications.push({ pluginId: meta.pluginId, title, body, level, timestamp: Date.now() });
        this.deps.onNotify?.(meta.pluginId, { title, body, level });
        return { ok: true };
      }

      case 'clipboard.writeText': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        this.deps.permissions.assertGranted(plugin, 'clipboard:write', workspaceId);
        const text = typeof params.text === 'string' ? params.text : '';
        if (text.length > 256 * 1024) throw new PluginApiError('E_LIMIT_EXCEEDED', '剪贴板内容超出大小限制');
        this.clipboardWrites.push({ pluginId: meta.pluginId, text, timestamp: Date.now() });
        this.deps.onClipboardWrite?.(meta.pluginId, text);
        return { ok: true };
      }

      default:
        throw new PluginApiError('E_NOT_SUPPORTED', `不支持的宿主 RPC 方法 ${method}`);
    }
  }

  private async handleLedgerServiceCall(
    plugin: InstalledPluginInfo,
    meta: { pluginId: string; runId: string },
    fnName: string,
    args: unknown[],
  ) {
    if (fnName === 'get') {
      return this.handle('ledger.get', { sessionId: args[0] }, meta);
    }
    if (fnName === 'append') {
      return this.handle('ledger.append', { sessionId: args[0], entry: args[1] }, meta);
    }
    const ledger = this.deps.host.get<Record<string, unknown>>('ledger');
    if (ledger && typeof ledger[fnName] === 'function' && (ledger as { __thirdParty?: boolean }).__thirdParty) {
      return await (ledger[fnName] as (...a: unknown[]) => unknown)(...args);
    }
    throw new PluginApiError('E_NOT_SUPPORTED', `ledger 不支持公共方法 ${fnName}`);
  }

  private async handleGitServiceCall(plugin: InstalledPluginInfo, fnName: string, args: unknown[]) {
    const workspaceId = typeof args[0] === 'string' ? args[0] : undefined;
    const workspace = await this.getWorkspaceOrThrow(workspaceId);
    this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
    const resolution = this.resolveServiceWithFallback(PEER_CONTRACTS.gitWorkspace, {
      workspaceId: workspace.id,
      allowSingleCandidate: true,
    });
    if (resolution.status === 'ready') {
      const peer = this.deps.host.getServiceByInstance<GitWorkspaceServiceV1>(
        resolution.instanceId,
        PEER_CONTRACTS.gitWorkspace,
      );
      if (peer) {
        if (fnName === 'status' && typeof peer.getStatus === 'function') {
          const res = await peer.getStatus({ workspaceId: workspace.id, cwd: workspace.rootPath });
          if (res.ok && res.value.status) return res.value.status;
        }
        if (fnName === 'inspect' && typeof peer.inspect === 'function') {
          const res = await peer.inspect({ workspaceId: workspace.id, cwd: workspace.rootPath });
          if (res.ok) return res.value;
        }
      }
    }
    const git = this.deps.host.get<{ status?: (cwd: string) => unknown; inspect?: (cwd: string) => unknown }>('git');
    if (!git) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'git 服务不可用');
    if (fnName === 'status' && typeof git.status === 'function') return await git.status(workspace.rootPath);
    if (fnName === 'inspect' && typeof git.inspect === 'function') return await git.inspect(workspace.rootPath);
    throw new PluginApiError('E_NOT_SUPPORTED', `git 不支持公共方法 ${fnName}`);
  }

  private handleStorage(scope: string, pluginId: string, op: string, params: Record<string, unknown>) {
    if (op === 'keys') {
      return this.deps.store.listPluginStorageKeys(scope, pluginId);
    }
    const key = typeof params.key === 'string' && params.key.length > 0 && params.key.length <= 128 ? params.key : null;
    if (!key) throw new PluginApiError('E_INVALID_INPUT', '无效的存储键');
    if (op === 'get') return this.deps.store.getPluginStorageValue(scope, pluginId, key);
    if (op === 'delete') {
      this.deps.store.deletePluginStorageValue(scope, pluginId, key);
      return { ok: true };
    }
    if (op === 'set') {
      const encoded = JSON.stringify(params.value);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_STORAGE_BYTES) {
        throw new PluginApiError('E_LIMIT_EXCEEDED', '存储值超出 256 KiB 限制或不可序列化');
      }
      this.deps.store.setPluginStorageValue(scope, pluginId, key, params.value);
      return { ok: true };
    }
    throw new PluginApiError('E_NOT_SUPPORTED', `不支持的存储操作 ${op}`);
  }
}
