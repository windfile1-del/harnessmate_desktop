import { ALL_PLUGIN_SLOT_KEYS } from '@harnessmate/plugin-api';

/**
 * Self-contained Node child-process runner for SDK plugins.
 * Stdout is strictly reserved for newline-delimited JSON-RPC 2.0 frames; console methods redirect to RPC log / stderr.
 */
export const ISOLATED_RUNNER_SOURCE = `'use strict';
const readline = require('node:readline');
const entryUrl = process.argv[1];
const VALID_CODES = new Set([
  'E_PERMISSION_DENIED', 'E_SERVICE_UNAVAILABLE', 'E_NOT_SUPPORTED', 'E_TIMEOUT',
  'E_INVALID_INPUT', 'E_LIMIT_EXCEEDED', 'E_CONFLICT', 'E_STALE_RUN',
  'E_CIRCULAR_DEPENDENCY', 'E_PLUGIN_DISABLED',
]);

const VALID_SLOT_KEYS = new Set(${JSON.stringify(ALL_PLUGIN_SLOT_KEYS)});

function normalizeSlotKey(rawSlot) {
  const value = String(rawSlot || '');
  return value === 'inspector.tab' ? 'inspector.tabs' : value;
}

function isSafeUiPath(value) {
  if (!value || value.includes('\\0') || value.includes('\\\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return false;
  const normalized = value.replace(/^\\.\\//, '');
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return false;
  return /\\.(?:html|htm)$/i.test(normalized);
}

class PluginApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginApiError';
    this.code = code;
  }
}
globalThis.PluginApiError = PluginApiError;

const rawWrite = process.stdout.write.bind(process.stdout);
function sendFrame(frame) {
  try {
    rawWrite(JSON.stringify(frame) + '\\n');
  } catch {
    // Broken pipe during teardown
  }
}

let activeRunId = '';
let disposed = false;
let handshakeCompleted = false;
let seq = 0;
const pending = new Map();
const effects = new Set();
const eventListeners = new Map();
const commandHandlers = new Map();
const toolHandlers = new Map();
const slotHandlers = new Map();
const providedServices = new Map();
const providedServiceMeta = new Map();
const routeHandlers = new Map();
const sections = new Map();
const composeListeners = new Set();
const offerListeners = new Set();
const annotateListeners = new Set();
let filePreviewRenderer;
const redactListeners = new Set();
const configListeners = new Set();
const driverHandlers = new Map();
const driverSessions = new Map();
const serviceChannelListeners = new Map();
const leasedHarnessSessions = new Map();
const cliProcesses = new Map();
const earlyCliEvents = new Map();
const netStreams = new Map();
const earlyNetStreamEvents = new Map();
let availableServices = new Set();
let hostFeatures = new Set();

function rpcNotify(method, params) {
  if (disposed || !activeRunId) return;
  sendFrame({ jsonrpc: '2.0', runId: activeRunId, method, params });
}

for (const level of ['debug', 'info', 'warn', 'error']) {
  const fn = (...args) => {
    const message = args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
    if (activeRunId && !disposed) rpcNotify('log', { level, message });
    else process.stderr.write('[' + level + '] ' + message + '\\n');
  };
  console[level] = fn;
}
console.log = console.info;

function assertActive() {
  if (disposed || !activeRunId) throw new PluginApiError('E_STALE_RUN', '插件实例已停止');
}

function rpcCall(method, params, overrideRunId) {
  assertActive();
  const id = ++seq;
  const runId = overrideRunId ?? activeRunId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendFrame({ jsonrpc: '2.0', id, runId, method, params });
  });
}

function registerEffect(activate) {
  assertActive();
  const dispose = activate();
  const undo = () => {
    if (effects.delete(undo) && typeof dispose === 'function') dispose();
  };
  effects.add(undo);
  return undo;
}

function createServiceProxy(serviceName) {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args) => rpcCall('service.call', { service: serviceName, method: prop, args });
    },
  });
}

function toDriverDescriptor(driver) {
  return {
    driverId: driver.driverId,
    ...(driver.harnessId ? { harnessId: driver.harnessId } : {}),
    ...(driver.instanceId ? { instanceId: driver.instanceId } : {}),
    ...(driver.pluginId ? { pluginId: driver.pluginId } : {}),
    displayName: driver.displayName,
    description: driver.description,
    protocolLabel: driver.protocolLabel,
    capabilities: driver.capabilities,
    ...(driver.capabilitiesV2 ? { capabilitiesV2: driver.capabilitiesV2 } : {}),
    ...(driver.presentation ? { presentation: driver.presentation } : {}),
    ...(driver.pluginMcpTransport ? { pluginMcpTransport: driver.pluginMcpTransport } : {}),
    ...(driver.supportedCommands ? { supportedCommands: driver.supportedCommands } : {}),
  };
}

function buildContext(handshake) {
  const subscribe = (name, listener) => registerEffect(() => {
    const set = eventListeners.get(name) || new Set();
    eventListeners.set(name, set);
    set.add(listener);
    rpcNotify('events.subscribe', { event: name });
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        eventListeners.delete(name);
        rpcNotify('events.unsubscribe', { event: name });
      }
    };
  });

  return {
    runId: handshake.runId,
    pluginId: handshake.pluginId,
    instanceId: handshake.instanceId || handshake.pluginId,
    api: {
      version: handshake.pluginApi,
      has(feature) {
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
    get(name) {
      assertActive();
      if (!availableServices.has(name)) return undefined;
      return createServiceProxy(name);
    },
    provide(name, service, meta) {
      return registerEffect(() => {
        if (providedServices.has(name)) throw new PluginApiError('E_CONFLICT', '服务 ' + name + ' 已注册');
        providedServices.set(name, service);
        if (meta && typeof meta === 'object') {
          providedServiceMeta.set(name, {
            ...(typeof meta.version === 'string' ? { version: meta.version } : {}),
            ...(meta.metadata && typeof meta.metadata === 'object' ? { metadata: meta.metadata } : {}),
          });
        }
        return () => {
          providedServices.delete(name);
          providedServiceMeta.delete(name);
          rpcNotify('service.unprovide', { name });
        };
      });
    },
    services: {
      list: (contract) => rpcCall('services.list', { contract }),
      resolve: (contract, opts) => rpcCall('services.resolve', {
        contract,
        ...(opts && typeof opts === 'object' ? opts : {}),
      }),
      call: (contract, method, args, opts) => rpcCall('services.call', {
        contract,
        method,
        args: Array.isArray(args) ? args : [],
        ...(opts && typeof opts === 'object' ? opts : {}),
      }),
      publish: (contract, payload) => rpcNotify('services.publish', { contract, payload }),
      subscribe: (contract, listener) => registerEffect(() => {
        const key = String(contract || '').trim();
        if (!key) throw new PluginApiError('E_INVALID_INPUT', '缺少服务契约名');
        const set = serviceChannelListeners.get(key) || new Set();
        serviceChannelListeners.set(key, set);
        set.add(listener);
        rpcNotify('services.subscribe', { contract: key });
        return () => {
          set.delete(listener);
          if (set.size === 0) {
            serviceChannelListeners.delete(key);
            rpcNotify('services.unsubscribe', { contract: key });
          }
        };
      }),
    },
    routes: {
      register(pathPrefix, handler) {
        return registerEffect(() => {
          const raw = String(pathPrefix || '').trim();
          const normalized = raw.startsWith('/') ? raw : '/' + raw;
          if (!normalized || normalized.includes('..') || normalized.includes('\\\\')) {
            throw new PluginApiError('E_INVALID_INPUT', '无效的插件路由前缀: ' + raw);
          }
          if (typeof handler !== 'function') {
            throw new PluginApiError('E_INVALID_INPUT', '路由处理函数无效');
          }
          if (routeHandlers.has(normalized)) {
            throw new PluginApiError('E_CONFLICT', '路由 ' + normalized + ' 已注册');
          }
          routeHandlers.set(normalized, handler);
          return () => {
            routeHandlers.delete(normalized);
            rpcNotify('routes.unregister', { path: normalized });
          };
        });
      },
    },
    on: subscribe,
    commands: {
      register(command, handler) {
        return registerEffect(() => {
          if (commandHandlers.has(command)) throw new PluginApiError('E_CONFLICT', '命令 /' + command + ' 已注册');
          commandHandlers.set(command, handler);
          return () => {
            commandHandlers.delete(command);
            rpcNotify('commands.unregister', { command });
          };
        });
      },
    },
    events: {
      on: subscribe,
      query: (filter) => rpcCall('events.query', filter || {}),
    },
    sessions: {
      list: (filter) => rpcCall('sessions.list', filter || {}),
      get: (sessionId) => rpcCall('sessions.get', { sessionId }),
      capabilities: (sessionId) => rpcCall('sessions.capabilities', { sessionId }),
      prepareTurn: (sessionId, input) => rpcCall('sessions.prepareTurn', { sessionId, ...(input || {}) }),
      runNative: (sessionId, command, args) => rpcCall('sessions.runNative', { sessionId, command, args }),
      listItems: (sessionId, opts) => rpcCall('sessions.listItems', { sessionId, ...(opts || {}) }),
      getItem: (sessionId, itemId, opts) => rpcCall('sessions.getItem', { sessionId, itemId, ...(opts || {}) }),
      getBindings: (sessionId) => rpcCall('sessions.getBindings', { sessionId }),
      fork: (sessionId, opts) => rpcCall('sessions.fork', { sessionId, ...(opts || {}) }),
      switchInstance: (sessionId, opts) => rpcCall('sessions.switchInstance', { sessionId, ...(opts || {}) }).then(() => undefined),
      postNotice: (sessionId, notice) => rpcCall('sessions.postNotice', { sessionId, notice }).then(() => undefined),
    },
    harnesses: {
      registerDriver(driver) {
        return registerEffect(() => {
          const driverId = typeof (driver && driver.driverId) === 'string' ? driver.driverId.trim() : '';
          if (!driverId) {
            throw new PluginApiError('E_INVALID_INPUT', '驱动注册缺少 driverId');
          }
          if (driverId === 'agy') {
            throw new PluginApiError('E_PERMISSION_DENIED', '禁止覆盖内置 AGY 原生驱动: ' + driverId);
          }
          if (driverHandlers.has(driverId)) {
            throw new PluginApiError('E_CONFLICT', '驱动 ' + driverId + ' 已注册');
          }
          if (typeof driver.probe !== 'function' || typeof driver.createSession !== 'function') {
            throw new PluginApiError('E_INVALID_INPUT', '驱动 ' + driverId + ' 缺少 probe 或 createSession 方法');
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
              try { if (typeof sess.unsubscribeEvent === 'function') sess.unsubscribeEvent(); } catch {}
              Promise.resolve(sess.handle.dispose()).catch(() => {});
            }
            rpcNotify('harnesses.unregisterDriver', { driverId });
          };
        });
      },
      listInstances: () => rpcCall('harnesses.listInstances', {}),
      openSession: async (harnessId, config) => {
        const opened = await rpcCall('harnesses.openSession', {
          harnessId,
          config: config && typeof config === 'object' ? config : {},
        });
        const leaseId = String(opened && opened.leaseId ? opened.leaseId : '');
        const listeners = new Set();
        const entry = {
          leaseId,
          nativeSessionId: opened && opened.nativeSessionId ? opened.nativeSessionId : null,
          listeners,
          disposed: false,
        };
        leasedHarnessSessions.set(leaseId, entry);
        let disposeEffect = null;
        const handle = {
          get nativeSessionId() { return entry.nativeSessionId; },
          pluginMcpAvailable: Boolean(opened && opened.pluginMcpAvailable),
          sendTurn: async (input) => {
            const res = await rpcCall('harnesses.session.sendTurn', { leaseId, input: input || {} });
            if (res && 'nativeSessionId' in res) entry.nativeSessionId = res.nativeSessionId || null;
            return res;
          },
          ...(opened && opened.supportsSteer ? {
            steerTurn: (input) => rpcCall('harnesses.session.steerTurn', { leaseId, input: input || {} }).then(() => undefined),
          } : {}),
          interrupt: () => rpcCall('harnesses.session.interrupt', { leaseId }).then(() => undefined),
          resolveApproval: (nativeRequestId, decision, comment) => rpcCall('harnesses.session.resolveApproval', {
            leaseId,
            nativeRequestId,
            decision,
            ...(comment !== undefined ? { comment } : {}),
          }).then(() => undefined),
          updateConfig: (patch) => rpcCall('harnesses.session.updateConfig', { leaseId, patch: patch || {} }).then(() => undefined),
          dispose: async () => {
            if (entry.disposed) return;
            entry.disposed = true;
            leasedHarnessSessions.delete(leaseId);
            listeners.clear();
            if (disposeEffect) {
              const fn = disposeEffect;
              disposeEffect = null;
              fn();
            }
            await rpcCall('harnesses.session.dispose', { leaseId }).catch(() => {});
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          },
        };
        disposeEffect = registerEffect(() => () => {
          if (entry.disposed) return;
          entry.disposed = true;
          leasedHarnessSessions.delete(leaseId);
          listeners.clear();
          rpcNotify('harnesses.session.dispose', { leaseId });
        });
        return handle;
      },
    },
    runtime: {
      trustedLocal: handshake.trustedLocal === true,
      async spawnCli(spec) {
        const spawned = await rpcCall('runtime.spawnCli', spec || {});
        const processId = spawned.processId;
        const entry = {
          stdoutListeners: new Set(),
          stderrListeners: new Set(),
          exitListeners: new Set(),
          waiters: [],
          stdoutBuffer: [],
          stderrBuffer: [],
          exitInfo: undefined,
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
          writeStdin: (data) => rpcCall('runtime.cli.writeStdin', { processId, data }).then(() => undefined),
          closeStdin: () => rpcCall('runtime.cli.closeStdin', { processId }).then(() => undefined),
          kill: (signal) => rpcCall('runtime.cli.kill', { processId, signal }).then(() => undefined),
          onStdout(listener) {
            entry.stdoutListeners.add(listener);
            if (entry.stdoutBuffer.length > 0) {
              const buffered = entry.stdoutBuffer.splice(0, entry.stdoutBuffer.length);
              for (const chunk of buffered) listener(chunk);
            }
            return () => { entry.stdoutListeners.delete(listener); };
          },
          onStderr(listener) {
            entry.stderrListeners.add(listener);
            if (entry.stderrBuffer.length > 0) {
              const buffered = entry.stderrBuffer.splice(0, entry.stderrBuffer.length);
              for (const chunk of buffered) listener(chunk);
            }
            return () => { entry.stderrListeners.delete(listener); };
          },
          onExit(listener) {
            entry.exitListeners.add(listener);
            if (entry.exitInfo) {
              const info = entry.exitInfo;
              queueMicrotask(() => listener(info));
            }
            return () => { entry.exitListeners.delete(listener); };
          },
          wait() {
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
      section(def) {
        return registerEffect(() => {
          sections.set(def.id, def);
          return () => {
            sections.delete(def.id);
            rpcNotify('handoff.section.unregister', { id: def.id });
          };
        });
      },
      onCompose(listener) {
        return registerEffect(() => {
          composeListeners.add(listener);
          return () => { composeListeners.delete(listener); };
        });
      },
      onShouldOffer(listener) {
        return registerEffect(() => {
          offerListeners.add(listener);
          return () => { offerListeners.delete(listener); };
        });
      },
      onRedact(listener) {
        return registerEffect(() => {
          redactListeners.add(listener);
          return () => { redactListeners.delete(listener); };
        });
      },
      preview: (sessionId, targetInstanceId) => rpcCall('handoff.preview', { sessionId, targetInstanceId }),
    },
    composer: {
      suggest: (sessionId, suggestion) => rpcCall('composer.suggest', { sessionId, suggestion }),
    },
    approvals: {
      annotate: (approvalId, note) => rpcCall('approvals.annotate', { approvalId, note }),
      onAnnotate(listener) {
        return registerEffect(() => {
          annotateListeners.add(listener);
          return () => { annotateListeners.delete(listener); };
        });
      },
    },
    tools: {
      register(tool) {
        return registerEffect(() => {
          if (toolHandlers.has(tool.name)) throw new PluginApiError('E_CONFLICT', '工具 ' + tool.name + ' 已注册');
          toolHandlers.set(tool.name, {
            meta: {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              readOnly: tool.readOnly,
            },
            handler: tool.handler,
          });
          return () => {
            toolHandlers.delete(tool.name);
            rpcNotify('tools.unregister', { name: tool.name });
          };
        });
      },
    },
    slots: {
      register(def) {
        return registerEffect(() => {
          const slot = normalizeSlotKey(def && def.slot);
          const id = String(def && def.id ? def.id : '');
          const title = String(def && def.title ? def.title : '');
          const ui = String(def && def.ui ? def.ui : '');
          if (!VALID_SLOT_KEYS.has(slot)) {
            throw new PluginApiError('E_INVALID_INPUT', '无效的 UI 插槽 ' + String(def && def.slot));
          }
          if (!id || !title || !isSafeUiPath(ui)) {
            throw new PluginApiError('E_INVALID_INPUT', '插槽注册缺少有效 id、title 或 ui');
          }
          const key = slot + ':' + id;
          if (slotHandlers.has(key)) throw new PluginApiError('E_CONFLICT', '插槽项 ' + key + ' 已注册');
          slotHandlers.set(key, {
            meta: {
              slot,
              id,
              title,
              ui,
              ...(typeof def.order === 'number' ? { order: def.order } : {}),
              ...(typeof def.key === 'string' ? { key: def.key } : {}),
              ...(typeof def.height === 'number' ? { height: def.height } : {}),
            },
            onMessage: typeof def.onMessage === 'function' ? def.onMessage : undefined,
          });
          return () => {
            slotHandlers.delete(key);
            rpcNotify('slots.unregister', { slot, id });
          };
        });
      },
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
      async openStream(url, init) {
        const opened = await rpcCall('net.stream.open', { url, init });
        const streamId = opened.streamId;
        const entry = {
          chunkListeners: new Set(),
          endListeners: new Set(),
          errorListeners: new Set(),
          chunkBuffer: [],
          ended: false,
          errorMessage: undefined,
        };
        netStreams.set(streamId, entry);

        const early = earlyNetStreamEvents.get(streamId);
        if (early) {
          earlyNetStreamEvents.delete(streamId);
          for (const ev of early) {
            if (ev.type === 'chunk' && ev.chunk !== undefined) {
              entry.chunkBuffer.push(ev.chunk);
            } else if (ev.type === 'end') {
              entry.ended = true;
            } else if (ev.type === 'error') {
              entry.errorMessage = ev.message;
            }
          }
        }

        registerEffect(() => () => {
          netStreams.delete(streamId);
          if (!disposed && activeRunId) {
            rpcNotify('net.stream.close', { streamId });
          }
        });

        return {
          streamId,
          status: opened.status,
          ok: opened.ok,
          headers: opened.headers || {},
          onChunk(listener) {
            entry.chunkListeners.add(listener);
            if (entry.chunkBuffer.length > 0) {
              const buffered = entry.chunkBuffer.splice(0, entry.chunkBuffer.length);
              for (const chunk of buffered) listener(chunk);
            }
            return () => { entry.chunkListeners.delete(listener); };
          },
          onEnd(listener) {
            entry.endListeners.add(listener);
            if (entry.ended) {
              queueMicrotask(() => listener());
            }
            return () => { entry.endListeners.delete(listener); };
          },
          onError(listener) {
            entry.errorListeners.add(listener);
            if (entry.errorMessage !== undefined) {
              const msg = entry.errorMessage;
              queueMicrotask(() => listener(msg));
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
      resolve: (secretRef) => rpcCall('secrets.resolve', { secretRef }).then((res) => (res && res.value !== undefined ? res.value : null)),
    },
    notify: {
      send: (input) => rpcCall('notify.send', input || {}),
    },
    clipboard: {
      writeText: (text, workspaceId) => rpcCall('clipboard.writeText', { text, workspaceId }),
    },
    onConfigUpdated(listener) {
      return registerEffect(() => {
        configListeners.add(listener);
        return () => { configListeners.delete(listener); };
      });
    },
    __rawRpcCall: rpcCall,
  };
}

function disposeAll() {
  disposed = true;
  serviceChannelListeners.clear();
  leasedHarnessSessions.clear();
  for (const undo of [...effects].reverse()) {
    try { undo(); } catch {}
  }
  effects.clear();
  earlyCliEvents.clear();
  earlyNetStreamEvents.clear();
  netStreams.clear();
  for (const req of pending.values()) {
    req.reject(new PluginApiError('E_STALE_RUN', '插件实例已卸载'));
  }
  pending.clear();
}

function respond(id, runId, result, error) {
  if (error) sendFrame({ jsonrpc: '2.0', id, runId, error });
  else sendFrame({ jsonrpc: '2.0', id, runId, result });
}

async function handleMessage(message) {
  if (!('method' in message)) {
    const req = pending.get(message.id);
    if (!req) return;
    pending.delete(message.id);
    if (message.error) {
      const code = VALID_CODES.has(message.error.code) ? message.error.code : null;
      req.reject(code ? new PluginApiError(code, message.error.message) : new Error(message.error.message));
    } else {
      req.resolve(message.result);
    }
    return;
  }

  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  if (method !== 'host.handshake' && message.runId !== activeRunId) {
    if (id !== undefined) respond(id, message.runId, undefined, { code: 'E_STALE_RUN', message: '实例标识不匹配' });
    return;
  }

  try {
    let result;
    if (method === 'host.handshake') {
      activeRunId = params.runId;
      hostFeatures = new Set(params.features || []);
      availableServices = new Set(params.services || []);
      const loaded = await import(entryUrl);
      const mod = loaded.default && typeof loaded.default.apply === 'function' ? loaded.default : loaded;
      if (typeof mod.apply !== 'function') {
        throw new PluginApiError('E_INVALID_INPUT', 'V4 插件入口必须导出 apply(ctx, config)');
      }
      const unsupported = (mod.requires || []).filter((feature) => !hostFeatures.has(feature));
      if (unsupported.length) {
        throw new PluginApiError('E_NOT_SUPPORTED', '宿主不支持插件要求的特性: ' + unsupported.join(', '));
      }
      const ctx = buildContext(params);
      await mod.apply(ctx, params.config || {});
      filePreviewRenderer = typeof mod.renderFilePreview === 'function' ? mod.renderFilePreview.bind(mod) : undefined;
      handshakeCompleted = true;
      const serviceMethods = {};
      const serviceMeta = {};
      for (const [serviceName, impl] of providedServices) {
        serviceMethods[serviceName] = Object.keys(impl).filter((k) => typeof impl[k] === 'function');
        const meta = providedServiceMeta.get(serviceName);
        if (meta) serviceMeta[serviceName] = meta;
      }
      result = {
        sdkVersion: typeof mod.sdkVersion === 'string' ? mod.sdkVersion : '4.0.0',
        name: mod.name,
        requires: mod.requires,
        inject: mod.inject,
        optional: mod.optional,
        provides: [...providedServices.keys()],
        serviceMethods,
        serviceMeta,
        routes: [...routeHandlers.keys()],
        commands: [...commandHandlers.keys()],
        tools: [...toolHandlers.values()].map(({ meta }) => meta),
        slots: [...slotHandlers.values()].map(({ meta }) => meta),
        sections: [...sections.values()],
        subscribedEvents: [...eventListeners.keys()],
        hasHandoffCompose: composeListeners.size > 0,
        hasHandoffShouldOffer: offerListeners.size > 0,
        hasApprovalAnnotate: annotateListeners.size > 0,
        hasFilePreview: Boolean(filePreviewRenderer),
        hasHandoffRedact: redactListeners.size > 0,
        registeredDrivers: [...driverHandlers.values()].map(({ descriptor }) => descriptor),
      };
    } else if (method === 'host.services.sync') {
      availableServices = new Set(Array.isArray(params.services) ? params.services : []);
      result = { ok: true };
    } else if (method === 'host.dispose') {
      disposeAll();
      result = { ok: true };
    } else if (method === 'host.event') {
      const listeners = [...(eventListeners.get(params.event.type) || [])];
      for (const listener of listeners) await listener(params.event);
      result = { ok: true };
    } else if (method === 'host.service.channel') {
      const ev = params.event || {};
      const listeners = [...(serviceChannelListeners.get(ev.contract) || [])];
      for (const listener of listeners) await listener(ev);
      result = { ok: true };
    } else if (method === 'host.harnessSession.event') {
      const leaseId = String(params.leaseId || '');
      const sess = leasedHarnessSessions.get(leaseId);
      const ev = params.event;
      if (sess && ev && !sess.disposed) {
        if (ev.type === 'native_session_ready' && typeof ev.nativeSessionId === 'string') {
          sess.nativeSessionId = ev.nativeSessionId;
        }
        for (const listener of [...sess.listeners]) {
          try { await listener(ev); } catch {}
        }
      }
      result = { ok: true };
    } else if (method === 'host.command') {
      const handler = commandHandlers.get(String(params.command));
      if (!handler) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册命令 /' + String(params.command));
      result = await handler(params.input);
    } else if (method === 'host.tool') {
      const tool = toolHandlers.get(String(params.name));
      if (!tool) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册工具 ' + String(params.name));
      result = await tool.handler(params.input || {}, params.meta || { sessionId: '', workspaceId: '' });
    } else if (method === 'host.service.call') {
      const impl = providedServices.get(String(params.service));
      const fn = impl && impl[String(params.method)];
      if (typeof fn !== 'function') {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '服务 ' + String(params.service) + '.' + String(params.method) + ' 不可用');
      }
      result = await fn(...(Array.isArray(params.args) ? params.args : []));
    } else if (method === 'host.route.handle') {
      const reqPath = typeof params.path === 'string' ? params.path : '/';
      let matchedPrefix = '';
      let matchedHandler = null;
      for (const [prefix, handler] of routeHandlers) {
        if ((reqPath === prefix || reqPath.startsWith(prefix === '/' ? '/' : prefix + '/') || prefix === '/') && prefix.length >= matchedPrefix.length) {
          matchedPrefix = prefix;
          matchedHandler = handler;
        }
      }
      if (!matchedHandler) {
        result = { status: 404, body: { error: '插件路由不存在', path: reqPath } };
      } else {
        result = await matchedHandler({
          method: String(params.httpMethod || 'GET'),
          path: reqPath,
          query: params.query || {},
          headers: params.headers || {},
          body: params.body,
        });
      }
    } else if (method === 'host.handoff.compose') {
      const collected = [];
      for (const listener of [...composeListeners]) {
        const out = await listener(params.event);
        if (Array.isArray(out)) collected.push(...out);
        else if (out) collected.push(out);
      }
      result = { sections: collected };
    } else if (method === 'host.handoff.shouldOffer') {
      let decision;
      for (const listener of [...offerListeners]) {
        const out = await listener(params.event);
        if (out !== undefined) {
          decision = out;
          break;
        }
      }
      result = { decision };
    } else if (method === 'host.handoff.redact') {
      let currentText = typeof params.text === 'string' ? params.text : '';
      const categories = [];
      for (const listener of [...redactListeners]) {
        const out = await listener({ ...params, text: currentText });
        if (!out || typeof out.text !== 'string' || !Array.isArray(out.categories)) {
          throw new PluginApiError('E_INVALID_INPUT', 'handoff.onRedact 必须返回 { text, categories }');
        }
        currentText = out.text;
        for (const cat of out.categories) {
          if (typeof cat === 'string' && cat) categories.push(cat);
        }
      }
      result = { text: currentText, categories };
    } else if (method === 'host.filePreview.render') {
      if (!filePreviewRenderer) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '插件未提供文件预览渲染器');
      result = await filePreviewRenderer(params.request);
    } else if (method === 'host.approval.annotate') {
      const annotations = [];
      for (const listener of [...annotateListeners]) {
        const out = await listener(params.event);
        if (out) annotations.push(out);
      }
      result = { annotations };
    } else if (method === 'host.slot.message') {
      const slotId = String(params.slotId || '');
      const slotName = params.slot ? normalizeSlotKey(params.slot) : '';
      const entry = slotName
        ? slotHandlers.get(slotName + ':' + slotId)
        : [...slotHandlers.values()].find(({ meta }) => meta.id === slotId);
      if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册插槽项 ' + slotId);
      if (!entry.onMessage) {
        result = { handled: false };
      } else {
        result = await entry.onMessage(params.payload, {
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
          slotId,
        });
      }
    } else if (method === 'host.config.updated') {
      for (const listener of [...configListeners]) await listener(params.config || {});
      result = { ok: true };
    } else if (method === 'host.cli.output') {
      const processId = String(params.processId || '');
      const stream = params.stream === 'stderr' ? 'stderr' : 'stdout';
      const chunk = typeof params.chunk === 'string' ? params.chunk : '';
      const entry = cliProcesses.get(processId);
      if (!entry) {
        const buf = earlyCliEvents.get(processId) || [];
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
      const processId = String(params.processId || '');
      const info = {
        code: typeof params.code === 'number' ? params.code : null,
        signal: typeof params.signal === 'string' ? params.signal : null,
      };
      const entry = cliProcesses.get(processId);
      if (!entry) {
        const buf = earlyCliEvents.get(processId) || [];
        buf.push({ type: 'exit', ...info });
        earlyCliEvents.set(processId, buf);
      } else if (!entry.exitInfo) {
        entry.exitInfo = info;
        for (const listener of [...entry.exitListeners]) listener(info);
        for (const waiter of entry.waiters.splice(0, entry.waiters.length)) waiter.resolve(info);
      }
      result = { ok: true };
    } else if (method === 'host.net.stream.chunk') {
      const streamId = String(params.streamId || '');
      const chunk = typeof params.chunk === 'string' ? params.chunk : '';
      const entry = netStreams.get(streamId);
      if (!entry) {
        const buf = earlyNetStreamEvents.get(streamId) || [];
        buf.push({ type: 'chunk', chunk });
        earlyNetStreamEvents.set(streamId, buf);
      } else if (entry.chunkListeners.size === 0) {
        entry.chunkBuffer.push(chunk);
      } else {
        for (const listener of [...entry.chunkListeners]) listener(chunk);
      }
      result = { ok: true };
    } else if (method === 'host.net.stream.end') {
      const streamId = String(params.streamId || '');
      const entry = netStreams.get(streamId);
      if (!entry) {
        const buf = earlyNetStreamEvents.get(streamId) || [];
        buf.push({ type: 'end' });
        earlyNetStreamEvents.set(streamId, buf);
      } else if (!entry.ended) {
        entry.ended = true;
        for (const listener of [...entry.endListeners]) listener();
      }
      result = { ok: true };
    } else if (method === 'host.net.stream.error') {
      const streamId = String(params.streamId || '');
      const msg = typeof params.message === 'string' ? params.message : 'Stream error';
      const entry = netStreams.get(streamId);
      if (!entry) {
        const buf = earlyNetStreamEvents.get(streamId) || [];
        buf.push({ type: 'error', message: msg });
        earlyNetStreamEvents.set(streamId, buf);
      } else {
        entry.errorMessage = msg;
        for (const listener of [...entry.errorListeners]) listener(msg);
      }
      result = { ok: true };
    } else if (method === 'host.driver.probe' || method === 'host.driver.probePassive') {
      const driverId = String(params.driverId || '');
      const entry = driverHandlers.get(driverId);
      if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册驱动 ' + driverId);
      if (method === 'host.driver.probePassive' && typeof entry.driver.probePassive === 'function') {
        result = await entry.driver.probePassive();
      } else {
        result = await entry.driver.probe();
      }
    } else if (method === 'host.driver.readUsageLimits') {
      const driverId = String(params.driverId || '');
      const entry = driverHandlers.get(driverId);
      if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册驱动 ' + driverId);
      if (typeof entry.driver.readUsageLimits !== 'function') {
        throw new PluginApiError('E_NOT_SUPPORTED', '驱动未实现 readUsageLimits');
      }
      result = await entry.driver.readUsageLimits();
    } else if (method === 'host.driver.createSession') {
      const driverId = String(params.driverId || '');
      const handleId = String(params.handleId || '');
      const entry = driverHandlers.get(driverId);
      if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未注册驱动 ' + driverId);
      const handle = await entry.driver.createSession(params.config || {});
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
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      result = (await sess.handle.sendTurn(params.input || {})) || {};
    } else if (method === 'host.driver.injectContext') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      if (typeof sess.handle.injectContext !== 'function') {
        throw new PluginApiError('E_NOT_SUPPORTED', '驱动不支持 injectContext');
      }
      const driverUsed = await sess.handle.injectContext(params.payload || {});
      result = { driverUsed };
    } else if (method === 'host.driver.interrupt') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      await sess.handle.interrupt();
      result = { ok: true };
    } else if (method === 'host.driver.resolveApproval') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      await sess.handle.resolveApproval(
        String(params.nativeRequestId || ''),
        params.decision,
        typeof params.comment === 'string' ? params.comment : undefined,
      );
      result = { ok: true };
    } else if (method === 'host.driver.updateConfig') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      const receipt = typeof sess.handle.updateConfig === 'function'
        ? await sess.handle.updateConfig(params.patch || {})
        : undefined;
      result = receipt && typeof receipt === 'object' ? { ok: true, receipt } : { ok: true };
    } else if (method === 'host.driver.steerTurn') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      if (typeof sess.handle.steerTurn !== 'function') {
        throw new PluginApiError('E_NOT_SUPPORTED', '驱动不支持 steerTurn');
      }
      await sess.handle.steerTurn(params.input || {});
      result = { ok: true };
    } else if (method === 'host.driver.listSkills') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      result = typeof sess.handle.listSkills === 'function' ? await sess.handle.listSkills() : [];
    } else if (method === 'host.driver.runNativeCommand') {
      const sess = driverSessions.get(String(params.handleId || ''));
      if (!sess) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '驱动会话不存在');
      if (typeof sess.handle.runNativeCommand !== 'function') {
        throw new PluginApiError('E_NOT_SUPPORTED', '驱动不支持 runNativeCommand');
      }
      result = await sess.handle.runNativeCommand(String(params.command || ''), String(params.args || ''));
    } else if (method === 'host.driver.dispose') {
      const handleId = String(params.handleId || '');
      const sess = driverSessions.get(handleId);
      if (sess) {
        driverSessions.delete(handleId);
        try { if (typeof sess.unsubscribeEvent === 'function') sess.unsubscribeEvent(); } catch {}
        await sess.handle.dispose();
      }
      result = { ok: true };
    } else {
      throw new PluginApiError('E_NOT_SUPPORTED', '未知 RPC 方法 ' + method);
    }

    if (id !== undefined) respond(id, message.runId, result);
  } catch (error) {
    if (id !== undefined) {
      const code = error && VALID_CODES.has(error.code) ? error.code : 'E_INTERNAL';
      const errMessage = String(error && error.message ? error.message : error).slice(0, 1000);
      respond(id, message.runId, undefined, { code, message: errMessage });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  void handleMessage(parsed);
});
rl.on('close', () => {
  disposeAll();
  process.exit(0);
});
`;
