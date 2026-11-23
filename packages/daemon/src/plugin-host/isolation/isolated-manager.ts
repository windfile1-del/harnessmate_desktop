import {
  PluginApiError,
  isBuiltinPublicService,
  isReservedServiceName,
  isSafePluginUiPath,
  isValidPluginSlotKey,
  normalizePluginSlotKey,
  pluginEventContracts,
  type ApprovalAnnotateEvent,
  type ApprovalAnnotation,
  type HandoffComposeEvent,
  type HandoffOfferDecision,
  type HandoffShouldOfferEvent,
  type PluginEventV4,
  type PluginHandshakeResponse,
  type PluginRuntimeSlotDescriptor,
  type PublicCommandResult,
} from '@harnessmate/plugin-api';
import type { InstalledPluginInfo, Session } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { GLOBAL_WORKSPACE_SCOPE, type PluginPermissionService } from '../permissions/permissions.js';
import type { HostPlugin, PluginHost } from '../runtime/lifecycle.js';
import {
  CrashBackoffTracker,
  ISOLATED_TIMEOUTS,
  IsolatedPluginProcess,
  type CrashPolicy,
} from './isolated-process.js';
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

export interface ActiveIsolatedPlugin {
  pluginId: string;
  runId: string;
  info: InstalledPluginInfo;
  process: IsolatedPluginProcess;
  handshake: PluginHandshakeResponse;
  subscribedEvents: Set<string>;
  commands: Set<string>;
  tools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }>;
  slots: Map<string, PluginRuntimeSlotDescriptor>;
  sections: Map<string, { id: string; order?: number; text: string }>;
  hasHandoffCompose: boolean;
  hasHandoffShouldOffer: boolean;
  hasApprovalAnnotate: boolean;
}

export interface IsolatedManagerOptions {
  store: HarnessMateStore;
  host: PluginHost;
  permissions: PluginPermissionService;
  getPluginInfo: (pluginId: string) => InstalledPluginInfo | undefined;
  requestRestart: (pluginId: string) => Promise<void>;
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
  private nativeCommandRunner?: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>;
  readonly router: IsolatedPluginRpcRouter;

  constructor(private readonly opts: IsolatedManagerOptions) {
    this.nativeCommandRunner = opts.runNativeCommand;
    this.router = new IsolatedPluginRpcRouter({
      store: opts.store,
      host: opts.host,
      permissions: opts.permissions,
      getPluginInfo: (pluginId) => this.active.get(pluginId)?.info ?? opts.getPluginInfo(pluginId),
      isCurrentRun: (pluginId, runId) => this.active.get(pluginId)?.runId === runId,
      onSubscriptionChange: (pluginId, runId, event, subscribed) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        if (subscribed) entry.subscribedEvents.add(event);
        else entry.subscribedEvents.delete(event);
      },
      onDynamicUnregister: (pluginId, runId, kind, name) => {
        const entry = this.active.get(pluginId);
        if (!entry || entry.runId !== runId) return;
        if (kind === 'command') entry.commands.delete(name);
        else if (kind === 'tool') entry.tools.delete(name);
        else if (kind === 'section') entry.sections.delete(name);
        else if (kind === 'slot') entry.slots.delete(name);
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

  listSlots(pluginId: string): PluginRuntimeSlotDescriptor[] {
    const entry = this.active.get(pluginId);
    if (!entry || !entry.process.alive) return [];
    return [...entry.slots.values()];
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
    packageRoot: string;
    entryRelativePath: string;
    digest: string;
    enabled: boolean;
    config?: Readonly<Record<string, unknown>>;
    revision: string;
  }): HostPlugin {
    const { info, packageRoot, entryRelativePath, digest, enabled, config, revision } = params;
    const crashFailure = this.lastCrashReason.get(info.id);
    return {
      id: info.id,
      revision,
      enabled,
      error: crashFailure,
      inject: info.inject,
      provides: info.provides,
      config,
      apply: async (ctx, resolvedConfig) => {
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
          packageRoot,
          entryRelativePath,
          packageDigest: digest,
          config: resolvedConfig,
          declaredPermissions: info.permissions ?? [],
          services: this.opts.host.listServices(),
          onRpc: (method, rpcParams, meta) => this.router.handle(method, rpcParams, meta),
          onExit: (code, signal, stderr) => {
            if (!procRef || this.active.get(info.id)?.process !== procRef) return;
            this.handleUnexpectedCrash(info.id, procRef.runId, code, signal, stderr);
          },
        });
        procRef = proc;

        // Register temporary active entry during handshake so child RPC calls during apply() pass isCurrentRun
        const placeholder: ActiveIsolatedPlugin = {
          pluginId: info.id,
          runId: proc.runId,
          info,
          process: proc,
          handshake: { sdkVersion: '4.0.0' },
          subscribedEvents: new Set(),
          commands: new Set(),
          tools: new Map(),
          slots: new Map(),
          sections: new Map(),
          hasHandoffCompose: false,
          hasHandoffShouldOffer: false,
          hasApprovalAnnotate: false,
        };
        this.active.set(info.id, placeholder);

        ctx.effect(() => () => {
          if (this.active.get(info.id)?.runId === proc.runId) {
            this.active.delete(info.id);
          }
          const task = proc.dispose().finally(() => { this.pendingDisposals.delete(task); });
          this.pendingDisposals.add(task);
        });

        let handshake: PluginHandshakeResponse;
        try {
          handshake = await proc.handshake();
        } catch (error) {
          if (this.active.get(info.id)?.runId === proc.runId) this.active.delete(info.id);
          await proc.dispose();
          throw error;
        }

        placeholder.handshake = handshake;
        for (const ev of handshake.subscribedEvents ?? []) placeholder.subscribedEvents.add(ev);
        for (const cmd of handshake.commands ?? []) placeholder.commands.add(cmd);
        for (const tool of handshake.tools ?? []) placeholder.tools.set(tool.name, tool);
        for (const slotDef of handshake.slots ?? []) {
          if (isValidPluginSlotKey(slotDef.slot) && isSafePluginUiPath(slotDef.ui)) {
            const normalized = normalizePluginSlotKey(slotDef.slot);
            placeholder.slots.set(`${normalized}:${slotDef.id}`, { ...slotDef, slot: normalized });
          }
        }
        for (const sec of handshake.sections ?? []) placeholder.sections.set(sec.id, sec);
        placeholder.hasHandoffCompose = Boolean(handshake.hasHandoffCompose);
        placeholder.hasHandoffShouldOffer = Boolean(handshake.hasHandoffShouldOffer);
        placeholder.hasApprovalAnnotate = Boolean(handshake.hasApprovalAnnotate);

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
          const proxyTarget: Record<string, unknown> = {
            __thirdParty: true,
            __pluginId: info.id,
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
          ctx.provide(serviceName, serviceProxy);
        }
      },
    };
  }

