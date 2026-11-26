import {
  FILE_PREVIEW_FEATURE,
  HOST_FEATURES_V5,
  PLUGIN_API_VERSION,
  PluginApiError,
  isSafePluginUiPath,
  isValidPluginSlotKey,
  normalizeAnyPluginSlotKey,
  type ContextHandoffPreviewV2,
  type Disposer,
  type HandoffRedactEvent,
  type HandoffRedactResult,
  type IsolatedPluginContextV5,
  type ManagedCliProcessHandle,
  type PluginEventName,
  type PluginEventV4,
  type PluginHarnessDriverRegistration,
  type PluginHarnessSessionHandle,
  type PluginModule,
  type PublicAdapterSessionConfig,
  type PublicCommandInvocation,
  type PublicCommandResult,
  type PublicDriverTurnInput,
  type PublicFsEntry,
  type PublicFsStat,
  type PublicHarnessBinding,
  type PublicHarnessCapabilities,
  type PublicHarnessCapabilitiesV2,
  type PublicHarnessInstanceInfo,
  type PublicHarnessProbeResult,
  type PublicModelTool,
  type PublicNetInit,
  type PublicNetResponse,
  type PublicNetStreamHandle,
  type PublicNetStreamInit,
  type PublicNormalizedAdapterEvent,
  type PublicSession,
  type PublicSessionNotice,
  type PublicSlotRegistration,
  type PublicTurnBlock,
  type ServiceImplementation,
  type SpawnCliSpec,
} from '@harnessmate/plugin-api';

// ── 1. Mock Session Helper ──────────────────────────────────────────────

export interface CreateMockSessionOptions {
  id?: string;
  workspaceId?: string;
  harnessId?: string;
  harnessKind?: string;
  title?: string;
  status?: string;
  model?: string | null;
  permissionMode?: string;
  cwd?: string;
  items?: PublicTurnBlock[];
  bindings?: PublicHarnessBinding[];
  events?: PluginEventV4[];
}

export interface MockSessionController {
  session: PublicSession;
  events: PluginEventV4[];
  items: PublicTurnBlock[];
  bindings: PublicHarnessBinding[];
  notices: PublicSessionNotice[];
  pushEvent(event: PluginEventV4): void;
  pushItem(item: Partial<PublicTurnBlock> & { itemId: string; blockType: string; textBody: string }): PublicTurnBlock;
}

let mockIdSeq = 0;

export function createMockSession(options: CreateMockSessionOptions = {}): MockSessionController {
  const now = Date.now();
  mockIdSeq += 1;
  const session: PublicSession = {
    id: options.id ?? `sess_mock_${mockIdSeq}`,
    workspaceId: options.workspaceId ?? 'ws_mock_1',
    harnessId: options.harnessId ?? 'mock-harness',
    harnessKind: options.harnessKind ?? options.harnessId ?? 'mock-harness',
    title: options.title ?? 'Mock Test Session',
    status: options.status ?? 'idle',
    model: options.model ?? 'mock-model',
    permissionMode: options.permissionMode ?? 'manual',
    cwd: options.cwd ?? '/mock/workspace',
    createdAt: now,
    updatedAt: now,
  };

  const events: PluginEventV4[] = [...(options.events ?? [])];
  const items: PublicTurnBlock[] = [...(options.items ?? [])];
  const bindings: PublicHarnessBinding[] = [...(options.bindings ?? [])];
  const notices: PublicSessionNotice[] = [];

  return {
    session,
    events,
    items,
    bindings,
    notices,
    pushEvent(event: PluginEventV4) {
      events.push(event);
    },
    pushItem(input) {
      const ts = Date.now();
      const record: PublicTurnBlock = {
        itemId: input.itemId,
        schemaVersion: input.schemaVersion ?? 2,
        sessionId: session.id,
        turnId: input.turnId ?? null,
        seq: input.seq ?? items.length + 1,
        instanceId: input.instanceId ?? session.harnessId,
        driverId: input.driverId ?? session.harnessKind,
        blockType: input.blockType,
        status: input.status ?? 'completed',
        title: input.title ?? input.blockType,
        textBody: input.textBody,
        payload: input.payload ?? {},
        outputOmitted: input.outputOmitted ?? false,
        omittedBytes: input.omittedBytes ?? 0,
        rawRef: input.rawRef ?? null,
        createdAt: input.createdAt ?? ts,
        updatedAt: input.updatedAt ?? ts,
      };
      items.push(record);
      return record;
    },
  };
}

// ── 2. Mock CLI Process & Mock Net Stream Helpers ───────────────────────

export interface CreateMockCliProcessOptions {
  stdoutLines?: string[];
  stderrLines?: string[];
  exitCode?: number | null;
  exitSignal?: string | null;
  autoEmitOnStdin?: boolean;
  onStdin?: (
    data: string,
    controls: {
      emitStdout: (chunk: string) => void;
      emitStderr: (chunk: string) => void;
      finish: (code?: number | null, signal?: string | null) => void;
    },
  ) => void;
}

