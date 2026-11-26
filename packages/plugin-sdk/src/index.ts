export * from '@harnessmate/plugin-api';
export { z as Schema } from 'zod';
export * from './scaffold.js';

import {
  PLUGIN_API_VERSION,
  PluginApiError,
  isSafePluginUiPath,
  isValidPluginSlotKey,
  normalizeAnyPluginSlotKey,
  type Disposer,
  type HandoffRedactEvent,
  type HandoffRedactResult,
  type IsolatedPluginContext,
  type IsolatedPluginContextV5,
  type ManagedCliProcessHandle,
  type PluginErrorCode,
  type PluginEventName,
  type PluginEventV4,
  type PluginHandshakeRequest,
  type PluginHandshakeResponse,
  type PluginHarnessDriverRegistration,
  type PluginHarnessSessionHandle,
  type PluginModule,
  type PluginRpcMessage,
  type PluginRpcResponse,
  type PluginRuntimeSlotDescriptor,
  type PublicAdapterSessionConfig,
  type PublicApprovalDecision,
  type PublicDriverContextSyncPayload,
  type PublicDriverTurnInput,
  type PublicHarnessDriverDescriptor,
  type PublicNetStreamHandle,
  type PublicNetStreamInit,
  type PublicSlotRegistration,
  type ServiceImplementation,
  type SpawnCliSpec,
} from '@harnessmate/plugin-api';

export const PLUGIN_SDK_VERSION = '4.0.0';

export function definePlugin<Ctx extends IsolatedPluginContext = IsolatedPluginContextV5>(
  module: PluginModule<Ctx>,
): PluginModule<Ctx> {
  return module;
}

export interface RpcTransport {
  send(message: PluginRpcMessage): void;
  onMessage(listener: (message: PluginRpcMessage) => void): Disposer;
}

/**
 * Transport-agnostic isolated plugin RPC session (usable in Node child processes and future WASM hosts).
 */
