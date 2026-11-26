import { randomUUID } from 'node:crypto';
import {
  PluginApiError,
  isBuiltinPublicService,
  isReservedServiceName,
  isSafePluginUiPath,
  isValidPluginSlotKey,
  normalizeAnyPluginSlotKey,
  pluginEventContracts,
  type ApprovalAnnotateEvent,
  type ApprovalAnnotation,
  type ApprovalPolicyDecision,
  type ApprovalPolicyRequest,
  type HandoffComposeEvent,
  type HandoffOfferDecision,
  type HandoffShouldOfferEvent,
  type PluginEventV4,
  type PluginHandshakeResponse,
  type PluginRouteRequest,
  type PluginRouteResponse,
  type PluginRuntimeSlotDescriptor,
  type PublicAdapterUsageLimitResult,
  type PublicCommandResult,
  type PublicHarnessDriverDescriptor,
  type PublicHarnessProbeResult,
} from '@harnessmate/plugin-api';
import type {
  ApprovalDecision,
  ContextInjectionDriver,
  HarnessHealth,
  HarnessInfo,
  InstalledPluginInfo,
  Session,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type {
  AdapterSessionConfig,
  AdapterSessionHandle,
  AdapterUsageLimitResult,
  ContextSyncPayload,
  HarnessAdapter,
  NormalizedAdapterEvent,
  TurnInput,
} from '../../harnesses/types.js';
import { GLOBAL_WORKSPACE_SCOPE, type PluginPermissionService } from '../permissions/permissions.js';
import type { HandoffRedactionOutcome, HandoffRedactionRequest, HostPlugin, PluginHost } from '../runtime/lifecycle.js';
import { CliProcessManager } from './cli-process-manager.js';
import {
  CrashBackoffTracker,
  ISOLATED_TIMEOUTS,
  IsolatedPluginProcess,
  type CrashPolicy,
} from './isolated-process.js';
import type { PluginSecretStore } from './plugin-secrets.js';
import { IsolatedPluginRpcRouter, type PluginLogEntry } from './rpc-router.js';

export interface IsolatedToolDescriptor {
  pluginId: string;
  pluginName: string;
  packageDigest: string;
  runId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
}

export interface IsolatedCommandDescriptor {
  pluginId: string;
  pluginName: string;
  runId: string;
  command: string;
  description: string;
  argumentHint?: string;
}

interface ProxyDriverSessionEntry {
  driverId: string;
  handleId: string;
  nativeSessionId: string | null;
  activeTurnId: string | null;
  listeners: Set<(event: NormalizedAdapterEvent) => void>;
}

export interface ActiveIsolatedPlugin {
  pluginId: string;
  instanceId: string;
  runId: string;
  info: InstalledPluginInfo;
  process: IsolatedPluginProcess;
  handshake: PluginHandshakeResponse;
  subscribedEvents: Set<string>;
  commands: Set<string>;
  routes: Set<string>;
  serviceMeta: Record<string, { version?: string; metadata?: Record<string, unknown> }>;
  tools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }>;
  slots: Map<string, PluginRuntimeSlotDescriptor>;
  sections: Map<string, { id: string; order?: number; text: string }>;
  declaredDrivers: Map<string, PublicHarnessDriverDescriptor>;
  registeredDrivers: Map<string, HarnessAdapter>;
  driverSessions: Map<string, ProxyDriverSessionEntry>;
  hasHandoffCompose: boolean;
  hasHandoffShouldOffer: boolean;
  hasApprovalAnnotate: boolean;
  hasHandoffRedact: boolean;
}

export interface IsolatedManagerOptions {
  store: HarnessMateStore;
  host: PluginHost;
  permissions: PluginPermissionService;
  pluginSecrets?: PluginSecretStore;
  getPluginInfo: (pluginId: string) => InstalledPluginInfo | undefined;
  requestRestart: (pluginId: string) => Promise<void>;
  registry?: HarnessRegistry;
  crashPolicy?: CrashPolicy;
  runNativeCommand?: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>;
}

export class IsolatedPluginManager {
  private readonly active = new Map<string, ActiveIsolatedPlugin>();
  private readonly crashTrackers = new Map<string, CrashBackoffTracker>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastCrashReason = new Map<string, string>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly serviceUnsubscribe: () => void;
  private readonly permissionUnsubscribe: () => void;
  private readonly cliProcesses: CliProcessManager;
  private nativeCommandRunner?: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>;
  readonly router: IsolatedPluginRpcRouter;