export function createMockCliProcess(options: CreateMockCliProcessOptions = {}): ManagedCliProcessHandle {
  mockIdSeq += 1;
  const processId = `proc_mock_${mockIdSeq}`;
  const pid = 40_000 + mockIdSeq;
  const stdoutListeners = new Set<(chunk: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const waiters: Array<(info: { code: number | null; signal: string | null }) => void> = [];
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  let emittedPreloaded = false;

  const emitStdout = (chunk: string) => {
    if (stdoutListeners.size === 0) {
      stdoutBuffer.push(chunk);
      return;
    }
    for (const listener of [...stdoutListeners]) listener(chunk);
  };

  const emitStderr = (chunk: string) => {
    if (stderrListeners.size === 0) {
      stderrBuffer.push(chunk);
      return;
    }
    for (const listener of [...stderrListeners]) listener(chunk);
  };

  const finish = (code: number | null = options.exitCode ?? 0, signal: string | null = options.exitSignal ?? null) => {
    if (exitInfo) return;
    exitInfo = { code, signal };
    for (const listener of [...exitListeners]) listener(exitInfo);
    while (waiters.length > 0) {
      waiters.shift()!(exitInfo);
    }
  };

  const flushPreloaded = () => {
    if (emittedPreloaded) return;
    emittedPreloaded = true;
    for (const line of options.stdoutLines ?? []) {
      emitStdout(line.endsWith('\n') ? line : `${line}\n`);
    }
    for (const line of options.stderrLines ?? []) {
      emitStderr(line.endsWith('\n') ? line : `${line}\n`);
    }
    finish(options.exitCode ?? 0, options.exitSignal ?? null);
  };

  const shouldDeferToStdin = Boolean(options.onStdin || options.autoEmitOnStdin);
  if (!shouldDeferToStdin && (options.stdoutLines?.length || options.stderrLines?.length || options.exitCode !== undefined)) {
    void Promise.resolve().then(flushPreloaded);
  }

  return {
    processId,
    pid,
    async writeStdin(data: string) {
      if (options.onStdin) {
        options.onStdin(data, { emitStdout, emitStderr, finish });
      } else if (options.autoEmitOnStdin) {
        flushPreloaded();
      }
    },
    async closeStdin() {
      if (!exitInfo && options.autoEmitOnStdin) {
        flushPreloaded();
      }
    },
    async kill(signal?: 'SIGTERM' | 'SIGKILL') {
      finish(null, signal ?? 'SIGTERM');
    },
    onStdout(listener) {
      stdoutListeners.add(listener);
      if (stdoutBuffer.length > 0) {
        const queued = stdoutBuffer.splice(0);
        for (const chunk of queued) listener(chunk);
      }
      return () => {
        stdoutListeners.delete(listener);
      };
    },
    onStderr(listener) {
      stderrListeners.add(listener);
      if (stderrBuffer.length > 0) {
        const queued = stderrBuffer.splice(0);
        for (const chunk of queued) listener(chunk);
      }
      return () => {
        stderrListeners.delete(listener);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (exitInfo) {
        const captured = exitInfo;
        void Promise.resolve().then(() => listener(captured));
      }
      return () => {
        exitListeners.delete(listener);
      };
    },
    wait() {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

export interface CreateMockNetStreamOptions {
  status?: number;
  headers?: Record<string, string>;
  chunks?: string[];
  errorMessage?: string;
}

export function createMockNetStream(options: CreateMockNetStreamOptions = {}): PublicNetStreamHandle {
  mockIdSeq += 1;
  const streamId = `stream_mock_${mockIdSeq}`;
  const status = options.status ?? 200;
  const ok = status >= 200 && status < 300;
  const headers = { ...(options.headers ?? {}) };
  const chunkListeners = new Set<(chunk: string) => void>();
  const endListeners = new Set<() => void>();
  const errorListeners = new Set<(message: string) => void>();
  let closed = false;
  let flushed = false;

  const scheduleFlush = () => {
    if (flushed) return;
    flushed = true;
    void Promise.resolve().then(() => {
      if (closed) return;
      for (const chunk of options.chunks ?? []) {
        if (closed) return;
        for (const listener of [...chunkListeners]) listener(chunk);
      }
      if (options.errorMessage) {
        for (const listener of [...errorListeners]) listener(options.errorMessage);
      } else {
        for (const listener of [...endListeners]) listener();
      }
    });
  };

  return {
    streamId,
    status,
    ok,
    headers,
    onChunk(listener) {
      chunkListeners.add(listener);
      scheduleFlush();
      return () => {
        chunkListeners.delete(listener);
      };
    },
    onEnd(listener) {
      endListeners.add(listener);
      scheduleFlush();
      return () => {
        endListeners.delete(listener);
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      scheduleFlush();
      return () => {
        errorListeners.delete(listener);
      };
    },
    async close() {
      closed = true;
    },
  };
}

// ── 3. Offline Mock Plugin Host ─────────────────────────────────────────

export interface CreateMockPluginHostOptions {
  pluginId?: string;
  runId?: string;
  trustedLocal?: boolean;
  /** If provided, permissions are strictly enforced against this set. */
  permissions?: readonly string[];
  features?: readonly string[];
  services?: Record<string, ServiceImplementation>;
  sessions?: Array<PublicSession | MockSessionController>;
  secrets?: Record<string, string>;
  workspaceFiles?: Record<string, Record<string, string>>;
  harnessInstances?: PublicHarnessInstanceInfo[];
  spawnCliHandler?: (spec: SpawnCliSpec) => Promise<ManagedCliProcessHandle> | ManagedCliProcessHandle;
  netFetchHandler?: (url: string, init?: PublicNetInit) => Promise<PublicNetResponse> | PublicNetResponse;
  netStreamHandler?: (url: string, init?: PublicNetStreamInit) => Promise<PublicNetStreamHandle> | PublicNetStreamHandle;
}

export interface MockPluginLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

export interface MockPluginHost {
  readonly pluginId: string;
  readonly runId: string;
  readonly ctx: IsolatedPluginContextV5;
  readonly logs: MockPluginLogEntry[];
  readonly drivers: Map<string, PluginHarnessDriverRegistration>;
  readonly slots: Map<string, PublicSlotRegistration>;
  readonly commands: Map<string, (input: PublicCommandInvocation) => Promise<PublicCommandResult> | PublicCommandResult>;
  readonly tools: Map<string, PublicModelTool>;
  readonly services: Map<string, ServiceImplementation>;
  readonly spawnedClis: SpawnCliSpec[];
  readonly netRequests: Array<{ url: string; kind: 'fetch' | 'stream'; init?: unknown }>;
  readonly notices: Array<{ sessionId: string; notice: PublicSessionNotice }>;
  readonly notifications: Array<{ title: string; body?: string; level?: string }>;
  readonly clipboardHistory: string[];
  activate(module: PluginModule<IsolatedPluginContextV5>, config?: Readonly<Record<string, unknown>>): Promise<void>;
  emitEvent(event: PluginEventV4): Promise<void>;
  invokeCommand(command: string, input?: Partial<PublicCommandInvocation>): Promise<PublicCommandResult>;
  invokeSlotMessage(slotId: string, payload: unknown, sessionId?: string | null): Promise<unknown>;
  invokeRedact(event: HandoffRedactEvent): Promise<HandoffRedactResult>;
  dispose(): void;
}

function extractUrlHost(url: string): string {
  const match = /^https?:\/\/([^/:?#]+)/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

export function createMockPluginHost(options: CreateMockPluginHostOptions = {}): MockPluginHost {
  mockIdSeq += 1;
  const pluginId = options.pluginId ?? `test.plugin-${mockIdSeq}`;
  const runId = options.runId ?? `run_mock_${mockIdSeq}`;
  const strictPermissions = options.permissions !== undefined;
  const permissionSet = new Set<string>(options.permissions ?? []);
  const featureSet = new Set<string>(options.features ?? [...HOST_FEATURES_V5, 'ui.workspace.pages', 'runtime.trustedLocal', FILE_PREVIEW_FEATURE]);

  const logs: MockPluginLogEntry[] = [];
  const drivers = new Map<string, PluginHarnessDriverRegistration>();
  const slots = new Map<string, PublicSlotRegistration>();
  const commands = new Map<string, (input: PublicCommandInvocation) => Promise<PublicCommandResult> | PublicCommandResult>();
  const tools = new Map<string, PublicModelTool>();
  const services = new Map<string, ServiceImplementation>(Object.entries(options.services ?? {}));
  const eventListeners = new Map<PluginEventName, Set<(event: PluginEventV4) => void | Promise<void>>>();
  const redactListeners = new Set<(input: HandoffRedactEvent) => Promise<HandoffRedactResult> | HandoffRedactResult>();
  const effects = new Set<Disposer>();
  const pluginKv = new Map<string, unknown>();
  const workspaceKv = new Map<string, Map<string, unknown>>();
  const workspaceFiles = new Map<string, Map<string, string>>();
  for (const [wsId, entries] of Object.entries(options.workspaceFiles ?? {})) {
    workspaceFiles.set(wsId, new Map(Object.entries(entries)));
  }

  const sessionMap = new Map<string, MockSessionController>();
  for (const entry of options.sessions ?? []) {
    const controller = 'session' in entry ? entry : createMockSession(entry);
    sessionMap.set(controller.session.id, controller);
  }

  const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}));
  const spawnedClis: SpawnCliSpec[] = [];
  const netRequests: Array<{ url: string; kind: 'fetch' | 'stream'; init?: unknown }> = [];
  const notices: Array<{ sessionId: string; notice: PublicSessionNotice }> = [];
  const notifications: Array<{ title: string; body?: string; level?: string }> = [];
  const clipboardHistory: string[] = [];
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw new PluginApiError('E_STALE_RUN', 'Mock plugin host has been disposed');
  };

  const requirePermission = (capability: string) => {
    assertActive();
    if (!strictPermissions) return;
    if (!permissionSet.has(capability)) {
      throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${pluginId} 未获得权限 ${capability}`);
    }
  };

  const registerEffect = (activate: () => Disposer): Disposer => {
    assertActive();
    const disposer = activate();
    const wrapped: Disposer = () => {
      if (effects.delete(wrapped)) disposer();
    };
    effects.add(wrapped);
    return wrapped;
  };

  const subscribe = <Name extends PluginEventName>(
    name: Name,
    listener: (event: PluginEventV4<Name>) => void | Promise<void>,
  ): Disposer =>
    registerEffect(() => {
      const bucket = eventListeners.get(name) ?? new Set();
      eventListeners.set(name, bucket);
      const wrapped = (ev: PluginEventV4) => listener(ev as PluginEventV4<Name>);
      bucket.add(wrapped);
      return () => {
        bucket.delete(wrapped);
      };
    });

  const ctx: IsolatedPluginContextV5 = {
    runId,
    pluginId,
    api: {
      version: PLUGIN_API_VERSION,
      has: (feature: string) => featureSet.has(feature) || services.has(feature),
    },
    logger: {
      debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
    },
    effect: registerEffect,
    get: <Service = unknown>(name: string) => services.get(name) as Service | undefined,
    provide: (name: string, impl: ServiceImplementation) =>
      registerEffect(() => {
        if (services.has(name)) throw new PluginApiError('E_CONFLICT', `服务 ${name} 已注册`);
        services.set(name, impl);
        return () => {
          services.delete(name);
        };
      }),
    on: subscribe,
    commands: {
      register: (command, handler) =>
        registerEffect(() => {
          if (commands.has(command)) throw new PluginApiError('E_CONFLICT', `命令 /${command} 已注册`);
          commands.set(command, handler);
          return () => {
            commands.delete(command);
          };
        }),
    },
    events: {
      on: subscribe,
      query: async (filter) => {
        requirePermission('session:read');
        const ctrl = sessionMap.get(filter.sessionId);
        if (!ctrl) return [];
        return ctrl.events.filter((ev) => {
          if (filter.types && !filter.types.includes(ev.type)) return false;
          if (filter.afterSeq !== undefined && (ev.seq ?? 0) <= filter.afterSeq) return false;
          return true;
        }).slice(0, filter.limit ?? 100);
      },
    },
    sessions: {
      list: async (filter) => {
        requirePermission('session:read');
        return [...sessionMap.values()]
          .map((c) => c.session)
          .filter((s) => (!filter?.workspaceId || s.workspaceId === filter.workspaceId) && (!filter?.harnessId || s.harnessId === filter.harnessId));
      },
      get: async (sessionId) => {
        requirePermission('session:read');
        return sessionMap.get(sessionId)?.session ?? null;
      },
      capabilities: async (sessionId) => {
        requirePermission('session:read');
        const s = sessionMap.get(sessionId)?.session;
        if (!s) return null;
        return {
          harnessId: s.harnessId,
          harnessKind: s.harnessKind,
          supportsAttachments: true,
          supportsNativeCommands: true,
          supportsModelTools: true,
        };
      },
      prepareTurn: async () => {
        requirePermission('session:send');
        return { accepted: true };
      },
      runNative: async (_sessionId, command) => {
        requirePermission('session:command');
        return { output: `mock native: ${command}` };
      },
      listItems: async (sessionId, opts) => {
        requirePermission('session:read');
        const ctrl = sessionMap.get(sessionId);
        if (!ctrl) return { items: [], nextSeq: null };
        const filtered = ctrl.items.filter((it) => {
          if (opts?.afterSeq !== undefined && it.seq <= opts.afterSeq) return false;
          if (opts?.beforeSeq !== undefined && it.seq >= opts.beforeSeq) return false;
          if (opts?.types && !opts.types.includes(it.blockType)) return false;
          return true;
        });
        const limit = opts?.limit ?? 50;
        const page = filtered.slice(0, limit);
        return { items: page, nextSeq: filtered.length > page.length ? page[page.length - 1]!.seq : null };
      },
      getItem: async (sessionId, itemId, opts) => {
        requirePermission('session:read');
        const ctrl = sessionMap.get(sessionId);
        const item = ctrl?.items.find((it) => it.itemId === itemId);
        if (!item) return null;
        const offset = opts?.textOffset ?? 0;
        const maxChars = opts?.maxChars ?? 8000;
        const chunk = item.textBody.slice(offset, offset + maxChars);
        const nextTextOffset = offset + chunk.length < item.textBody.length ? offset + chunk.length : null;
        return { item, bodyChunk: chunk, nextTextOffset };
      },
      getBindings: async (sessionId) => {
        requirePermission('session:read');
        return sessionMap.get(sessionId)?.bindings ?? [];
      },
      fork: async (sessionId, opts) => {
        requirePermission('session:fork');
        const base = sessionMap.get(sessionId)?.session;
        const forked = createMockSession({
          workspaceId: base?.workspaceId,
          harnessId: opts?.targetInstanceId ?? base?.harnessId,
          title: opts?.title ?? `Fork of ${base?.title ?? sessionId}`,
          cwd: base?.cwd,
        });
        sessionMap.set(forked.session.id, forked);
        return forked.session;
      },
      switchInstance: async (sessionId, opts) => {
        requirePermission('session:switch');
        const ctrl = sessionMap.get(sessionId);
        if (ctrl) ctrl.session.harnessId = opts.targetInstanceId;
      },
      postNotice: async (sessionId, notice) => {
        requirePermission('session:orchestrate');
        notices.push({ sessionId, notice });
        sessionMap.get(sessionId)?.notices.push(notice);
      },
    },
    ledger: {
      get: async (sessionId) => {
        requirePermission('session:read');
        return {
          sessionId,
          objective: '',
          steps: [],
          decisions: [],
          touchedFiles: [],
          blockers: [],
          pinnedFacts: [],
          version: 1,
          updatedAt: Date.now(),
        };
      },
      append: async (sessionId) => {
        requirePermission('session:read');
        return {
          sessionId,
          objective: '',
          steps: [],
          decisions: [],
          touchedFiles: [],
          blockers: [],
          pinnedFacts: [],
          version: 2,
          updatedAt: Date.now(),
        };
      },
    },
    handoff: {
      section: () => registerEffect(() => () => {}),
      onCompose: () => registerEffect(() => () => {}),
      onShouldOffer: () => registerEffect(() => () => {}),
      onRedact: (listener) =>
        registerEffect(() => {
          requirePermission('handoff:redact');
          redactListeners.add(listener);
          return () => {
            redactListeners.delete(listener);
          };
        }),
      preview: async (sessionId, targetInstanceId): Promise<ContextHandoffPreviewV2> => {
        requirePermission('session:read');
        const sourceInstanceId = sessionMap.get(sessionId)?.session.harnessId ?? 'mock';
        return {
          sessionId,
          mode: 'full_session_summary',
          deliveryChannel: 'inline',
          sourceInstanceId,
          targetInstanceId,
          coveredSeqRange: { fromSeq: 0, toSeq: 0 },
          unsyncedTurnCount: 0,
          estimatedChars: 0,
          estimatedTokens: 0,
          budgetTokens: 12000,
          syncNeeded: false,
          renderedPayload: '',
        };
      },
    },
    composer: {
      suggest: async () => {
        requirePermission('composer:suggest');
      },
    },
    approvals: {
      annotate: async () => {
        requirePermission('approvals:annotate');
      },
      onAnnotate: () => registerEffect(() => () => {}),
    },
    tools: {
      register: (tool) =>
        registerEffect(() => {
          requirePermission('tools:model');
          if (tools.has(tool.name)) throw new PluginApiError('E_CONFLICT', `工具 ${tool.name} 已注册`);
          tools.set(tool.name, tool);
          return () => {
            tools.delete(tool.name);
          };
        }),
    },
    slots: {
      register: (def) =>
        registerEffect(() => {
          if (!isValidPluginSlotKey(def.slot)) {
            throw new PluginApiError('E_INVALID_INPUT', `无效的 UI 插槽: ${def.slot}`);
          }
          if (!isSafePluginUiPath(def.ui)) {
            throw new PluginApiError('E_INVALID_INPUT', `无效的 UI 路径: ${def.ui}`);
          }
          const normalized = { ...def, slot: normalizeAnyPluginSlotKey(def.slot) };
          if (slots.has(normalized.id)) throw new PluginApiError('E_CONFLICT', `插槽 ${normalized.id} 已注册`);
          slots.set(normalized.id, normalized);
          return () => {
            slots.delete(normalized.id);
          };
        }),
    },
    storage: {
      plugin: {
        get: async <T = unknown>(key: string) => {
          requirePermission('storage:plugin');
          return pluginKv.get(key) as T | undefined;
        },
        set: async (key: string, value: unknown) => {
          requirePermission('storage:plugin');
          pluginKv.set(key, value);
        },
        delete: async (key: string) => {
          requirePermission('storage:plugin');
          pluginKv.delete(key);
        },
        keys: async () => {
          requirePermission('storage:plugin');
          return [...pluginKv.keys()];
        },
      },
      workspace: {
        get: async <T = unknown>(workspaceId: string, key: string) => {
          requirePermission('storage:workspace');
          return workspaceKv.get(workspaceId)?.get(key) as T | undefined;
        },
        set: async (workspaceId: string, key: string, value: unknown) => {
          requirePermission('storage:workspace');
          const bucket = workspaceKv.get(workspaceId) ?? new Map<string, unknown>();
          workspaceKv.set(workspaceId, bucket);
          bucket.set(key, value);
        },
        delete: async (workspaceId: string, key: string) => {
          requirePermission('storage:workspace');
          workspaceKv.get(workspaceId)?.delete(key);
        },
        keys: async (workspaceId: string) => {
          requirePermission('storage:workspace');
          return [...(workspaceKv.get(workspaceId)?.keys() ?? [])];
        },
      },
    },
    fs: {
      read: async (workspaceId, relativePath) => {
        requirePermission('fs:workspace:read');
        const content = workspaceFiles.get(workspaceId)?.get(relativePath);
        if (content === undefined) throw new PluginApiError('E_INVALID_INPUT', `File not found: ${relativePath}`);
        return content;
      },
      list: async (workspaceId): Promise<PublicFsEntry[]> => {
        requirePermission('fs:workspace:read');
        const entries = workspaceFiles.get(workspaceId);
        if (!entries) return [];
        return [...entries.entries()].map(([rel, content]) => ({
          name: rel.split('/').pop() ?? rel,
          relativePath: rel,
          isDirectory: false,
          sizeBytes: content.length,
        }));
      },
      stat: async (workspaceId, relativePath): Promise<PublicFsStat> => {
        requirePermission('fs:workspace:read');
        const content = workspaceFiles.get(workspaceId)?.get(relativePath);
        if (content === undefined) throw new PluginApiError('E_INVALID_INPUT', `File not found: ${relativePath}`);
        return { relativePath, isDirectory: false, sizeBytes: content.length, mtimeMs: Date.now() };
      },
      write: async (workspaceId, relativePath, content) => {
        requirePermission('fs:workspace:write');
        const bucket = workspaceFiles.get(workspaceId) ?? new Map<string, string>();
        workspaceFiles.set(workspaceId, bucket);
        bucket.set(relativePath, content);
      },
    },
    net: {
      fetch: async (url, init) => {
        const host = extractUrlHost(url);
        if (host) requirePermission(`net:${host}`);
        netRequests.push({ url, kind: 'fetch', init });
        if (options.netFetchHandler) return await options.netFetchHandler(url, init);
        return { status: 200, ok: true, headers: {}, body: '' };
      },
      openStream: async (url, init) => {
        const host = extractUrlHost(url);
        if (host) requirePermission(`net:${host}`);
        netRequests.push({ url, kind: 'stream', init });
        if (options.netStreamHandler) return await options.netStreamHandler(url, init);
        return createMockNetStream();
      },
    },
    secrets: {
      resolve: async (secretRef) => {
        const ns = secretRef.split(':')[0] ?? '';
        if (ns) requirePermission(`secrets:read:${ns}`);
        return secrets.get(secretRef) ?? null;
      },
    },
    harnesses: {
      registerDriver: (driver) =>
        registerEffect(() => {
          requirePermission('harness:driver:register');
          const driverId = typeof driver?.driverId === 'string' ? driver.driverId.trim() : '';
          if (!driverId) throw new PluginApiError('E_INVALID_INPUT', '驱动注册缺少 driverId');
          if (driverId === 'codex' || driverId === 'claude' || driverId === 'agy' || driverId === 'acp') {
            throw new PluginApiError('E_PERMISSION_DENIED', `禁止覆盖内置驱动 ID: ${driverId}`);
          }
          if (drivers.has(driverId)) throw new PluginApiError('E_CONFLICT', `驱动 ${driverId} 已注册`);
          drivers.set(driverId, driver);
          return () => {
            drivers.delete(driverId);
          };
        }),
      listInstances: async () => {
        if (options.harnessInstances) return options.harnessInstances;
        return [...drivers.values()].map((d) => ({
          id: d.driverId,
          driverId: d.driverId,
          displayName: d.displayName,
          description: d.description,
          protocolLabel: d.protocolLabel,
          enabled: true,
        }));
      },
    },
    runtime: {
      trustedLocal: options.trustedLocal === true,
      spawnCli: async (spec) => {
        const bin = spec.command.trim();
        if (bin) requirePermission(`process:spawn:${bin}`);
        spawnedClis.push(spec);
        if (options.spawnCliHandler) return await options.spawnCliHandler(spec);
        return createMockCliProcess({ exitCode: 0 });
      },
    },
    notify: {
      send: async (input) => {
        requirePermission('notify');
        notifications.push({ title: input.title, body: input.body, level: input.level });
      },
    },
    clipboard: {
      writeText: async (text) => {
        requirePermission('clipboard:write');
        clipboardHistory.push(text);
      },
    },
  };

  return {
    pluginId,
    runId,
    ctx,
    logs,
    drivers,
    slots,
    commands,
    tools,
    services,
    spawnedClis,
    netRequests,
    notices,
    notifications,
    clipboardHistory,
    async activate(module, config = {}) {
      assertActive();
      await module.apply(ctx, config);
    },
    async emitEvent(event) {
      assertActive();
      const listeners = eventListeners.get(event.type);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        await listener(event);
      }
    },
    async invokeCommand(command, input = {}) {
      assertActive();
      const handler = commands.get(command);
      if (!handler) throw new PluginApiError('E_INVALID_INPUT', `命令未注册: /${command}`);
      return await handler({
        sessionId: input.sessionId ?? 'sess_mock_1',
        workspaceId: input.workspaceId ?? 'ws_mock_1',
        harnessId: input.harnessId ?? 'mock',
        args: input.args ?? '',
      });
    },
    async invokeSlotMessage(slotId, payload, sessionId = null) {
      assertActive();
      const slot = slots.get(slotId);
      if (!slot?.onMessage) throw new PluginApiError('E_INVALID_INPUT', `插槽 ${slotId} 未注册 onMessage`);
      return await slot.onMessage(payload, { sessionId, slotId });
    },
    async invokeRedact(event) {
      assertActive();
      let text = event.text;
      const categories = new Set<string>();
      for (const listener of [...redactListeners]) {
        const res = await listener({ ...event, text });
        text = res.text;
        for (const c of res.categories) categories.add(c);
      }
      return { text, categories: [...categories] };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposer of [...effects].reverse()) {
        try {
          disposer();
        } catch {
          // ignore cleanup errors in mock host
        }
      }
      effects.clear();
    },
  };
}

// ── 4. Offline NDJSON Adapter Transcript Replay Harness ─────────────────

export interface ReplayAdapterTranscriptOptions {
  turnId?: string;
  prompt?: string;
  sessionConfig?: Partial<PublicAdapterSessionConfig>;
  turnOptions?: PublicDriverTurnInput['turnOptions'];
  timeoutMs?: number;
  /** Optional parser when replaying raw NDJSON lines directly without a driver session */
  parseLine?: (line: string, turnId: string) => PublicNormalizedAdapterEvent | PublicNormalizedAdapterEvent[] | null;
}

export interface TranscriptReplayAssertions {
  eventTypes?: PublicNormalizedAdapterEvent['type'][];
  terminalType?: 'turn.completed' | 'turn.failed' | 'turn.cancelled';
  failureClass?: string;
  assistantTextContains?: string;
  thinkingTextContains?: string;
  extBlockTypes?: string[];
  supportsNativeRollback?: boolean;
}

export interface TranscriptReplayResult {
  events: PublicNormalizedAdapterEvent[];
  assistantText: string;
  thinkingText: string;
  extBlocks: Array<Extract<PublicNormalizedAdapterEvent, { type: 'turn_block.ext' }>>;
  terminalEvent: Extract<PublicNormalizedAdapterEvent, { type: 'turn.completed' | 'turn.failed' | 'turn.cancelled' }> | null;
  failureClass: string | null;
  capabilities: PublicHarnessCapabilities | null;
  capabilitiesV2: PublicHarnessCapabilitiesV2 | null;
  probeResult: PublicHarnessProbeResult | null;
  assert(expectations: TranscriptReplayAssertions): void;
}

function isDriverRegistration(value: unknown): value is PluginHarnessDriverRegistration {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PluginHarnessDriverRegistration).driverId === 'string' &&
      typeof (value as PluginHarnessDriverRegistration).createSession === 'function',
  );
}

function isSessionHandle(value: unknown): value is PluginHarnessSessionHandle {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PluginHarnessSessionHandle).sendTurn === 'function' &&
      typeof (value as PluginHarnessSessionHandle).onEvent === 'function',
  );
}

function summarizeReplay(
  events: PublicNormalizedAdapterEvent[],
  capabilities: PublicHarnessCapabilities | null,
  capabilitiesV2: PublicHarnessCapabilitiesV2 | null,
  probeResult: PublicHarnessProbeResult | null,
): TranscriptReplayResult {
  let assistantDeltas = '';
  let assistantCompleted = '';
  let thinkingDeltas = '';
  let thinkingCompleted = '';
  const extBlocks: Array<Extract<PublicNormalizedAdapterEvent, { type: 'turn_block.ext' }>> = [];
  let terminalEvent: TranscriptReplayResult['terminalEvent'] = null;
  let failureClass: string | null = null;

  for (const ev of events) {
    if (ev.type === 'message.assistant.delta') assistantDeltas += ev.text;
    else if (ev.type === 'message.assistant.completed') assistantCompleted = ev.text;
    else if (ev.type === 'thinking.delta') thinkingDeltas += ev.text;
    else if (ev.type === 'thinking.completed') thinkingCompleted = ev.text;
    else if (ev.type === 'turn_block.ext') extBlocks.push(ev);
    else if (ev.type === 'turn.completed' || ev.type === 'turn.failed' || ev.type === 'turn.cancelled') {
      terminalEvent = ev;
      if (ev.type === 'turn.failed' && ev.failureClass) {
        failureClass = ev.failureClass;
      }
    }
  }

  const assistantText = assistantCompleted || assistantDeltas;
  const thinkingText = thinkingCompleted || thinkingDeltas;

  const result: TranscriptReplayResult = {
    events,
    assistantText,
    thinkingText,
    extBlocks,
    terminalEvent,
    failureClass,
    capabilities,
    capabilitiesV2,
    probeResult,
    assert(expectations: TranscriptReplayAssertions) {
      if (expectations.eventTypes) {
        const observedTypes = new Set(events.map((e) => e.type));
        for (const requiredType of expectations.eventTypes) {
          if (!observedTypes.has(requiredType)) {
            throw new Error(
              `Expected replay events to include "${requiredType}", observed: [${[...observedTypes].join(', ')}]`,
            );
          }
        }
      }
      if (expectations.terminalType && terminalEvent?.type !== expectations.terminalType) {
        throw new Error(
          `Expected terminal event "${expectations.terminalType}", got "${terminalEvent?.type ?? 'none'}"`,
        );
      }
      if (expectations.failureClass !== undefined && failureClass !== expectations.failureClass) {
        throw new Error(`Expected failureClass "${expectations.failureClass}", got "${failureClass ?? 'null'}"`);
      }
      if (expectations.assistantTextContains && !assistantText.includes(expectations.assistantTextContains)) {
        throw new Error(
          `Expected assistantText to contain "${expectations.assistantTextContains}", got "${assistantText}"`,
        );
      }
      if (expectations.thinkingTextContains && !thinkingText.includes(expectations.thinkingTextContains)) {
        throw new Error(
          `Expected thinkingText to contain "${expectations.thinkingTextContains}", got "${thinkingText}"`,
        );
      }
      if (expectations.extBlockTypes) {
        const seenExt = new Set(extBlocks.map((b) => b.blockType));
        for (const extType of expectations.extBlockTypes) {
          if (!seenExt.has(extType as `ext:${string}`)) {
            throw new Error(
              `Expected ext block type "${extType}", observed: [${[...seenExt].join(', ')}]`,
            );
          }
        }
      }
      if (
        expectations.supportsNativeRollback !== undefined &&
        capabilitiesV2?.supportsNativeRollback !== expectations.supportsNativeRollback
      ) {
        throw new Error(
          `Expected capabilitiesV2.supportsNativeRollback=${String(expectations.supportsNativeRollback)}, got ${String(capabilitiesV2?.supportsNativeRollback)}`,
        );
      }
    },
  };

  return result;
}

/**
 * Replays recorded NDJSON transcript lines offline against either:
 * - A `PluginHarnessDriverRegistration` (invoking `probe()`, `createSession()`, `sendTurn()`),
 * - A `PluginHarnessSessionHandle`, or
 * - A standalone line parser function `(line, turnId) => PublicNormalizedAdapterEvent | PublicNormalizedAdapterEvent[] | null`.
 */
export async function replayAdapterTranscript(
  target:
    | PluginHarnessDriverRegistration
    | PluginHarnessSessionHandle
    | ((line: string, turnId: string) => PublicNormalizedAdapterEvent | PublicNormalizedAdapterEvent[] | null),
  ndjsonLines: readonly string[],
  options: ReplayAdapterTranscriptOptions = {},
): Promise<TranscriptReplayResult> {
  const turnId = options.turnId ?? 'turn_replay_1';

  // Mode A: Direct NDJSON line parser function
  if (typeof target === 'function') {
    const events: PublicNormalizedAdapterEvent[] = [];
    for (const rawLine of ndjsonLines) {
      const line = rawLine.trim();
      if (!line) continue;
      const out = target(line, turnId);
      if (Array.isArray(out)) events.push(...out);
      else if (out) events.push(out);
    }
    return summarizeReplay(events, null, null, null);
  }

  let probeResult: PublicHarnessProbeResult | null = null;
  let capabilities: PublicHarnessCapabilities | null = null;
  let capabilitiesV2: PublicHarnessCapabilitiesV2 | null = null;
  let handle: PluginHarnessSessionHandle;
  let shouldDispose = false;

  if (isDriverRegistration(target)) {
    capabilities = target.capabilities;
    capabilitiesV2 = target.capabilitiesV2 ?? null;
    probeResult = await target.probe();
    handle = await target.createSession({
      cwd: options.sessionConfig?.cwd ?? '/mock/workspace',
      model: options.sessionConfig?.model ?? probeResult.defaultModelId ?? null,
      reasoningEffort: options.sessionConfig?.reasoningEffort ?? null,
      permissionMode: options.sessionConfig?.permissionMode ?? 'manual',
      nativeSessionId: options.sessionConfig?.nativeSessionId ?? null,
    });
    shouldDispose = true;
  } else if (isSessionHandle(target)) {
    handle = target;
  } else {
    throw new PluginApiError('E_INVALID_INPUT', 'replayAdapterTranscript requires a driver, session handle, or line parser');
  }

  const events: PublicNormalizedAdapterEvent[] = [];
  let resolveDone: (() => void) | null = null;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const unsub = handle.onEvent((ev) => {
    events.push(ev);
    if (ev.type === 'turn.completed' || ev.type === 'turn.failed' || ev.type === 'turn.cancelled') {
      resolveDone?.();
    }
  });

  try {
    await handle.sendTurn({
      turnId,
      text: options.prompt ?? (ndjsonLines.length > 0 ? ndjsonLines.join('\n') : 'Replay test turn'),
      turnOptions: options.turnOptions,
    });

    // Wait briefly for async stdout / SSE streams to settle to a terminal event
    const timeoutMs = options.timeoutMs ?? 1500;
    const timers = globalThis as unknown as {
      setTimeout?: (cb: () => void, ms?: number) => unknown;
      clearTimeout?: (handle: unknown) => void;
    };
    let timerHandle: unknown;
    await Promise.race([
      donePromise,
      new Promise<void>((resolve) => {
        if (typeof timers.setTimeout === 'function') {
          timerHandle = timers.setTimeout(resolve, timeoutMs);
        } else {
          void Promise.resolve().then(resolve);
        }
      }),
    ]);
    if (timerHandle !== undefined && typeof timers.clearTimeout === 'function') {
      timers.clearTimeout(timerHandle);
    }

    // If custom parseLine was also passed and the session emitted no events directly, run parseLine fallback
    if (events.length === 0 && options.parseLine) {
      for (const rawLine of ndjsonLines) {
        const line = rawLine.trim();
        if (!line) continue;
        const out = options.parseLine(line, turnId);
        if (Array.isArray(out)) events.push(...out);
        else if (out) events.push(out);
      }
    }
  } finally {
    unsub();
    if (shouldDispose) {
      await handle.dispose().catch(() => {});
    }
  }

  return summarizeReplay(events, capabilities, capabilitiesV2, probeResult);
}