export function createIsolatedPluginSession<Ctx extends IsolatedPluginContext = IsolatedPluginContextV5>(
  transport: RpcTransport,
  loadModule: () => Promise<PluginModule<Ctx>>,
) {
  let activeRunId = '';
  let disposed = false;
  let handshakeCompleted = false;
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const effects = new Set<Disposer>();
  const eventListeners = new Map<string, Set<(event: PluginEventV4) => void | Promise<void>>>();
  const commandHandlers = new Map<string, (input: never) => unknown>();
  const toolHandlers = new Map<string, { meta: { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }; handler: (input: Record<string, unknown>, meta: { sessionId: string; workspaceId: string }) => unknown }>();
  const slotHandlers = new Map<string, { meta: PluginRuntimeSlotDescriptor; onMessage?: PublicSlotRegistration['onMessage'] }>();
  const providedServices = new Map<string, ServiceImplementation>();
  const sections = new Map<string, { id: string; order?: number; text: string }>();
  const composeListeners = new Set<(event: never) => unknown>();
  const offerListeners = new Set<(event: never) => unknown>();
  const annotateListeners = new Set<(event: never) => unknown>();
  const redactListeners = new Set<(input: HandoffRedactEvent) => Promise<HandoffRedactResult> | HandoffRedactResult>();
  const configListeners = new Set<(config: Readonly<Record<string, unknown>>) => void | Promise<void>>();
  const driverHandlers = new Map<string, {
    descriptor: PublicHarnessDriverDescriptor;
    driver: PluginHarnessDriverRegistration;
  }>();
  const driverSessions = new Map<string, {
    driverId: string;
    handle: PluginHarnessSessionHandle;
    unsubscribeEvent: Disposer;
  }>();
  const cliProcesses = new Map<string, {
    stdoutListeners: Set<(chunk: string) => void>;
    stderrListeners: Set<(chunk: string) => void>;
    exitListeners: Set<(info: { code: number | null; signal: string | null }) => void>;
    waiters: Array<{ resolve: (info: { code: number | null; signal: string | null }) => void; reject: (err: Error) => void }>;
    stdoutBuffer: string[];
    stderrBuffer: string[];
    exitInfo?: { code: number | null; signal: string | null };
  }>();
  const earlyCliEvents = new Map<string, Array<{
    type: 'stdout' | 'stderr' | 'exit';
    chunk?: string;
    code?: number | null;
    signal?: string | null;
  }>>();
  const netStreams = new Map<string, {
    chunkListeners: Set<(chunk: string) => void>;
    endListeners: Set<() => void>;
    errorListeners: Set<(message: string) => void>;
    chunkBuffer: string[];
    ended: boolean;
    errorMessage?: string;
  }>();
  const earlyNetStreamEvents = new Map<string, Array<{
    type: 'chunk' | 'end' | 'error';
    chunk?: string;
    message?: string;
  }>>();
  let availableServices = new Set<string>();
  let hostFeatures = new Set<string>();

  const assertActive = () => {
    if (disposed || !activeRunId) throw new PluginApiError('E_STALE_RUN', '插件实例已停止');
  };

  const rpcCall = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
    assertActive();
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.send({ jsonrpc: '2.0', id, runId: activeRunId, method, params });
    });
  };

  const rpcNotify = (method: string, params?: Record<string, unknown>): void => {
    if (disposed || !activeRunId) return;
    transport.send({ jsonrpc: '2.0', runId: activeRunId, method, params });
  };

  const registerEffect = (activate: () => Disposer): Disposer => {
    assertActive();
    const dispose = activate();
    const undo: Disposer = () => {
      if (effects.delete(undo)) dispose();
    };
    effects.add(undo);
    return undo;
  };

  const createServiceProxy = (serviceName: string) => new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => rpcCall('service.call', { service: serviceName, method: prop, args });
    },
  });

  const toDriverDescriptor = (driver: PluginHarnessDriverRegistration): PublicHarnessDriverDescriptor => ({
    driverId: driver.driverId,
    displayName: driver.displayName,
    description: driver.description,
    protocolLabel: driver.protocolLabel,
    capabilities: driver.capabilities,
    ...(driver.capabilitiesV2 ? { capabilitiesV2: driver.capabilitiesV2 } : {}),
    ...(driver.presentation ? { presentation: driver.presentation } : {}),
    ...(driver.pluginMcpTransport ? { pluginMcpTransport: driver.pluginMcpTransport } : {}),
  });

  const buildContext = (handshake: PluginHandshakeRequest): IsolatedPluginContextV5 => {
    const subscribe = <Name extends PluginEventName>(
      name: Name,
      listener: (event: PluginEventV4<Name>) => void | Promise<void>,
    ): Disposer => registerEffect(() => {
      const set = eventListeners.get(name) ?? new Set();
      eventListeners.set(name, set);
      const wrapped = (event: PluginEventV4) => listener(event as PluginEventV4<Name>);
      set.add(wrapped);
      rpcNotify('events.subscribe', { event: name });
      return () => {
        set.delete(wrapped);
        if (set.size === 0) {
          eventListeners.delete(name);
          rpcNotify('events.unsubscribe', { event: name });
        }
      };
    });

    return {
      runId: handshake.runId,
      pluginId: handshake.pluginId,
      api: {
        version: PLUGIN_API_VERSION,
        has: (feature: string) => {
          assertActive();
          return hostFeatures.has(feature) || availableServices.has(feature);
        },
      },
      logger: {
        debug: (message, meta) => rpcNotify('log', { level: 'debug', message, meta }),
        info: (message, meta) => rpcNotify('log', { level: 'info', message, meta }),
        warn: (message, meta) => rpcNotify('log', { level: 'warn', message, meta }),
        error: (message, meta) => rpcNotify('log', { level: 'error', message, meta }),
      },
      effect: registerEffect,
      get: <Service = unknown>(name: string) => {
        assertActive();
        if (!availableServices.has(name)) return undefined;
        return createServiceProxy(name) as Service;
      },
      provide: (name: string, service: ServiceImplementation): Disposer => registerEffect(() => {
        if (providedServices.has(name)) throw new PluginApiError('E_CONFLICT', `服务 ${name} 已注册`);
        providedServices.set(name, service);
        return () => {
          providedServices.delete(name);
          rpcNotify('service.unprovide', { name });
        };
      }),
      on: subscribe,
      commands: {
        register: (command, handler) => registerEffect(() => {
          if (commandHandlers.has(command)) throw new PluginApiError('E_CONFLICT', `命令 /${command} 已注册`);
          commandHandlers.set(command, handler as (input: never) => unknown);
          return () => {
            commandHandlers.delete(command);
            rpcNotify('commands.unregister', { command });
          };
        }),
      },
      events: {
        on: subscribe,
        query: (filter) => rpcCall('events.query', filter as unknown as Record<string, unknown>),
      },
      sessions: {
        list: (filter) => rpcCall('sessions.list', (filter ?? {}) as Record<string, unknown>),
        get: (sessionId) => rpcCall('sessions.get', { sessionId }),
        capabilities: (sessionId) => rpcCall('sessions.capabilities', { sessionId }),
        prepareTurn: (sessionId, input) => rpcCall('sessions.prepareTurn', { sessionId, ...input }),
        runNative: (sessionId, command, args) => rpcCall('sessions.runNative', { sessionId, command, args }),
        listItems: (sessionId, opts) => rpcCall('sessions.listItems', { sessionId, ...(opts ?? {}) }),
        getItem: (sessionId, itemId, opts) => rpcCall('sessions.getItem', { sessionId, itemId, ...(opts ?? {}) }),
        getBindings: (sessionId) => rpcCall('sessions.getBindings', { sessionId }),
        fork: (sessionId, opts) => rpcCall('sessions.fork', { sessionId, ...(opts ?? {}) }),
        switchInstance: async (sessionId, opts) => {
          await rpcCall('sessions.switchInstance', { sessionId, ...opts });
        },
        postNotice: async (sessionId, notice) => {
          await rpcCall('sessions.postNotice', { sessionId, notice });
        },
      },
      harnesses: {
        registerDriver: (driver) => registerEffect(() => {
          const driverId = typeof driver?.driverId === 'string' ? driver.driverId.trim() : '';
          if (!driverId) {
            throw new PluginApiError('E_INVALID_INPUT', '驱动注册缺少 driverId');
          }
          if (driverId === 'codex' || driverId === 'claude' || driverId === 'agy' || driverId === 'acp') {
            throw new PluginApiError('E_PERMISSION_DENIED', `禁止覆盖内置 Harness 驱动: ${driverId}`);
          }
          if (driverHandlers.has(driverId)) {
            throw new PluginApiError('E_CONFLICT', `驱动 ${driverId} 已注册`);
          }
          if (typeof driver.probe !== 'function' || typeof driver.createSession !== 'function') {
            throw new PluginApiError('E_INVALID_INPUT', `驱动 ${driverId} 缺少 probe 或 createSession 方法`);
          }
          const descriptor = toDriverDescriptor(driver);
          driverHandlers.set(driverId, { descriptor, driver });
          if (handshakeCompleted) {
            rpcNotify('harnesses.registerDriver', { driver: descriptor });
          }
          return () => {
            driverHandlers.delete(driverId);
            for (const [handleId, sess] of [...driverSessions.entries()]) {
              if (sess.driverId !== driverId) continue;
              driverSessions.delete(handleId);
              try { sess.unsubscribeEvent(); } catch { /* ignore */ }
              void Promise.resolve(sess.handle.dispose()).catch(() => {});
            }
            rpcNotify('harnesses.unregisterDriver', { driverId });
          };
        }),
        listInstances: () => rpcCall('harnesses.listInstances', {}),
      },
      runtime: {
        trustedLocal: handshake.trustedLocal === true,
        spawnCli: async (spec: SpawnCliSpec): Promise<ManagedCliProcessHandle> => {
          const spawned = await rpcCall<{ processId: string; pid: number }>(
            'runtime.spawnCli',
            spec as unknown as Record<string, unknown>,
          );
          const processId = spawned.processId;
          const entry = {
            stdoutListeners: new Set<(chunk: string) => void>(),
            stderrListeners: new Set<(chunk: string) => void>(),
            exitListeners: new Set<(info: { code: number | null; signal: string | null }) => void>(),
            waiters: [] as Array<{ resolve: (info: { code: number | null; signal: string | null }) => void; reject: (err: Error) => void }>,
            stdoutBuffer: [] as string[],
            stderrBuffer: [] as string[],
            exitInfo: undefined as { code: number | null; signal: string | null } | undefined,
          };
          cliProcesses.set(processId, entry);

          const early = earlyCliEvents.get(processId);
          if (early) {
            earlyCliEvents.delete(processId);
            for (const ev of early) {
              if (ev.type === 'stdout' && ev.chunk !== undefined) {
                entry.stdoutBuffer.push(ev.chunk);
              } else if (ev.type === 'stderr' && ev.chunk !== undefined) {
                entry.stderrBuffer.push(ev.chunk);
              } else if (ev.type === 'exit') {
                entry.exitInfo = { code: ev.code ?? null, signal: ev.signal ?? null };
              }
            }
          }

          registerEffect(() => () => {
            const current = cliProcesses.get(processId);
            if (current) {
              cliProcesses.delete(processId);
              for (const waiter of current.waiters) {
                waiter.reject(new PluginApiError('E_STALE_RUN', '插件实例已卸载'));
              }
              current.waiters.length = 0;
            }
            if (!disposed && activeRunId) {
              rpcNotify('runtime.cli.kill', { processId, signal: 'SIGKILL' });
            }
          });

          return {
            processId,
            pid: spawned.pid,
            writeStdin: async (data) => {
              await rpcCall('runtime.cli.writeStdin', { processId, data });
            },
            closeStdin: async () => {
              await rpcCall('runtime.cli.closeStdin', { processId });
            },
            kill: async (signal) => {
              await rpcCall('runtime.cli.kill', { processId, signal });
            },
            onStdout: (listener) => {
              entry.stdoutListeners.add(listener);
              if (entry.stdoutBuffer.length > 0) {
                const buffered = entry.stdoutBuffer.splice(0, entry.stdoutBuffer.length);
                for (const chunk of buffered) listener(chunk);
              }
              return () => { entry.stdoutListeners.delete(listener); };
            },
            onStderr: (listener) => {
              entry.stderrListeners.add(listener);
              if (entry.stderrBuffer.length > 0) {
                const buffered = entry.stderrBuffer.splice(0, entry.stderrBuffer.length);
                for (const chunk of buffered) listener(chunk);
              }
              return () => { entry.stderrListeners.delete(listener); };
            },
            onExit: (listener) => {
              entry.exitListeners.add(listener);
              if (entry.exitInfo) {
                const info = entry.exitInfo;
                void Promise.resolve().then(() => listener(info));
              }
              return () => { entry.exitListeners.delete(listener); };
            },
            wait: () => {
              if (entry.exitInfo) return Promise.resolve(entry.exitInfo);
              if (disposed || !activeRunId) {
                return Promise.reject(new PluginApiError('E_STALE_RUN', '插件实例已卸载'));
              }
              return new Promise((resolve, reject) => {
                entry.waiters.push({ resolve, reject });
              });
            },
          };
        },
      },
      ledger: {
        get: (sessionId) => rpcCall('ledger.get', { sessionId }),
        append: (sessionId, entry) => rpcCall('ledger.append', { sessionId, entry }),
      },
      handoff: {
        section: (def) => registerEffect(() => {
          sections.set(def.id, def);
          return () => {
            sections.delete(def.id);
            rpcNotify('handoff.section.unregister', { id: def.id });
          };
        }),
        onCompose: (listener) => registerEffect(() => {
          composeListeners.add(listener as (event: never) => unknown);
          return () => { composeListeners.delete(listener as (event: never) => unknown); };
        }),
        onShouldOffer: (listener) => registerEffect(() => {
          offerListeners.add(listener as (event: never) => unknown);
          return () => { offerListeners.delete(listener as (event: never) => unknown); };
        }),
        onRedact: (listener) => registerEffect(() => {
          redactListeners.add(listener);
          return () => { redactListeners.delete(listener); };
        }),
        preview: (sessionId, targetInstanceId) => rpcCall('handoff.preview', { sessionId, targetInstanceId }),
      },
      composer: {
        suggest: (sessionId, suggestion) => rpcCall('composer.suggest', { sessionId, suggestion }),
      },
      approvals: {
        annotate: (approvalId, note) => rpcCall('approvals.annotate', { approvalId, note }),
        onAnnotate: (listener) => registerEffect(() => {
          annotateListeners.add(listener as (event: never) => unknown);
          return () => { annotateListeners.delete(listener as (event: never) => unknown); };
        }),
      },
      tools: {
        register: (tool) => registerEffect(() => {
          if (toolHandlers.has(tool.name)) throw new PluginApiError('E_CONFLICT', `工具 ${tool.name} 已注册`);
          toolHandlers.set(tool.name, {
            meta: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, readOnly: tool.readOnly },
            handler: tool.handler,
          });
          return () => {
            toolHandlers.delete(tool.name);
            rpcNotify('tools.unregister', { name: tool.name });
          };
        }),
      },
      slots: {
        register: (def) => registerEffect(() => {
          if (!isValidPluginSlotKey(def.slot)) {
            throw new PluginApiError('E_INVALID_INPUT', `无效的 UI 插槽 ${String(def.slot)}`);
          }
          if (!isSafePluginUiPath(def.ui)) {
            throw new PluginApiError('E_INVALID_INPUT', `无效的 UI 入口路径 ${String(def.ui)}`);
          }
          const normalizedSlot = normalizeAnyPluginSlotKey(def.slot);
          const slotKey = `${normalizedSlot}:${def.id}`;
          if (slotHandlers.has(slotKey)) throw new PluginApiError('E_CONFLICT', `插槽项 ${slotKey} 已注册`);
          slotHandlers.set(slotKey, {
            meta: {
              slot: normalizedSlot,
              id: def.id,
              title: def.title,
              ui: def.ui,
              order: def.order,
              key: def.key,
              height: def.height,
            },
            onMessage: def.onMessage,
          });
          return () => {
            slotHandlers.delete(slotKey);
            rpcNotify('slots.unregister', { slot: normalizedSlot, id: def.id });
          };
        }),
      },
      storage: {
        plugin: {
          get: (key) => rpcCall('storage.plugin.get', { key }),
          set: (key, value) => rpcCall('storage.plugin.set', { key, value }),
          delete: (key) => rpcCall('storage.plugin.delete', { key }),
          keys: () => rpcCall('storage.plugin.keys', {}),
        },
        workspace: {
          get: (workspaceId, key) => rpcCall('storage.workspace.get', { workspaceId, key }),
          set: (workspaceId, key, value) => rpcCall('storage.workspace.set', { workspaceId, key, value }),
          delete: (workspaceId, key) => rpcCall('storage.workspace.delete', { workspaceId, key }),
          keys: (workspaceId) => rpcCall('storage.workspace.keys', { workspaceId }),
        },
      },
      fs: {
        read: (workspaceId, relativePath) => rpcCall('fs.read', { workspaceId, relativePath }),
        list: (workspaceId, relativePath) => rpcCall('fs.list', { workspaceId, relativePath }),
        stat: (workspaceId, relativePath) => rpcCall('fs.stat', { workspaceId, relativePath }),
        write: (workspaceId, relativePath, content) => rpcCall('fs.write', { workspaceId, relativePath, content }),
      },
      net: {
        fetch: (url, init) => rpcCall('net.fetch', { url, init }),
        openStream: async (url: string, init?: PublicNetStreamInit): Promise<PublicNetStreamHandle> => {
          const opened = await rpcCall<{
            streamId: string;
            status: number;
            ok: boolean;
            headers?: Record<string, string>;
          }>('net.stream.open', { url, init });
          const streamId = opened.streamId;
          const entry = {
            chunkListeners: new Set<(chunk: string) => void>(),
            endListeners: new Set<() => void>(),
            errorListeners: new Set<(message: string) => void>(),
            chunkBuffer: [] as string[],
            ended: false,
            errorMessage: undefined as string | undefined,
          };
          netStreams.set(streamId, entry);

          const early = earlyNetStreamEvents.get(streamId);
          if (early) {
            earlyNetStreamEvents.delete(streamId);
            for (const ev of early) {
              if (ev.type === 'chunk' && ev.chunk !== undefined) entry.chunkBuffer.push(ev.chunk);
              else if (ev.type === 'end') entry.ended = true;
              else if (ev.type === 'error') entry.errorMessage = ev.message;
            }
          }

          registerEffect(() => () => {
            netStreams.delete(streamId);
            if (!disposed && activeRunId) rpcNotify('net.stream.close', { streamId });
          });

          return {
            streamId,
            status: opened.status,
            ok: opened.ok,
            headers: opened.headers ?? {},
            onChunk(listener) {
              entry.chunkListeners.add(listener);
              if (entry.chunkBuffer.length > 0) {
                for (const c of entry.chunkBuffer.splice(0, entry.chunkBuffer.length)) listener(c);
              }
              return () => { entry.chunkListeners.delete(listener); };
            },
            onEnd(listener) {
              entry.endListeners.add(listener);
              if (entry.ended) void Promise.resolve().then(() => listener());
              return () => { entry.endListeners.delete(listener); };
            },
            onError(listener) {
              entry.errorListeners.add(listener);
              if (entry.errorMessage !== undefined) {
                const msg = entry.errorMessage;
                void Promise.resolve().then(() => listener(msg));
              }
              return () => { entry.errorListeners.delete(listener); };
            },
            async close() {
              netStreams.delete(streamId);
              await rpcCall('net.stream.close', { streamId }).catch(() => {});
            },
          };
        },
      },
      secrets: {
        resolve: (secretRef: string) =>
          rpcCall<{ value?: string | null }>('secrets.resolve', { secretRef }).then((res) => res?.value ?? null),
      },
      notify: {
        send: (input) => rpcCall('notify.send', input as unknown as Record<string, unknown>),
      },
      clipboard: {
        writeText: (text, workspaceId) => rpcCall('clipboard.writeText', { text, workspaceId }),
      },
      onConfigUpdated: (listener) => registerEffect(() => {
        configListeners.add(listener);
        return () => { configListeners.delete(listener); };
      }),
    };
  };

  const respond = (id: number, runId: string, result?: unknown, error?: { code: PluginErrorCode | 'E_INTERNAL'; message: string }) => {
    const payload: PluginRpcResponse = error
      ? { jsonrpc: '2.0', id, runId, error }
      : { jsonrpc: '2.0', id, runId, result };
    transport.send(payload);
  };

  const disposeAll = () => {
    disposed = true;
    for (const undo of [...effects].reverse()) {
      try { undo(); } catch { /* best-effort cleanup */ }
    }
    effects.clear();
    earlyCliEvents.clear();
    earlyNetStreamEvents.clear();
    netStreams.clear();
    for (const req of pending.values()) req.reject(new PluginApiError('E_STALE_RUN', '插件实例已卸载'));
    pending.clear();
  };

  const handleMessage = async (message: PluginRpcMessage) => {
    if (!('method' in message)) {
      const req = pending.get(message.id);
      if (!req) return;
      pending.delete(message.id);
      if (message.error) {
        req.reject(message.error.code === 'E_INTERNAL'
          ? new Error(message.error.message)
          : new PluginApiError(message.error.code, message.error.message));
      } else {
        req.resolve(message.result);
      }
      return;
    }

    const id = 'id' in message ? message.id : undefined;
    const method = message.method;
    const params = message.params ?? {};

    if (method !== 'host.handshake' && message.runId !== activeRunId) {
      if (id !== undefined) respond(id, message.runId, undefined, { code: 'E_STALE_RUN', message: '实例标识不匹配' });
      return;
    }

    try {
      let result: unknown;
      if (method === 'host.handshake') {
        const handshake = params as unknown as PluginHandshakeRequest;
        activeRunId = handshake.runId;
        hostFeatures = new Set(handshake.features);
        availableServices = new Set(handshake.services);
        const mod = await loadModule();
        if (typeof mod.apply !== 'function') {
          throw new PluginApiError('E_INVALID_INPUT', 'V4 插件入口必须导出 apply(ctx, config)');
        }
        const unsupported = (mod.requires ?? []).filter((feature) => !hostFeatures.has(feature));
        if (unsupported.length) {
          throw new PluginApiError('E_NOT_SUPPORTED', `宿主不支持插件要求的特性: ${unsupported.join(', ')}`);
        }
        const ctx = buildContext(handshake);
        await mod.apply(ctx as unknown as Ctx, handshake.config);
        handshakeCompleted = true;
        const serviceMethods: Record<string, string[]> = {};
        for (const [serviceName, impl] of providedServices) {
          serviceMethods[serviceName] = Object.keys(impl).filter((key) => typeof impl[key] === 'function');
        }
        result = {
          sdkVersion: PLUGIN_SDK_VERSION,
          name: mod.name,
          requires: mod.requires,
          inject: mod.inject,
          optional: mod.optional,
          provides: [...providedServices.keys()],
          serviceMethods,
          commands: [...commandHandlers.keys()],
          tools: [...toolHandlers.values()].map(({ meta }) => meta),
          slots: [...slotHandlers.values()].map(({ meta }) => meta),
          sections: [...sections.values()],
          subscribedEvents: [...eventListeners.keys()],
          hasHandoffCompose: composeListeners.size > 0,
          hasHandoffShouldOffer: offerListeners.size > 0,
          hasApprovalAnnotate: annotateListeners.size > 0,
          hasHandoffRedact: redactListeners.size > 0,
          registeredDrivers: [...driverHandlers.values()].map(({ descriptor }) => descriptor),
        } satisfies PluginHandshakeResponse;
      } else if (method === 'host.services.sync') {
        availableServices = new Set(Array.isArray(params.services) ? params.services as string[] : []);
        result = { ok: true };
      } else if (method === 'host.dispose') {
        disposeAll();
        result = { ok: true };
      } else if (method === 'host.event') {
        const event = params.event as PluginEventV4;
        const listeners = [...(eventListeners.get(event.type) ?? [])];
        for (const listener of listeners) await listener(event);
        result = { ok: true };
      } else if (method === 'host.command') {
        const handler = commandHandlers.get(String(params.command));
        if (!handler) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册命令 /${String(params.command)}`);
        result = await handler(params.input as never);
      } else if (method === 'host.tool') {
        const tool = toolHandlers.get(String(params.name));
        if (!tool) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册工具 ${String(params.name)}`);
        result = await tool.handler(
          (params.input ?? {}) as Record<string, unknown>,
          (params.meta ?? { sessionId: '', workspaceId: '' }) as { sessionId: string; workspaceId: string },
        );
      } else if (method === 'host.service.call') {
        const serviceName = String(params.service);
        const methodName = String(params.method);
        const impl = providedServices.get(serviceName);
        const fn = impl?.[methodName];
        if (typeof fn !== 'function') {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${serviceName}.${methodName} 不可用`);
        }
        const args = Array.isArray(params.args) ? params.args : [];
        result = await fn(...args);
      } else if (method === 'host.handoff.compose') {
        const collected: unknown[] = [];
        for (const listener of [...composeListeners]) {
          const out = await listener(params.event as never);
          if (Array.isArray(out)) collected.push(...out);
          else if (out) collected.push(out);
        }
        result = { sections: collected };
      } else if (method === 'host.handoff.shouldOffer') {
        let decision: unknown;
        for (const listener of [...offerListeners]) {
          const out = await listener(params.event as never);
          if (out !== undefined) {
            decision = out;
            break;
          }
        }
        result = { decision };
      } else if (method === 'host.handoff.redact') {
        const event = params as unknown as HandoffRedactEvent;
        let currentText = typeof event.text === 'string' ? event.text : '';
        const categories: string[] = [];
        for (const listener of [...redactListeners]) {
          const out = await listener({ ...event, text: currentText });
          if (!out || typeof out.text !== 'string' || !Array.isArray(out.categories)) {
            throw new PluginApiError('E_INVALID_INPUT', 'handoff.onRedact 必须返回 { text, categories }');
          }
          currentText = out.text;
          for (const cat of out.categories) {
            if (typeof cat === 'string' && cat) categories.push(cat);
          }
        }
        result = { text: currentText, categories };
      } else if (method === 'host.approval.annotate') {
        const annotations: unknown[] = [];
        for (const listener of [...annotateListeners]) {
          const out = await listener(params.event as never);
          if (out) annotations.push(out);
        }
        result = { annotations };
      } else if (method === 'host.slot.message') {
        const slotId = String(params.slotId ?? '');
        const slotName = params.slot ? normalizeAnyPluginSlotKey(String(params.slot)) : '';
        const entry = slotName
          ? slotHandlers.get(`${slotName}:${slotId}`)
          : [...slotHandlers.values()].find(({ meta }) => meta.id === slotId);
        if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册插槽项 ${slotId}`);
        if (!entry.onMessage) {
          result = { handled: false };
        } else {
          result = await entry.onMessage(params.payload, {
            sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
            slotId,
          });
        }
      } else if (method === 'host.config.updated') {
        const config = (params.config ?? {}) as Readonly<Record<string, unknown>>;
        for (const listener of [...configListeners]) await listener(config);
        result = { ok: true };
      } else if (method === 'host.cli.output') {
        const processId = String(params.processId ?? '');
        const stream = params.stream === 'stderr' ? 'stderr' : 'stdout';
        const chunk = typeof params.chunk === 'string' ? params.chunk : '';
        const entry = cliProcesses.get(processId);
        if (!entry) {
          const buf = earlyCliEvents.get(processId) ?? [];
          buf.push({ type: stream, chunk });
          earlyCliEvents.set(processId, buf);
        } else if (stream === 'stdout') {
          if (entry.stdoutListeners.size === 0) entry.stdoutBuffer.push(chunk);
          else for (const listener of [...entry.stdoutListeners]) listener(chunk);
        } else {
          if (entry.stderrListeners.size === 0) entry.stderrBuffer.push(chunk);
          else for (const listener of [...entry.stderrListeners]) listener(chunk);
        }
        result = { ok: true };
      } else if (method === 'host.cli.exit') {
        const processId = String(params.processId ?? '');
        const info = {
          code: typeof params.code === 'number' ? params.code : null,
          signal: typeof params.signal === 'string' ? params.signal : null,
        };
        const entry = cliProcesses.get(processId);
        if (!entry) {
          const buf = earlyCliEvents.get(processId) ?? [];
          buf.push({ type: 'exit', ...info });
          earlyCliEvents.set(processId, buf);
        } else if (!entry.exitInfo) {
          entry.exitInfo = info;
          for (const listener of [...entry.exitListeners]) listener(info);
          for (const waiter of entry.waiters.splice(0, entry.waiters.length)) waiter.resolve(info);
        }
        result = { ok: true };
      } else if (method === 'host.net.stream.chunk') {
        const streamId = String(params.streamId ?? '');
        const chunk = typeof params.chunk === 'string' ? params.chunk : '';
        const entry = netStreams.get(streamId);
        if (!entry) {
          const buf = earlyNetStreamEvents.get(streamId) ?? [];
          buf.push({ type: 'chunk', chunk });
          earlyNetStreamEvents.set(streamId, buf);
        } else if (entry.chunkListeners.size === 0) {
          entry.chunkBuffer.push(chunk);
        } else {
          for (const listener of [...entry.chunkListeners]) listener(chunk);
        }
        result = { ok: true };
      } else if (method === 'host.net.stream.end') {
        const streamId = String(params.streamId ?? '');
        const entry = netStreams.get(streamId);
        if (!entry) {
          const buf = earlyNetStreamEvents.get(streamId) ?? [];
          buf.push({ type: 'end' });
          earlyNetStreamEvents.set(streamId, buf);
        } else if (!entry.ended) {
          entry.ended = true;
          for (const listener of [...entry.endListeners]) listener();
        }
        result = { ok: true };
      } else if (method === 'host.net.stream.error') {
        const streamId = String(params.streamId ?? '');
        const msg = typeof params.message === 'string' ? params.message : 'Stream error';
        const entry = netStreams.get(streamId);
        if (!entry) {
          const buf = earlyNetStreamEvents.get(streamId) ?? [];
          buf.push({ type: 'error', message: msg });
          earlyNetStreamEvents.set(streamId, buf);
        } else {
          entry.errorMessage = msg;
          for (const listener of [...entry.errorListeners]) listener(msg);
        }
        result = { ok: true };
      } else if (method === 'host.driver.probe' || method === 'host.driver.probePassive') {
        const driverId = String(params.driverId ?? '');
        const entry = driverHandlers.get(driverId);
        if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册驱动 ${driverId}`);
        if (method === 'host.driver.probePassive' && typeof entry.driver.probePassive === 'function') {
          result = await entry.driver.probePassive();
        } else {
          result = await entry.driver.probe();
        }
      } else if (method === 'host.driver.readUsageLimits') {
        const driverId = String(params.driverId ?? '');
        const entry = driverHandlers.get(driverId);
        if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册驱动 ${driverId}`);
        if (typeof entry.driver.readUsageLimits !== 'function') {
          throw new PluginApiError('E_NOT_SUPPORTED', '驱动未实现 readUsageLimits');
        }
        result = await entry.driver.readUsageLimits();
      } else if (method === 'host.driver.createSession') {
        const driverId = String(params.driverId ?? '');
        const handleId = String(params.handleId ?? '');
        const entry = driverHandlers.get(driverId);
        if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `未注册驱动 ${driverId}`);
        const handle = await entry.driver.createSession((params.config ?? {}) as PublicAdapterSessionConfig);
        const unsubscribeEvent = handle.onEvent((event) => {
          rpcNotify('driver.session.event', { handleId, event });
        });
        driverSessions.set(handleId, { driverId, handle, unsubscribeEvent });
        result = {
          nativeSessionId: handle.nativeSessionId ?? null,
          pluginMcpAvailable: handle.pluginMcpAvailable ?? false,
          supportsInjectContext: typeof handle.injectContext === 'function',
        };
      } else if (method === 'host.driver.sendTurn') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        result = (await sess.handle.sendTurn((params.input ?? {}) as PublicDriverTurnInput)) ?? {};
      } else if (method === 'host.driver.injectContext') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        if (!sess.handle.injectContext) throw new PluginApiError('E_NOT_SUPPORTED', '驱动不支持 injectContext');
        const driverUsed = await sess.handle.injectContext((params.payload ?? {}) as PublicDriverContextSyncPayload);
        result = { driverUsed };
      } else if (method === 'host.driver.interrupt') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        await sess.handle.interrupt();
        result = { ok: true };
      } else if (method === 'host.driver.resolveApproval') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        await sess.handle.resolveApproval(
          String(params.nativeRequestId ?? ''),
          params.decision as PublicApprovalDecision,
          typeof params.comment === 'string' ? params.comment : undefined,
        );
        result = { ok: true };
      } else if (method === 'host.driver.updateConfig') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        if (sess.handle.updateConfig) {
          await sess.handle.updateConfig((params.patch ?? {}) as Partial<PublicAdapterSessionConfig>);
        }
        result = { ok: true };
      } else if (method === 'host.driver.listSkills') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        result = sess.handle.listSkills ? await sess.handle.listSkills() : [];
      } else if (method === 'host.driver.runNativeCommand') {
        const sess = driverSessions.get(String(params.handleId ?? ''));
        if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
        if (!sess.handle.runNativeCommand) throw new PluginApiError('E_NOT_SUPPORTED', '驱动不支持 runNativeCommand');
        result = await sess.handle.runNativeCommand(String(params.command ?? ''), String(params.args ?? ''));
      } else if (method === 'host.driver.dispose') {
        const handleId = String(params.handleId ?? '');
        const sess = driverSessions.get(handleId);
        if (sess) {
          driverSessions.delete(handleId);
          try { sess.unsubscribeEvent(); } catch { /* ignore */ }
          await sess.handle.dispose();
        }
        result = { ok: true };
      } else {
        throw new PluginApiError('E_NOT_SUPPORTED', `未知 RPC 方法 ${method}`);
      }

      if (id !== undefined) respond(id, message.runId, result);
    } catch (error) {
      if (id !== undefined) {
        const code = error instanceof PluginApiError ? error.code : 'E_INTERNAL';
        const errMessage = error instanceof Error ? error.message : String(error);
        respond(id, message.runId, undefined, { code, message: errMessage.slice(0, 1000) });
      }
    }
  };

  const unsubscribe = transport.onMessage((msg) => { void handleMessage(msg); });
  return {
    dispose() {
      unsubscribe();
      disposeAll();
    },
  };
}