  constructor(private readonly opts: IsolatedManagerOptions) {
    this.nativeCommandRunner = opts.runNativeCommand;
    this.cliProcesses = new CliProcessManager(opts.store, opts.permissions);
    if (opts.registry) {
      opts.host.setRegistryBridge(opts.registry);
    }
    opts.host.setHandoffRedactor((input) => this.redactHandoff(input));
    this.router = new IsolatedPluginRpcRouter({
      store: opts.store,
      host: opts.host,
      permissions: opts.permissions,
      getPluginInfo: (pluginId) => this.active.get(pluginId)?.info ?? opts.getPluginInfo(pluginId),
      isCurrentRun: (pluginId, runId) => this.active.get(pluginId)?.runId === runId,
      cliProcesses: this.cliProcesses,
      pluginSecrets: opts.pluginSecrets,
      onCliOutput: (pluginId, runId, processId, stream, chunk) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.process.notify('host.cli.output', { processId, stream, chunk }, runId);
      },
      onCliExit: (pluginId, runId, processId, code, signal) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.process.notify('host.cli.exit', { processId, code, signal }, runId);
      },
      onNetStreamChunk: (pluginId, runId, streamId, chunk) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.process.notify('host.net.stream.chunk', { streamId, chunk }, runId);
      },
      onNetStreamEnd: (pluginId, runId, streamId) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.process.notify('host.net.stream.end', { streamId }, runId);
      },
      onNetStreamError: (pluginId, runId, streamId, message) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.process.notify('host.net.stream.error', { streamId, message }, runId);
      },
      onDriverRegister: (pluginId, runId, driver) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        this.validateDriverDeclaration(entry, driver);
        entry.declaredDrivers.set(driver.driverId, driver);
        this.opts.permissions.assertGranted(entry.info, 'harness:driver:register', GLOBAL_WORKSPACE_SCOPE);
        this.syncPluginDrivers(entry);
      },
      onDriverUnregister: (pluginId, runId, driverId) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        entry.declaredDrivers.delete(driverId);
        this.unregisterSinglePluginDriver(entry, driverId);
      },
      onDriverSessionEvent: (pluginId, runId, handleId, rawEvent) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        const sess = entry.driverSessions.get(handleId);
        if (!sess) return;
        const event = rawEvent as NormalizedAdapterEvent;
        if (event.type === 'native_session_ready' && typeof event.nativeSessionId === 'string') {
          sess.nativeSessionId = event.nativeSessionId;
        }
        if (event.type === 'turn.started' && typeof event.turnId === 'string') {
          sess.activeTurnId = event.turnId;
        } else if (
          (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') &&
          sess.activeTurnId === event.turnId
        ) {
          sess.activeTurnId = null;
        }
        for (const listener of [...sess.listeners]) {
          try { listener(event); } catch { /* listener isolation */ }
        }
      },
      onSubscriptionChange: (pluginId, runId, event, subscribed) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        if (subscribed) entry.subscribedEvents.add(event);
        else entry.subscribedEvents.delete(event);
      },
      onDynamicUnregister: (instanceId, runId, kind, name) => {
        const entry = this.active.get(instanceId);
        if (!entry || entry.runId !== runId) return;
        if (kind === 'command') entry.commands.delete(name);
        else if (kind === 'tool') entry.tools.delete(name);
        else if (kind === 'section') entry.sections.delete(name);
        else if (kind === 'slot') entry.slots.delete(name);
        else if (kind === 'route') entry.routes.delete(name);
      },
      runNativeCommand: (sessionId, command, args) => {
        if (!this.nativeCommandRunner) {
          throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用原生命令桥接');
        }
        return this.nativeCommandRunner(sessionId, command, args);
      },
    });
    this.serviceUnsubscribe = opts.host.onServicesChanged((services) => {
      this.syncServices(services);
    });
    this.permissionUnsubscribe = opts.permissions.onChange((event) => {
      if (event.capability !== 'harness:driver:register') return;
      const entry = this.active.get(event.pluginId);
      if (!entry || !entry.process.alive) return;
      try {
        this.syncPluginDrivers(entry);
      } catch {
        // Conflicts are handled when activating or invoking
      }
    });
  }

  setNativeCommandRunner(runner: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>): void {
    this.nativeCommandRunner = runner;
  }

  getActive(pluginId: string): ActiveIsolatedPlugin | undefined {
    return this.active.get(pluginId);
  }

  getRunId(pluginId: string): string | undefined {
    return this.active.get(pluginId)?.runId;
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return this.router.getLogs(pluginId);
  }

  getAllLogs(): PluginLogEntry[] {
    return this.router.getAllLogs();
  }

  clearLogs(pluginId?: string): void {
    this.router.clearLogs(pluginId);
  }

  listSlots(instanceId: string): PluginRuntimeSlotDescriptor[] {
    const entry = this.active.get(instanceId);
    if (!entry || !entry.process.alive) return [];
    return [...entry.slots.values()];
  }

  listRoutes(instanceId: string): string[] {
    const entry = this.active.get(instanceId);
    if (!entry || !entry.process.alive) return [];
    return [...entry.routes.values()];
  }

  async dispatchRoute(instanceId: string, req: PluginRouteRequest): Promise<PluginRouteResponse> {
    const entry = this.active.get(instanceId);
    if (!entry || !entry.process.alive) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', '插件实例未处于活动状态');
    }
    return entry.process.call<PluginRouteResponse>(
      'host.route.handle',
      {
        httpMethod: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        body: req.body,
      },
      ISOLATED_TIMEOUTS.command,
      entry.runId,
    );
  }

  async invokeApprovalPolicy(instanceId: string, req: ApprovalPolicyRequest): Promise<ApprovalPolicyDecision> {
    const entry = this.active.get(instanceId);
    if (!entry || !entry.process.alive) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `审批策略实例 ${instanceId} 不可用`);
    }
    const result = await entry.process.call<ApprovalPolicyDecision>(
      'host.service.call',
      { service: 'approval.policy.v1', method: 'evaluateToolCall', args: [req] },
      ISOLATED_TIMEOUTS.waterfall,
      entry.runId,
    );
    if (!result || (result.decision !== 'allow' && result.decision !== 'deny' && result.decision !== 'ask')) {
      throw new PluginApiError('E_INVALID_INPUT', `审批策略实例 ${instanceId} 返回了无效决策`);
    }
    return result;
  }

  async sendSlotMessage(
    pluginId: string,
    slotId: string,
    expectedRunId: string | undefined,
    payload: unknown,
    sessionId: string | null,
    slot?: string,
  ): Promise<unknown> {
    const entry = this.active.get(pluginId);
    if (!entry || !entry.process.alive) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', '插件未处于活动状态');
    }
    if (expectedRunId && entry.runId !== expectedRunId) {
      throw new PluginApiError('E_STALE_RUN', '插件 UI 实例已过期，请刷新插槽');
    }
    return entry.process.call(
      'host.slot.message',
      { slotId, slot, payload, sessionId },
      ISOLATED_TIMEOUTS.command,
      entry.runId,
    );
  }

  clearCrashHistory(pluginId: string): void {
    this.crashTrackers.delete(pluginId);
    this.lastCrashReason.delete(pluginId);
    const timer = this.restartTimers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(pluginId);
    }
  }

  getCrashFailure(pluginId: string): string | undefined {
    return this.lastCrashReason.get(pluginId);
  }

  createHostPlugin(params: {
    info: InstalledPluginInfo;
    instanceId?: string;
    packageRoot: string;
    entryRelativePath: string;
    digest: string;
    enabled: boolean;
    config?: Readonly<Record<string, unknown>>;
    bindings?: Readonly<Record<string, string>>;
    trustedLocal?: boolean;
    revision: string;
  }): HostPlugin {
    const { info, packageRoot, entryRelativePath, digest, enabled, config, bindings, revision } = params;
    const instanceId = params.instanceId ?? info.instanceId ?? info.id;
    const trustedLocal = params.trustedLocal ?? info.devTrustedLocal;
    const crashFailure = this.lastCrashReason.get(instanceId);
    const dependencies = info.dependencies ? Object.values(info.dependencies) : undefined;
    return {
      id: instanceId,
      pluginId: info.id,
      revision,
      enabled,
      error: crashFailure,
      inject: info.inject,
      provides: info.provides,
      dependencies,
      bindings,
      config,
      apply: async (ctx, resolvedConfig) => {
        await this.awaitPendingDisposals();
        // Pre-validate service replacement permissions before spawning if plugin declares built-in public services
        for (const service of info.provides ?? []) {
          if (isReservedServiceName(service)) {
            throw new PluginApiError('E_PERMISSION_DENIED', `不允许第三方提供核心服务 ${service}`);
          }
          if (isBuiltinPublicService(service)) {
            this.opts.permissions.assertGranted(info, `service:provide:${service}`, GLOBAL_WORKSPACE_SCOPE);
          }
        }

        let procRef: IsolatedPluginProcess | undefined;
        const proc = new IsolatedPluginProcess({
          pluginId: info.id,
          instanceId,
          trustedLocal,
          packageRoot,
          entryRelativePath,
          packageDigest: digest,
          config: resolvedConfig,
          bindings,
          declaredPermissions: info.permissions ?? [],
          services: this.opts.host.listServices(),
          onRpc: (method, rpcParams, meta) => this.router.handle(method, rpcParams, meta),
          onExit: (code, signal, stderr) => {
            if (!procRef || this.active.get(instanceId)?.process !== procRef) return;
            this.handleUnexpectedCrash(instanceId, procRef.runId, code, signal, stderr);
          },
        });
        procRef = proc;

        // Register temporary active entry during handshake so child RPC calls during apply() pass isCurrentRun
        const placeholder: ActiveIsolatedPlugin = {
          pluginId: info.id,
          instanceId,
          runId: proc.runId,
          info,
          process: proc,
          handshake: { sdkVersion: '4.0.0' },
          subscribedEvents: new Set(),
          commands: new Set(),
          routes: new Set(),
          serviceMeta: {},
          tools: new Map(),
          slots: new Map(),
          sections: new Map(),
          declaredDrivers: new Map(),
          registeredDrivers: new Map(),
          driverSessions: new Map(),
          hasHandoffCompose: false,
          hasHandoffShouldOffer: false,
          hasApprovalAnnotate: false,
          hasHandoffRedact: false,
        };
        this.active.set(instanceId, placeholder);

        ctx.effect(() => () => {
          this.router.abortNetStreamsForRun(instanceId, proc.runId);
          this.cleanupPluginDrivers(placeholder);
          const cliTask = this.cliProcesses.killAllForRun(instanceId, proc.runId)
            .finally(() => { this.pendingDisposals.delete(cliTask); });
          this.pendingDisposals.add(cliTask);
          if (this.active.get(instanceId)?.runId === proc.runId) {
            this.active.delete(instanceId);
          }
          const task = proc.dispose().finally(() => { this.pendingDisposals.delete(task); });
          this.pendingDisposals.add(task);
        });

        let handshake: PluginHandshakeResponse;
        try {
          handshake = await proc.handshake();
          if (info.contributes.filePreview && !handshake.hasFilePreview) {
            throw new PluginApiError('E_INVALID_INPUT', '文件预览插件必须导出 renderFilePreview(file)');
          }
        } catch (error) {
          this.cleanupPluginDrivers(placeholder);
          await this.cliProcesses.killAllForRun(instanceId, proc.runId);
          if (this.active.get(instanceId)?.runId === proc.runId) this.active.delete(instanceId);
          await proc.dispose();
          throw error;
        }

        placeholder.handshake = handshake;
        for (const ev of handshake.subscribedEvents ?? []) placeholder.subscribedEvents.add(ev);
        for (const cmd of handshake.commands ?? []) placeholder.commands.add(cmd);
        for (const route of handshake.routes ?? []) placeholder.routes.add(route);
        placeholder.serviceMeta = handshake.serviceMeta ?? {};
        for (const tool of handshake.tools ?? []) placeholder.tools.set(tool.name, tool);
        for (const slotDef of handshake.slots ?? []) {
          if (isValidPluginSlotKey(slotDef.slot) && isSafePluginUiPath(slotDef.ui)) {
            const normalized = normalizeAnyPluginSlotKey(slotDef.slot);
            placeholder.slots.set(`${normalized}:${slotDef.id}`, { ...slotDef, slot: normalized });
          }
        }
        for (const sec of handshake.sections ?? []) placeholder.sections.set(sec.id, sec);
        placeholder.hasHandoffCompose = Boolean(handshake.hasHandoffCompose);
        placeholder.hasHandoffShouldOffer = Boolean(handshake.hasHandoffShouldOffer);
        placeholder.hasApprovalAnnotate = Boolean(handshake.hasApprovalAnnotate);
        placeholder.hasHandoffRedact = Boolean(handshake.hasHandoffRedact);

        for (const driver of handshake.registeredDrivers ?? []) {
          this.validateDriverDeclaration(placeholder, driver);
          placeholder.declaredDrivers.set(driver.driverId, driver);
        }
        if (placeholder.declaredDrivers.size > 0) {
          this.syncPluginDrivers(placeholder);
        }

        // Register all services provided by the isolated plugin as runId-validated RPC proxies
        const capturedRunId = proc.runId;
        for (const serviceName of handshake.provides ?? []) {
          if (isReservedServiceName(serviceName)) {
            throw new PluginApiError('E_PERMISSION_DENIED', `不允许第三方提供核心服务 ${serviceName}`);
          }
          if (!info.provides?.includes(serviceName)) {
            throw new PluginApiError('E_PERMISSION_DENIED', `插件未在清单 provides 中声明服务 ${serviceName}`);
          }
          if (isBuiltinPublicService(serviceName)) {
            this.opts.permissions.assertGranted(info, `service:provide:${serviceName}`, GLOBAL_WORKSPACE_SCOPE);
          }
          const methods = handshake.serviceMethods?.[serviceName] ?? [];
          const meta = handshake.serviceMeta?.[serviceName];
          const proxyTarget: Record<string, unknown> = {
            __thirdParty: true,
            __pluginId: info.id,
            __instanceId: instanceId,
            __runId: capturedRunId,
          };
          for (const methodName of methods) {
            proxyTarget[methodName] = (...args: unknown[]) =>
              proc.call(
                'host.service.call',
                { service: serviceName, method: methodName, args },
                ISOLATED_TIMEOUTS.service,
                capturedRunId,
              );
          }
          const serviceProxy = new Proxy(proxyTarget, {
            get(target, prop) {
              if (typeof prop !== 'string' || prop === 'then') return undefined;
              return prop in target ? target[prop] : undefined;
            },
          });
          ctx.provide(serviceName, serviceProxy, {
            version: meta?.version ?? info.version,
            metadata: meta?.metadata,
            runId: capturedRunId,
          });
        }
      },
    };
  }

  private handleUnexpectedCrash(
    instanceId: string,
    crashedRunId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    const current = this.active.get(instanceId);
    if (!current || current.runId !== crashedRunId) return;
    const detail = stderr ? `${code ?? signal ?? 'crash'}: ${stderr.slice(0, 200)}` : `exit ${code ?? signal ?? 'unknown'}`;
    this.router.abortNetStreamsForRun(instanceId, crashedRunId);
    this.cleanupPluginDrivers(current, `隔离进程异常退出 (${detail})`);
    const cliTask = this.cliProcesses.killAllForRun(instanceId, crashedRunId)
      .finally(() => { this.pendingDisposals.delete(cliTask); });
    this.pendingDisposals.add(cliTask);
    this.active.delete(instanceId);

    const tracker = this.crashTrackers.get(instanceId) ?? new CrashBackoffTracker(this.opts.crashPolicy);
    this.crashTrackers.set(instanceId, tracker);
    const outcome = tracker.recordCrash();

    if (outcome.exhausted) {
      const reason = `隔离进程 10 分钟内崩溃 ${outcome.count} 次，已停止重启 (${detail})`;
      this.lastCrashReason.set(instanceId, reason);
      this.opts.host.fail(instanceId, reason);
      return;
    }

    this.opts.host.fail(instanceId, `隔离进程异常退出 (${detail})，将在 ${outcome.delayMs}ms 后退避重启`);
    const existingTimer = this.restartTimers.get(instanceId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.restartTimers.delete(instanceId);
      void this.opts.requestRestart(instanceId).catch(() => {});
    }, outcome.delayMs);
    timer.unref();
    this.restartTimers.set(instanceId, timer);
  }

  syncServices(services: readonly string[]): void {
    for (const entry of this.active.values()) {
      if (!entry.process.alive) continue;
      void entry.process.call('host.services.sync', { services }, ISOLATED_TIMEOUTS.event, entry.runId).catch(() => {});
    }
  }

  async dispatchEvent(event: PluginEventV4, workspaceId?: string): Promise<void> {
    const contract = pluginEventContracts[event.type];
    if (!contract) return;
    const targets = [...this.active.values()].filter((entry) => {
      if (!entry.process.alive || !entry.subscribedEvents.has(event.type)) return false;
      if (!contract.permission) return true;
      return this.opts.permissions.isGranted(entry.info, contract.permission, workspaceId);
    });
    if (!targets.length) return;

    const deliver = async (entry: ActiveIsolatedPlugin) => {
      try {
        await entry.process.call('host.event', { event }, ISOLATED_TIMEOUTS.event, entry.runId);
      } catch {
        // Event timeouts/errors are isolated to the individual plugin
      }
    };

    if (contract.mode === 'serial') {
      for (const entry of targets) await deliver(entry);
    } else if (contract.mode === 'parallel') {
      await Promise.all(targets.map(deliver));
    } else {
      for (const entry of targets) queueMicrotask(() => void deliver(entry));
    }
  }

  listCommands(): IsolatedCommandDescriptor[] {
    const list: IsolatedCommandDescriptor[] = [];
    for (const entry of this.active.values()) {
      if (!entry.process.alive) continue;
      for (const cmd of entry.commands) {
        const declared = entry.info.contributes.commands?.find(({ command }) => command === cmd);
        list.push({
          pluginId: entry.pluginId,
          pluginName: entry.info.name,
          runId: entry.runId,
          command: cmd,
          description: declared?.description ?? `插件 ${entry.info.name} 命令`,
          argumentHint: declared?.argumentHint,
        });
      }
    }
    return list;
  }

  async runCommand(session: Session, command: string, args: string, expectedRunId?: string, pluginId?: string): Promise<PublicCommandResult> {
    const entry = [...this.active.values()].find((item) => item.commands.has(command) && (!pluginId || item.pluginId === pluginId));
    if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未找到命令 /${command}`);
    return await entry.process.call<PublicCommandResult>(
      'host.command',
      {
        command,
        input: {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          harnessId: session.harnessId,
          args,
        },
      },
      ISOLATED_TIMEOUTS.command,
      expectedRunId ?? entry.runId,
    );
  }

  listTools(workspaceId: string): IsolatedToolDescriptor[] {
    const tools: IsolatedToolDescriptor[] = [];
    for (const entry of this.active.values()) {
      if (!entry.process.alive || !entry.info.packageDigest) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'tools:model', workspaceId)) continue;
      for (const tool of entry.tools.values()) {
        tools.push({
          pluginId: entry.pluginId,
          pluginName: entry.info.name,
          packageDigest: entry.info.packageDigest,
          runId: entry.runId,
          ...tool,
        });
      }
    }
    return tools;
  }

  async invokeTool(
    pluginId: string,
    expectedRunId: string,
    toolName: string,
    input: Record<string, unknown>,
    meta: { sessionId: string; workspaceId: string },
    instanceId?: string,
  ): Promise<string> {
    const entry = this.active.get(instanceId ?? pluginId);
    if (!entry || entry.runId !== expectedRunId) {
      throw new PluginApiError('E_STALE_RUN', '插件工具所属实例已重启或卸载');
    }
    this.opts.permissions.assertGranted(entry.info, 'tools:model', meta.workspaceId);
    const result = await entry.process.call<unknown>(
      'host.tool',
      { name: toolName, input, meta },
      ISOLATED_TIMEOUTS.tool,
      expectedRunId,
    );
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  async collectHandoffSections(event: HandoffComposeEvent): Promise<Array<{ id: string; source: string; order: number; text: string }>> {
    const collected: Array<{ id: string; source: string; order: number; text: string }> = [];
    for (const entry of this.active.values()) {
      if (!entry.process.alive) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'handoff:section', event.workspaceId)) continue;
      for (const sec of entry.sections.values()) {
        if (sec.text.trim()) {
          collected.push({
            id: `${entry.pluginId}.${sec.id}`,
            source: entry.pluginId,
            order: sec.order ?? 500,
            text: sec.text,
          });
        }
      }
      if (entry.hasHandoffCompose) {
        try {
          const res = await entry.process.call<{ sections?: Array<{ id?: unknown; order?: unknown; text?: unknown }> }>(
            'host.handoff.compose',
            { event },
            ISOLATED_TIMEOUTS.waterfall,
            entry.runId,
          );
          for (const sec of res?.sections ?? []) {
            if (typeof sec?.id === 'string' && typeof sec?.text === 'string' && sec.text.trim()) {
              collected.push({
                id: `${entry.pluginId}.${sec.id}`,
                source: entry.pluginId,
                order: typeof sec.order === 'number' ? sec.order : 500,
                text: sec.text,
              });
            }
          }
        } catch {
          // Handoff compose errors are isolated per plugin
        }
      }
    }
    return collected.sort((a, b) => a.order - b.order);
  }

  async annotateApproval(event: ApprovalAnnotateEvent): Promise<ApprovalAnnotation[]> {
    const PER_PLUGIN_TIMEOUT_MS = 300;
    const tasks: Array<Promise<ApprovalAnnotation[]>> = [];
    for (const entry of this.active.values()) {
      if (!entry.process.alive || !entry.hasApprovalAnnotate) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'approvals:annotate', event.workspaceId)) continue;
      tasks.push(
        (async () => {
          try {
            const res = await entry.process.call<{ annotations?: Array<{ risk?: unknown; label?: unknown; detail?: unknown }> }>(
              'host.approval.annotate',
              { event },
              PER_PLUGIN_TIMEOUT_MS,
              entry.runId,
            );
            const notes: ApprovalAnnotation[] = [];
            for (const item of res?.annotations ?? []) {
              if (typeof item?.label !== 'string' || !item.label.trim()) continue;
              const risk = item.risk === 'low' || item.risk === 'medium' || item.risk === 'high' ? item.risk : undefined;
              notes.push({
                pluginId: entry.pluginId,
                risk,
                label: item.label.trim().slice(0, 120),
                detail: typeof item.detail === 'string' ? item.detail.slice(0, 500) : undefined,
              });
            }
            return notes;
          } catch {
            return [
              {
                pluginId: entry.pluginId,
                risk: 'low' as const,
                label: '部分安全规则检查未响应',
                detail: `插件 ${entry.pluginId} 安全规则检查超时（>${PER_PLUGIN_TIMEOUT_MS}ms）或异常退出`,
              },
            ];
          }
        })(),
      );
    }
    const nested = await Promise.all(tasks);
    return nested.flat();
  }

  async shouldOfferHandoff(event: HandoffShouldOfferEvent): Promise<HandoffOfferDecision | undefined> {
    for (const entry of this.active.values()) {
      if (!entry.process.alive || !entry.hasHandoffShouldOffer) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'session:read', event.workspaceId)) continue;
      try {
        const res = await entry.process.call<{ decision?: HandoffOfferDecision | boolean }>(
          'host.handoff.shouldOffer',
          { event },
          ISOLATED_TIMEOUTS.bail,
          entry.runId,
        );
        if (typeof res?.decision === 'boolean') return { offer: res.decision };
        if (res?.decision && typeof res.decision === 'object' && typeof res.decision.offer === 'boolean') {
          return res.decision;
        }
      } catch {
        // Bail listener error falls through to next listener
      }
    }
    return undefined;
  }

  async redactHandoff(input: HandoffRedactionRequest): Promise<HandoffRedactionOutcome> {
    let currentText = input.text;
    const allCategories: string[] = [];
    let redactedCount = 0;

    for (const entry of this.active.values()) {
      if (!entry.process.alive || !entry.hasHandoffRedact) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'handoff:redact', input.workspaceId)) continue;
      const res = await entry.process.call<{ text?: unknown; categories?: unknown }>(
        'host.handoff.redact',
        {
          text: currentText,
          targetDriverId: input.targetDriverId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          targetInstanceId: input.targetInstanceId,
        },
        ISOLATED_TIMEOUTS.waterfall,
        entry.runId,
      );
      if (!res || typeof res.text !== 'string') {
        throw new PluginApiError('E_INVALID_INPUT', `插件 ${entry.pluginId} 脱敏器返回无效结果`);
      }
      const cats = Array.isArray(res.categories)
        ? res.categories.filter((c): c is string => typeof c === 'string' && c.length > 0)
        : [];
      for (const cat of cats) allCategories.push(cat);
      if (cats.length > 0) redactedCount += cats.length;
      else if (res.text !== currentText) redactedCount += 1;
      currentText = res.text;
    }

    return {
      text: currentText,
      categories: [...new Set(allCategories)],
      redactedCount,
    };
  }

  private getRegistry(): HarnessRegistry | undefined {
    return this.opts.registry ?? this.opts.host.getRegistryBridge();
  }

  private validateDriverDeclaration(entry: ActiveIsolatedPlugin, driver: PublicHarnessDriverDescriptor): void {
    const driverId = typeof driver?.driverId === 'string' ? driver.driverId.trim() : '';
    if (!driverId || !/^[a-z][a-z0-9_.-]{0,63}$/i.test(driverId)) {
      throw new PluginApiError('E_INVALID_INPUT', `非法的 Harness 驱动 ID: ${String(driver?.driverId ?? '')}`);
    }
    const registry = this.getRegistry();
    if (registry?.isReserved(driverId) || driverId === 'codex' || driverId === 'claude' || driverId === 'agy' || driverId === 'acp') {
      throw new PluginApiError('E_PERMISSION_DENIED', `禁止覆盖内置 Harness 驱动: ${driverId}`);
    }
    const existing = entry.registeredDrivers.get(driverId);
    if (registry && !existing && (registry.hasDriver(driverId) || registry.get(driverId))) {
      throw new PluginApiError('E_CONFLICT', `Harness 驱动 ID 已被占用: ${driverId}`);
    }
  }

  private syncPluginDrivers(entry: ActiveIsolatedPlugin): void {
    const registry = this.getRegistry();
    if (!registry) return;
    const granted = this.opts.permissions.isGranted(entry.info, 'harness:driver:register', GLOBAL_WORKSPACE_SCOPE);
    if (!granted) {
      this.cleanupPluginDrivers(entry);
      return;
    }
    for (const [driverId, desc] of entry.declaredDrivers) {
      if (entry.registeredDrivers.has(driverId)) continue;
      if (registry.hasDriver(driverId) || registry.get(driverId)) {
        throw new PluginApiError('E_CONFLICT', `Harness 驱动 ID 已被占用: ${driverId}`);
      }
      const adapter = this.createProxyHarnessAdapter(entry, desc);
      registry.registerDriver(driverId, () => adapter);
      registry.register(adapter);
      entry.registeredDrivers.set(driverId, adapter);
    }
  }

  private unregisterSinglePluginDriver(
    entry: ActiveIsolatedPlugin,
    driverId: string,
    crashReason?: string,
  ): void {
    for (const [handleId, sess] of [...entry.driverSessions.entries()]) {
      if (sess.driverId !== driverId) continue;
      entry.driverSessions.delete(handleId);
      if (crashReason && sess.activeTurnId) {
        const turnId = sess.activeTurnId;
        sess.activeTurnId = null;
        for (const listener of [...sess.listeners]) {
          try {
            listener({
              type: 'turn.failed',
              turnId,
              code: 'process_exit',
              failureClass: 'process_exit',
              message: crashReason,
            });
          } catch { /* listener isolation */ }
        }
      }
      sess.listeners.clear();
    }
    const adapter = entry.registeredDrivers.get(driverId);
    entry.registeredDrivers.delete(driverId);
    const registry = this.getRegistry();
    if (!registry) return;
    for (const inst of registry.listInstances()) {
      if (inst.driverId === driverId) {
        registry.unregister(inst.instanceId);
      }
    }
    if (adapter && registry.get(driverId) === adapter) {
      registry.unregister(driverId);
    }
    registry.unregisterDriver(driverId);
  }

  private cleanupPluginDrivers(entry: ActiveIsolatedPlugin, crashReason?: string): void {
    for (const driverId of [...entry.registeredDrivers.keys()]) {
      this.unregisterSinglePluginDriver(entry, driverId, crashReason);
    }
    for (const sess of entry.driverSessions.values()) {
      if (crashReason && sess.activeTurnId) {
        const turnId = sess.activeTurnId;
        sess.activeTurnId = null;
        for (const listener of [...sess.listeners]) {
          try {
            listener({
              type: 'turn.failed',
              turnId,
              code: 'process_exit',
              failureClass: 'process_exit',
              message: crashReason,
            });
          } catch { /* listener isolation */ }
        }
      }
      sess.listeners.clear();
    }
    entry.driverSessions.clear();
  }

  private createProxyHarnessAdapter(
    entry: ActiveIsolatedPlugin,
    desc: PublicHarnessDriverDescriptor,
  ): HarnessAdapter {
    const mapProbe = (res: PublicHarnessProbeResult): HarnessInfo => ({
      id: desc.driverId,
      kind: desc.driverId,
      driverId: desc.driverId,
      instanceId: desc.driverId,
      continuationKey: `${desc.driverId}:instance:${desc.driverId}`,
      displayName: desc.displayName,
      description: desc.description,
      protocolLabel: desc.protocolLabel,
      binaryPath: res?.binaryPath ?? null,
      version: res?.version ?? null,
      health: (res?.health ?? 'unavailable') as HarnessHealth,
      healthMessage: res?.healthMessage,
      capabilities: desc.capabilities,
      capabilitiesV2: res?.capabilitiesV2 ?? desc.capabilitiesV2,
      presentation: res?.presentation ?? desc.presentation,
      models: res?.models ?? [],
      defaultModelId: res?.defaultModelId ?? null,
      accountSummary: res?.accountSummary ?? null,
      isCustom: true,
    });

    const capturedRunId = entry.runId;
    return {
      id: desc.driverId,
      kind: desc.driverId,
      driverId: desc.driverId,
      continuationKey: `${desc.driverId}:instance:${desc.driverId}`,
      displayName: desc.displayName,
      description: desc.description,
      protocolLabel: desc.protocolLabel,
      capabilities: desc.capabilities,
      capabilitiesV2: desc.capabilitiesV2,
      presentation: desc.presentation,
      isCustom: true,
      pluginMcpTransport: desc.pluginMcpTransport,
      probePassive: async () => {
        const res = await entry.process.call<PublicHarnessProbeResult>(
          'host.driver.probePassive',
          { driverId: desc.driverId },
          ISOLATED_TIMEOUTS.command,
          capturedRunId,
        );
        return mapProbe(res);
      },
      probe: async () => {
        const res = await entry.process.call<PublicHarnessProbeResult>(
          'host.driver.probe',
          { driverId: desc.driverId },
          ISOLATED_TIMEOUTS.command,
          capturedRunId,
        );
        return mapProbe(res);
      },
      ...(desc.capabilitiesV2?.supportsUsageLimits
        ? {
            readUsageLimits: async (): Promise<AdapterUsageLimitResult> => {
              const res = await entry.process.call<PublicAdapterUsageLimitResult>(
                'host.driver.readUsageLimits',
                { driverId: desc.driverId },
                ISOLATED_TIMEOUTS.command,
                capturedRunId,
              );
              return {
                loggedIn: Boolean(res?.loggedIn),
                accountLabel: res?.accountLabel ?? null,
                planType: res?.planType ?? null,
                authMethod: res?.authMethod ?? null,
                billingTier: res?.billingTier,
                gatewayUrl: res?.gatewayUrl,
                rateLimits: Array.isArray(res?.rateLimits) ? res.rateLimits : [],
                error: res?.error ?? null,
              };
            },
          }
        : {}),
      createSession: async (config: AdapterSessionConfig): Promise<AdapterSessionHandle> => {
        const handleId = randomUUID();
        const sanitizedConfig = {
          cwd: config.cwd,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          permissionMode: config.permissionMode,
          nativeSessionId: config.nativeSessionId,
          requireNativeResume: config.requireNativeResume,
          handoffContinuity: config.handoffContinuity,
          pluginMcp: config.pluginMcp,
        };
        const created = await entry.process.call<{
          nativeSessionId?: string | null;
          pluginMcpAvailable?: boolean;
          supportsInjectContext?: boolean;
        }>(
          'host.driver.createSession',
          { driverId: desc.driverId, handleId, config: sanitizedConfig },
          ISOLATED_TIMEOUTS.command,
          capturedRunId,
        );
        const sessionEntry: ProxyDriverSessionEntry = {
          driverId: desc.driverId,
          handleId,
          nativeSessionId: created?.nativeSessionId ?? null,
          activeTurnId: null,
          listeners: new Set(),
        };
        entry.driverSessions.set(handleId, sessionEntry);

        return {
          get nativeSessionId() {
            return sessionEntry.nativeSessionId;
          },
          pluginMcpAvailable: created?.pluginMcpAvailable ?? false,
          sendTurn: async (input: TurnInput) => {
            const { contextSync, ...rest } = input;
            const sanitizedContextSync = contextSync
              ? {
                  deltaMarkdown: contextSync.deltaMarkdown,
                  portableItems: contextSync.portableItems,
                  objective: contextSync.objective,
                  isWarmBinding: contextSync.isWarmBinding,
                }
              : null;
            const res = await entry.process.call<{ driverUsed?: ContextInjectionDriver } | undefined>(
              'host.driver.sendTurn',
              { handleId, input: { ...rest, contextSync: sanitizedContextSync } },
              ISOLATED_TIMEOUTS.tool,
              capturedRunId,
            );
            if (contextSync?.onDispatch && res?.driverUsed) {
              contextSync.onDispatch(
                res.driverUsed,
                res.driverUsed === 'codex_inject_items' ? contextSync.portableItems : contextSync.deltaMarkdown,
              );
            }
            return res;
          },
          listSkills: async () => entry.process.call(
            'host.driver.listSkills',
            { handleId },
            ISOLATED_TIMEOUTS.command,
            capturedRunId,
          ),
          runNativeCommand: async (command: string, args: string) => entry.process.call<string>(
            'host.driver.runNativeCommand',
            { handleId, command, args },
            ISOLATED_TIMEOUTS.command,
            capturedRunId,
          ),
          ...(created?.supportsInjectContext
            ? {
                injectContext: async (payload: ContextSyncPayload) => {
                  const sanitizedPayload = {
                    deltaMarkdown: payload.deltaMarkdown,
                    portableItems: payload.portableItems,
                    objective: payload.objective,
                    isWarmBinding: payload.isWarmBinding,
                  };
                  const res = await entry.process.call<{ driverUsed: ContextInjectionDriver }>(
                    'host.driver.injectContext',
                    { handleId, payload: sanitizedPayload },
                    ISOLATED_TIMEOUTS.command,
                    capturedRunId,
                  );
                  if (payload.onDispatch) {
                    payload.onDispatch(
                      res.driverUsed,
                      res.driverUsed === 'codex_inject_items' ? payload.portableItems : payload.deltaMarkdown,
                    );
                  }
                  return res.driverUsed;
                },
              }
            : {}),
          interrupt: async () => {
            await entry.process.call('host.driver.interrupt', { handleId }, ISOLATED_TIMEOUTS.command, capturedRunId);
          },
          resolveApproval: async (nativeRequestId: string, decision: ApprovalDecision, comment?: string) => {
            await entry.process.call(
              'host.driver.resolveApproval',
              { handleId, nativeRequestId, decision, comment },
              ISOLATED_TIMEOUTS.command,
              capturedRunId,
            );
          },
          updateConfig: async (patch: Partial<AdapterSessionConfig>) => {
            await entry.process.call(
              'host.driver.updateConfig',
              { handleId, patch },
              ISOLATED_TIMEOUTS.command,
              capturedRunId,
            );
          },
          dispose: async () => {
            entry.driverSessions.delete(handleId);
            sessionEntry.listeners.clear();
            if (entry.process.alive) {
              await entry.process.call('host.driver.dispose', { handleId }, ISOLATED_TIMEOUTS.dispose, capturedRunId)
                .catch(() => {});
            }
          },
          onEvent: (listener: (event: NormalizedAdapterEvent) => void) => {
            sessionEntry.listeners.add(listener);
            return () => { sessionEntry.listeners.delete(listener); };
          },
        };
      },
    };
  }

  async awaitPendingDisposals(): Promise<void> {
    if (this.pendingDisposals.size) {
      await Promise.allSettled([...this.pendingDisposals]);
    }
  }

  async close(): Promise<void> {
    this.serviceUnsubscribe();
    this.permissionUnsubscribe();
    this.router.abortAllNetStreams();
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    for (const entry of this.active.values()) {
      this.cleanupPluginDrivers(entry);
    }
    const disposals = [...this.active.values()].map(({ process }) => process.dispose());
    this.active.clear();
    await Promise.allSettled([this.cliProcesses.killAll(), ...disposals, ...this.pendingDisposals]);
  }
}
