export * from '@harnessmate/plugin-api';
export { z as Schema } from 'zod';
export * from './scaffold.js';

import {
  PLUGIN_API_VERSION,
  PluginApiError,
  isSafePluginUiPath,
  isValidPluginSlotKey,
  normalizePluginSlotKey,
  type Disposer,
  type IsolatedPluginContext,
  type PluginErrorCode,
  type PluginEventName,
  type PluginEventV4,
  type PluginHandshakeRequest,
  type PluginHandshakeResponse,
  type PluginModule,
  type PluginRpcMessage,
  type PluginRpcResponse,
  type PluginRuntimeSlotDescriptor,
  type PublicSlotRegistration,
  type ServiceImplementation,
} from '@harnessmate/plugin-api';

export const PLUGIN_SDK_VERSION = '4.0.0';

export function definePlugin(module: PluginModule): PluginModule {
  return module;
}

export interface RpcTransport {
  send(message: PluginRpcMessage): void;
  onMessage(listener: (message: PluginRpcMessage) => void): Disposer;
}

/**
 * Transport-agnostic isolated plugin RPC session (usable in Node child processes and future WASM hosts).
 */
export function createIsolatedPluginSession(transport: RpcTransport, loadModule: () => Promise<PluginModule>) {
  let activeRunId = '';
  let disposed = false;
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
  const configListeners = new Set<(config: Readonly<Record<string, unknown>>) => void | Promise<void>>();
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

  const buildContext = (handshake: PluginHandshakeRequest): IsolatedPluginContext => {
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
          const normalizedSlot = normalizePluginSlotKey(def.slot);
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
        await mod.apply(ctx, handshake.config);
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
      } else if (method === 'host.approval.annotate') {
        const annotations: unknown[] = [];
        for (const listener of [...annotateListeners]) {
          const out = await listener(params.event as never);
          if (out) annotations.push(out);
        }
        result = { annotations };
      } else if (method === 'host.slot.message') {
        const slotId = String(params.slotId ?? '');
        const slotName = params.slot ? normalizePluginSlotKey(String(params.slot)) : '';
        const entry = (slotName ? slotHandlers.get(`${slotName}:${slotId}`) : undefined)
          ?? [...slotHandlers.values()].find(({ meta }) => meta.id === slotId);
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