  private handleUnexpectedCrash(
    pluginId: string,
    crashedRunId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    const current = this.active.get(pluginId);
    if (!current || current.runId !== crashedRunId) return;
    this.active.delete(pluginId);

    const tracker = this.crashTrackers.get(pluginId) ?? new CrashBackoffTracker(this.opts.crashPolicy);
    this.crashTrackers.set(pluginId, tracker);
    const outcome = tracker.recordCrash();
    const detail = stderr ? `${code ?? signal ?? 'crash'}: ${stderr.slice(0, 200)}` : `exit ${code ?? signal ?? 'unknown'}`;

    if (outcome.exhausted) {
      const reason = `隔离进程 10 分钟内崩溃 ${outcome.count} 次，已停止重启 (${detail})`;
      this.lastCrashReason.set(pluginId, reason);
      this.opts.host.fail(pluginId, reason);
      return;
    }

    this.opts.host.fail(pluginId, `隔离进程异常退出 (${detail})，将在 ${outcome.delayMs}ms 后退避重启`);
    const existingTimer = this.restartTimers.get(pluginId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.restartTimers.delete(pluginId);
      void this.opts.requestRestart(pluginId).catch(() => {});
    }, outcome.delayMs);
    timer.unref();
    this.restartTimers.set(pluginId, timer);
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

  async runCommand(session: Session, command: string, args: string, expectedRunId?: string): Promise<PublicCommandResult> {
    const entry = [...this.active.values()].find((item) => item.commands.has(command));
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
  ): Promise<string> {
    const entry = this.active.get(pluginId);
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
    const results: ApprovalAnnotation[] = [];
    for (const entry of this.active.values()) {
      if (!entry.process.alive || !entry.hasApprovalAnnotate) continue;
      if (!this.opts.permissions.isGranted(entry.info, 'approvals:annotate', event.workspaceId)) continue;
      try {
        const res = await entry.process.call<{ annotations?: Array<{ risk?: unknown; label?: unknown; detail?: unknown }> }>(
          'host.approval.annotate',
          { event },
          ISOLATED_TIMEOUTS.waterfall,
          entry.runId,
        );
        for (const item of res?.annotations ?? []) {
          if (typeof item?.label !== 'string' || !item.label.trim()) continue;
          const risk = item.risk === 'low' || item.risk === 'medium' || item.risk === 'high' ? item.risk : undefined;
          results.push({
            pluginId: entry.pluginId,
            risk,
            label: item.label.trim().slice(0, 120),
            detail: typeof item.detail === 'string' ? item.detail.slice(0, 500) : undefined,
          });
        }
      } catch {
        // Annotation errors never block approval flow
      }
    }
    return results;
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

  async awaitPendingDisposals(): Promise<void> {
    if (this.pendingDisposals.size) {
      await Promise.allSettled([...this.pendingDisposals]);
    }
  }

  async close(): Promise<void> {
    this.serviceUnsubscribe();
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    const disposals = [...this.active.values()].map(({ process }) => process.dispose());
    this.active.clear();
    await Promise.allSettled([...disposals, ...this.pendingDisposals]);
  }
}
