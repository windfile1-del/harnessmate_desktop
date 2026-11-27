import path from 'node:path';
import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  AddTrustedPublisherRequestSchema,
  AgyAuthCancelRequestSchema,
  AgyAuthLogoutRequestSchema,
  AgyAuthRespondRequestSchema,
  type AgyProfileConfig,
  BuilderV2AuditRequestSchema,
  BuilderV2GenerateRequestSchema,
  BuilderV2InstallRequestSchema,
  CreateCustomRiskRuleRequestSchema,
  CreateSessionRequestSchema,
  CreateTerminalContextChipRequestSchema,
  CreateWorkspaceRequestSchema,
  CreateWorktreeRequestSchema,
  CustomAcpHarnessConfigSchema,
  DelegateSubagentRequestSchema,
  DryRunMergeRequestSchema,
  DryRunSubagentMergeRequestSchema,
  FailoverRequestSchema,
  ForkSessionRequestSchema,
  GcCheckpointsRequestSchema,
  GeneratePluginDraftRequestSchema,
  GitCommitRequestSchema,
  GitCreatePrRequestSchema,
  GitDiscardFileRequestSchema,
  GitPullRequestSchema,
  GitPushRequestSchema,
  InstallPluginRequestSchema,
  LinkDevPluginRequestSchema,
  ManualCompressRequestSchema,
  MergeBackRequestSchema,
  MergeSubagentRequestSchema,
  OpenTerminalRequestSchema,
  PROTOCOL_VERSION,
  PairExchangeRequestSchema,
  ReleaseTerminalsPathRequestSchema,
  RemoveWorktreeRequestSchema,
  ResolveApprovalRequestSchema,
  RevertCheckpointRequestSchema,
  RunHarnessCommandRequestSchema,
  ScaffoldPluginRequestSchema,
  SendToSubagentRequestSchema,
  SendTurnRequestSchema,
  SideChatPromoteRequestSchema,
  SideChatRequestSchema,
  SwitchHarnessRequestSchema,
  TerminalInputRequestSchema,
  TogglePluginRequestSchema,
  TrustSetupScriptRequestSchema,
  UpdateCompressionConfigRequestSchema,
  UpdatePluginRegistryConfigRequestSchema,
  UpdateRemoteConfigRequestSchema,
  UpdateSessionRequestSchema,
  PluginPanelQuerySchema,
  PluginUiMessageRequestSchema,
  PreviewPluginProgramRequestSchema,
  ReplayPluginDraftRequestSchema,
  RunPluginActionRequestSchema,
  SetPluginPermissionRequestSchema,
  UploadAttachmentRequestSchema,
  UpsertAgyInstanceRequestSchema,
  type CanonicalEvent,
  type ContextSyncMode,
  type RemoteAccessStatus,
} from '@harnessmate/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  discoverNetworkAddresses,
  loadOrCreateConfig,
  resolveRuntimePaths,
  saveConfig,
  type DaemonPersistedConfig,
  type DaemonRuntimePaths,
} from '../config.js';
import { CommandOutputHub } from '../core/command-output-hub.js';
import { EffectOutboxWorker } from '../core/effect-outbox.js';
import { DaemonEventBus } from '../core/event-bus.js';
import { SessionManager } from '../core/session-manager.js';
import { readSessionLedger, registerSessionAssistanceCompatRoutes } from './routes/session-assistance-compat.js';
import {
  TerminalWorkspaceService,
} from '../core/terminal-workspace-service.js';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  ContextCompressionError,
} from '../core/context-compression-service.js';
import { ORCHESTRATOR_PLUGIN_ID, OrchestratorError } from '../core/orchestrator-service.js';
import { createBuiltinPlugins, type GitService } from '../plugin-host/builtin/services.js';
import { GitOperationError } from '../core/git-service.js';
import {
  AGY_ACCOUNTS_CONTRACT,
  AGY_RUNTIME_CONTRACT,
  AGY_WORKBENCH_CONTRACT,
  FILE_PREVIEW_PERMISSION,
  HARNESS_DRIVER_ACP_CONTRACT,
  PLUGIN_EVENT_VERSION,
  PluginApiError,
} from '@harnessmate/plugin-api';
import type { AcpPluginFacade } from '../plugins/harness-acp-default/index.js';
import {
  AGY_RUNTIME_INTERNAL_SERVICE,
  type AgyRuntimeInternalHandle,
} from '../plugins/harness-agy-default/index.js';
import {
  listActiveAgyAccountsProviders,
  resolveAgyAccountsProvider,
  resolveAgyRuntimeProvider,
  resolveOptionalAgyRuntimeProvider,
} from '../core/agy-peer-router.js';
import { HarnessMateStore } from '../db/sqlite.js';
import { HarnessRegistry } from '../harnesses/registry.js';
import {
  NativeWsFeedGateway,
  AgyConsumerProvenanceError,
  mintAgyDispatchProvenance,
  registerAgyNativeRoutes,
  type AgyNativeRuntimeRegistry,
} from '../harnesses/agy/native/wiring/index.js';
import type { AgyNativeFeatureFlags } from '../harnesses/agy/native/wiring/types.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { PluginManager, PluginRevisionConflictError } from '../plugins/plugin-manager.js';
import { PluginAuthoring } from '../plugins/plugin-authoring.js';
import { PluginBuilderV2 } from '../plugins/plugin-builder-v2.js';
import { auditPluginPackage } from '../plugins/plugin-static-audit.js';
import { readPluginPanel } from '../plugins/plugin-panels.js';
import { PluginCapabilities } from '../plugins/plugin-capabilities.js';
import { registerHarnessIntegrationCompat } from './routes/harness-integration-compat.js';
import { invalidateAccountUsage } from '../plugin-host/builtin/harness-integration.js';
import { pluginMcpPath, registerPluginMcp } from '../plugins/plugin-mcp.js';
import { runPluginProgram } from '../plugins/plugin-program.js';
import { SANDBOX_IFRAME_CSP, buildSandboxedPluginHtml, resolvePluginUiAsset } from '../plugins/plugin-ui.js';
import { GLOBAL_WORKSPACE_SCOPE, PluginPermissionService } from '../plugin-host/permissions/permissions.js';
import type { CrashPolicy } from '../plugin-host/isolation/isolated-process.js';
import { authorizeLegacyPluginBrowserView, renderLegacyFilePreview } from '../plugin-host/compat/legacy-compat.js';
import { PluginSecretStore } from '../plugin-host/isolation/plugin-secrets.js';
import { RemoteAuthService, isLocalBrowserRequest, isLoopbackAddress } from './auth.js';
import { WsGateway } from './ws.js';
import { SessionChangeFeedService } from '../core/session-change-feed.js';
import { HistoryImportAdapter } from '../core/history-import-adapter.js';
import { findSessionWithProvider, findWorkspaceWithProvider, listActiveSessionRuntimeProviders } from '../core/session-peer-router.js';
import { httpStatusForPluginError } from '../core/w1-service-helpers.js';
import { registerServiceResolutionRoute } from '../plugin-host/composition/resolve-route.js';
import { registerUiServices } from './routes/ui-services.js';
import { registerHistoryImportCompatRoutes } from './routes/history-import-compat.js';
import { registerSessionSearchCompatRoutes } from './routes/session-search-compat.js';
import { registerGitWorktreesCompatRoutes } from './routes/git-worktrees-compat.js';
import { registerCheckpointsCompatRoutes } from './routes/checkpoints-compat.js';
import { registerTerminalCompatRoutes } from './routes/terminal-compat.js';
import { registerFilesAttachmentsRulesCompatRoutes } from './routes/files-attachments-rules-compat.js';
import { PEER_CONTRACTS } from '@harnessmate/plugin-api';

export interface CreateDaemonOptions {
  dataDir?: string;
  port?: number;
  hostOverride?: string;
  customAdapters?: HarnessAdapter[];
  binaryOverrides?: Record<string, string>;
  webDistDir?: string | null;
  pluginCrashPolicy?: CrashPolicy;
  pluginSafeMode?: boolean;
  bundledPluginsDir?: string;
  nativeFeatureFlags?: Partial<AgyNativeFeatureFlags>;
}

export interface DaemonInstance {
  app: FastifyInstance;
  store: HarnessMateStore;
  registry: HarnessRegistry;
  pluginManager: PluginManager;
  pluginSecrets: PluginSecretStore;
  sessionManager: SessionManager;
  nativeRegistry: AgyNativeRuntimeRegistry;
  commandOutputHub: CommandOutputHub;
  terminalWorkspace: TerminalWorkspaceService;
  outboxWorker: EffectOutboxWorker;
  auth: RemoteAuthService;
  config: DaemonPersistedConfig;
  paths: DaemonRuntimePaths;
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

export function createDaemon(opts: CreateDaemonOptions = {}): DaemonInstance {
  const paths = resolveRuntimePaths(opts.dataDir);
  if (opts.webDistDir !== undefined) {
    paths.webDistDir = opts.webDistDir;
  }
  const config = loadOrCreateConfig(paths.configPath, opts.port);
  if (opts.binaryOverrides) {
    config.binaryOverrides = { ...config.binaryOverrides, ...opts.binaryOverrides };
  }
  const store = new HarnessMateStore(paths.dbPath);
  const eventBus = new DaemonEventBus();
  const registry = new HarnessRegistry();
  if (opts.customAdapters) {
    for (const adapter of opts.customAdapters) {
      if (!registry.isReserved(adapter.id)) registry.register(adapter);
    }
  }

  const pluginPermissions = new PluginPermissionService(store);
  const pluginSecrets = new PluginSecretStore();
  const terminalWorkspace = new TerminalWorkspaceService(store, { initialActive: false });
  const terminalSessionOwners = new Map<string, string>();
  const commandOutputHub = new CommandOutputHub();
  const sessionChangeFeed = new SessionChangeFeedService(store);
  const historyImportAdapter = new HistoryImportAdapter(store, registry, sessionChangeFeed);
  let sessionManager: SessionManager;
  let wsGateway: WsGateway;
  let pendingRuntimeController: import('../plugins/session-runtime-default/index.js').SessionRuntimeDefaultController | null = null;
  const pluginManager: PluginManager = new PluginManager(
    paths.pluginsDir,
    registry,
    () => config.disabledPlugins,
    createBuiltinPlugins(
      store,
      registry,
      config,
      {
        plugins: () => pluginManager,
        changes: sessionChangeFeed,
        events: eventBus,
        readLedger: (session) => readSessionLedger(pluginManager, store, session.id),
        report: (error) => app.log.error(error),
        ledgerUpdated: (state) => {
          const payload = {
            version: state.version,
            objective: state.objective,
            stepsCount: state.steps.length,
            doneStepsCount: state.steps.filter(({ status }) => status === 'done').length,
            touchedFilesCount: state.touchedFiles.length,
            ledgerFilePath: state.ledgerFilePath ?? null,
          };
          if (store.getSession(state.sessionId)) {
            eventBus.publishEvent(store.appendEvent(state.sessionId, 'task.state_updated', payload));
            return;
          }
          if (!pluginManager.hasLoadedRegistry()) return;
          void findSessionWithProvider(pluginManager, state.sessionId)
            .then(async (found) => {
              if (!found) return;
              const appended = await found.provider.service.appendEvent({
                sessionId: state.sessionId,
                type: 'task.state_updated',
                turnId: null,
                payload,
              });
              if (appended.ok) {
                const ev = appended.value.event;
                eventBus.publishEvent({
                  sessionId: ev.sessionId,
                  seq: ev.seq,
                  turnId: ev.turnId,
                  type: ev.type as CanonicalEvent['type'],
                  payload: ev.payload,
                  createdAt: ev.createdAt,
                });
              }
            })
            .catch((error) => {
              app.log.error(error);
            });
        },
        inboxUpdated: (session, event) => {
          wsGateway.notifyTriage({ op: 'triage_updated', session, event });
          if (event) {
            void pluginManager.dispatchLifecycleEvent({
              version: PLUGIN_EVENT_VERSION,
              type: event.type,
              sessionId: event.sessionId,
              turnId: null,
              seq: null,
              createdAt: event.createdAt,
              data: { snoozedUntilMs: event.snoozedUntilMs },
            }, store.getSession(event.sessionId)?.workspaceId);
          }
        },
      },
      () => pluginManager.host.events,
      opts.customAdapters,
      async (event) => (await pluginManager.isolated?.collectHandoffSections(event)) ?? [],
      terminalWorkspace,
      paths.agyProfilesDir,
      historyImportAdapter,
      paths.attachmentsDir,
      () => pluginCapabilities,
      () => pluginManager,
      {
        eventBus,
        changeFeed: sessionChangeFeed,
        commandOutputHub,
        initialNativeFeatureFlags: opts.nativeFeatureFlags,
        getSessionManager: () => sessionManager,
        onConfigSave: () => saveConfig(paths.configPath, config),
        onAuthStateChanged: (state) => wsGateway?.notifyAgyAuthState(state),
        onUsageCacheInvalidate: (instanceId) => invalidateAccountUsage(pluginManager, instanceId),
        getPendingSettlementSink: () => sessionManager?.createSettlementSink(),
        getApprovalCenter: () => sessionManager.getApprovalCenter(),
        getOrchestrator: () => sessionManager.getOrchestratorIfEnabled(),
        onAnnotatePendingApproval: async (session, approval) => {
          await sessionManager.annotatePendingApproval(session, approval);
        },
        onAttachCompressorHooks: () => sessionManager.attachCompressorForRuntime(),
        onRuntimeControllerReady: (ctrl) => {
          pendingRuntimeController = ctrl;
          sessionManager?.attachRuntimeController?.(ctrl);
        },
        emitCanonical: (sessionId, type, payload, turnId) =>
          sessionManager.emitCanonical(sessionId, type, payload, turnId ?? null),
        createSession: (req) => sessionManager.createSession(req),
        addWorkspace: (rootPath, name) => sessionManager.addWorkspace(rootPath, name),
        tryNativeFork: async (source) => {
          const handle = sessionManager.getRuntimeController()?.getLiveHandle(source.id, source.harnessId);
          if (handle?.runNativeCommand) {
            const out = await handle.runNativeCommand('fork', source.nativeSessionId ?? '');
            const text = typeof out === 'string' ? out : out.output;
            const trimmed = text.trim();
            if (trimmed && !/\s/.test(trimmed)) return trimmed;
          }
          return null;
        },
        onSessionImported: (importedSession, meta) => {
          eventBus.publishAttention({
            kind: 'session_updated',
            sessionId: importedSession.id,
            sessionTitle: importedSession.title,
            harnessId: importedSession.harnessId,
            summary: `Imported session (${String(meta.mode ?? 'attach')})`,
            timestamp: Date.now(),
          });
        },
        sendTurn: (sessionId, text, turnOpts) => sessionManager.sendTurn(sessionId, text, undefined, turnOpts),
        interruptSession: (sessionId) => sessionManager.interruptSession(sessionId),
        disposeSessionHandles: (sessionId) => sessionManager.disposeSessionHandles(sessionId),
      },
    ),
    { store, permissions: pluginPermissions, pluginSecrets, crashPolicy: opts.pluginCrashPolicy, safeMode: opts.pluginSafeMode,
      bundledPluginsDir: opts.bundledPluginsDir, onDevReload: () => wsGateway.notifyPluginsChanged() },
  );
  const pluginAuthoring = new PluginAuthoring(registry);
  const pluginBuilderV2 = new PluginBuilderV2(paths.dataDir, registry, pluginAuthoring, pluginManager);

  let boundPort = config.port;
  const outboxWorker = new EffectOutboxWorker(store);
  const pluginCapabilities = new PluginCapabilities(store, pluginManager, () => `http://127.0.0.1:${boundPort}${pluginMcpPath}`, pluginPermissions);
  sessionManager = new SessionManager(store, registry, eventBus, pluginManager, pluginCapabilities, commandOutputHub, terminalWorkspace);
  pluginManager.bootstrapFirstPartySync();
  sessionManager.bindSettlementSinkToActiveAgy();
  sessionChangeFeed.attachPluginHost(pluginManager.host);
  if (pendingRuntimeController) {
    sessionManager.attachRuntimeController(pendingRuntimeController);
  }
  historyImportAdapter.attachHooks({
    addWorkspace: (rootPath, name) => sessionManager.addWorkspace(rootPath, name),
    onSessionImported: (importedSession, meta) => {
      eventBus.publishAttention({
        kind: 'session_updated',
        sessionId: importedSession.id,
        sessionTitle: importedSession.title,
        harnessId: importedSession.harnessId,
        summary: `Imported session (${String(meta.mode ?? 'attach')})`,
        timestamp: Date.now(),
      });
    },
  });
  const terminalOwnerStatusUnsubs = new Map<string, () => void>();
  const syncTerminalOwnerListeners = () => {
    const activeIds = new Set<string>();
    const candidates = [
      ...pluginManager.host.listServiceProviders(PEER_CONTRACTS.terminalWorkspace),
      ...pluginManager.host.listServiceProviders('terminal-workspace'),
    ];
    for (const prov of candidates) {
      activeIds.add(prov.instanceId);
      if (terminalOwnerStatusUnsubs.has(prov.instanceId)) continue;
      const svc =
        pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(prov.instanceId, 'terminal-workspace') ??
        pluginManager.host.getServiceByInstance<TerminalWorkspaceService>(prov.instanceId, PEER_CONTRACTS.terminalWorkspace);
      if (svc && typeof svc.subscribeStatus === 'function') {
        terminalOwnerStatusUnsubs.set(
          prov.instanceId,
          svc.subscribeStatus(({ terminal, event }) => {
            const ownerSessionId = terminalSessionOwners.get(terminal.terminalId);
            if (ownerSessionId && event === 'exited') {
              sessionManager.recordTerminalEvent(ownerSessionId, 'terminal.exited', {
                terminalId: terminal.terminalId,
                title: terminal.title,
                cwd: terminal.cwd,
                exitCode: terminal.exitCode ?? null,
              });
            }
            if (event === 'closed') {
              terminalSessionOwners.delete(terminal.terminalId);
            }
          }),
        );
      }
    }
    for (const [instId, unsub] of terminalOwnerStatusUnsubs) {
      if (!activeIds.has(instId)) {
        unsub();
        terminalOwnerStatusUnsubs.delete(instId);
      }
    }
  };
  syncTerminalOwnerListeners();
  pluginManager.isolated?.setNativeCommandRunner(async (sessionId, command, args) => {
    const session = await sessionManager.getSessionAsync(sessionId);
    if (!session) throw new PluginApiError('E_INVALID_INPUT', '会话不存在');
    try {
      const result = await sessionManager.runHarnessCommand(sessionId, {
        command: command as Parameters<SessionManager['runHarnessCommand']>[1]['command'],
        args: args ?? '',
        harnessId: session.harnessId,
      }, mintAgyDispatchProvenance('plugin_automated', 'plugin', 'isolated-plugin-native-command'));
      return { output: result.output, notice: result.turnId ? `已触发轮次 ${result.turnId}` : undefined };
    } catch (err) {
      if (!(err instanceof AgyConsumerProvenanceError)) throw err;
      throw new PluginApiError('E_PERMISSION_DENIED', err.message);
    }
  });
  const auth = new RemoteAuthService(store, config.localToken);
  wsGateway = new WsGateway({
    desktopId: config.desktopId,
    desktopName: config.desktopName,
    auth,
    eventBus,
    sessionManager,
    terminalWorkspace,
    pluginManager,
  });
  pluginManager.host.events.on('plugin.state', () => {
    syncTerminalOwnerListeners();
    sessionManager.bindSettlementSinkToActiveAgy();
    wsGateway.notifyPluginsChanged();
  });
  pluginPermissions.onChange(({ capability }) => {
    if (capability === FILE_PREVIEW_PERMISSION) wsGateway.notifyPluginsChanged();
  });
  const nativeWsGateway = new NativeWsFeedGateway({
    auth,
    sessionManager,
    pluginManager,
    store,
  });

  const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 });
  const boundHost = opts.hostOverride ?? (config.lanEnabled ? '0.0.0.0' : '127.0.0.1');

  void app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    const urlPath = request.url.split('?')[0] ?? '';
    if (!urlPath.startsWith('/api/v1/')) return;
    if (
      urlPath === '/api/v1/health' ||
      urlPath === pluginMcpPath ||
      urlPath === '/api/v1/pair/exchange'
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const principal = auth.authenticate(request.socket.remoteAddress, token);
    if (!principal) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    if (principal.kind === 'local' && !isLocalBrowserRequest(request.headers)) {
      return reply.code(403).send({ error: 'Local API origin or host is not allowed' });
    }
    if ((urlPath.startsWith('/api/v1/plugins/') || urlPath.startsWith('/api/v1/plugin-instances/'))
      && (request.method !== 'GET' || urlPath === '/api/v1/plugins/composition')
      && (principal.kind !== 'local' || !isLoopbackAddress(request.socket.remoteAddress))) {
      return reply.code(403).send({ error: '插件管理仅在本机可用' });
    }
    (request as unknown as { principal: typeof principal }).principal = principal;
    await pluginManager.ensureBootstrapped();
  });

  const sendPluginError = (reply: import('fastify').FastifyReply, err: unknown, fallbackStatus = 400) => {
    if (err instanceof PluginApiError) {
      const mapped = httpStatusForPluginError(err);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'E_PLUGIN_DISABLED') {
      return reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
        code: 'E_PLUGIN_DISABLED',
      });
    }
    return reply.code(fallbackStatus).send({ error: err instanceof Error ? err.message : String(err) });
  };

  // ── Health & Harnesses ───────────────────────────────────────────────

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    daemonVersion: process.env.HARNESSMATE_APP_VERSION || '0.6.0',
    pluginSafeMode: Boolean(opts.pluginSafeMode),
    emptyComposition: pluginManager.isEmptyComposition(),
    protocolVersion: PROTOCOL_VERSION,
    desktopId: config.desktopId,
    desktopName: config.desktopName,
    port: boundPort,
    lanEnabled: config.lanEnabled,
    uptimeSec: Math.floor(process.uptime()),
  }));

  app.post('/api/v1/shutdown', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Shutdown only allowed from loopback' });
    }
    reply.send({ shuttingDown: true });
    setTimeout(() => {
      void (async () => {
        wsGateway.close();
        pluginAuthoring.cancel();
        pluginBuilderV2.cancel();
        await terminalWorkspace.disposeAll();
        await sessionManager.shutdown();
        await app.close();
        await pluginManager.close();
        store.close();
        process.exit(0);
      })();
    }, 80);
    return reply;
  });

  app.get('/api/v1/harnesses', async (request) => {
    const query = request.query as { refresh?: string; workspaceId?: string; sessionId?: string };
    const harnesses = await registry.probeAll(query.refresh === '1' || query.refresh === 'true');
    if (query.workspaceId || query.sessionId) {
      const selectedByCategory: Record<string, string | null> = {};
      for (const category of ['codex', 'claude', 'acp', 'agy']) {
        const res = pluginManager.resolveServiceSelection(`harness.driver.${category}.v1`, {
          workspaceId: query.workspaceId,
          sessionId: query.sessionId,
          allowSingleCandidate: true,
        });
        selectedByCategory[category] = res.status === 'ready' ? (res.instanceId ?? null) : null;
      }
      return { harnesses, selectedByCategory };
    }
    return { harnesses };
  });

  app.post('/api/v1/harnesses/custom', async (request, reply) => {
    const acpResolution = pluginManager.resolveServiceSelection(HARNESS_DRIVER_ACP_CONTRACT, {
      allowSingleCandidate: true,
    });
    const acpFacade = pluginManager.host.get<AcpPluginFacade>('harness.acp');
    if (acpResolution.status === 'disabled' || !acpFacade) {
      return reply.code(409).send({ error: '自定义 ACP 引擎插件已停用', code: 'E_PLUGIN_DISABLED' });
    }
    const parsed = CustomAcpHarnessConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid harness config' });
    }
    const existingIdx = config.customAcpHarnesses.findIndex((h) => h.id === parsed.data.id);
    if (registry.isReserved(parsed.data.id) || (existingIdx < 0 && registry.get(parsed.data.id))) {
      return reply.code(409).send({ error: 'Harness ID 已被内置或插件引擎使用' });
    }
    if (existingIdx >= 0) {
      config.customAcpHarnesses[existingIdx] = parsed.data;
    } else {
      config.customAcpHarnesses.push(parsed.data);
    }
    saveConfig(paths.configPath, config);
    if (typeof acpFacade.registerCustomHarness === 'function') {
      acpFacade.registerCustomHarness(parsed.data);
    } else {
      registry.registerCustomAcp(parsed.data);
    }
    const harnesses = await registry.probeAll(true);
    return { harnesses };
  });

  app.delete('/api/v1/harnesses/custom/:id', async (request, reply) => {
    const acpFacade = pluginManager.host.get<AcpPluginFacade>('harness.acp');
    if (!acpFacade) {
      return reply.code(409).send({ error: '自定义 ACP 引擎插件已停用', code: 'E_PLUGIN_DISABLED' });
    }
    const { id } = request.params as { id: string };
    const before = config.customAcpHarnesses.length;
    config.customAcpHarnesses = config.customAcpHarnesses.filter((h) => h.id !== id);
    if (config.customAcpHarnesses.length === before) {
      return reply.code(404).send({ error: 'Custom harness not found' });
    }
    saveConfig(paths.configPath, config);
    if (typeof acpFacade.unregisterCustomHarness === 'function') {
      acpFacade.unregisterCustomHarness(id);
    } else if (!registry.isReserved(id) && registry.get(id)?.isCustom) {
      registry.unregister(id);
    }
    const harnesses = await registry.probeAll(false);
    return { harnesses };
  });

  registerHistoryImportCompatRoutes(app, {
    store,
    pluginManager,
    adapter: historyImportAdapter,
  });

  // ── AGY Accounts & Auth Compat Routes (forwarded to `agy.accounts.v1` peer plugins) ──

  const mapAgyPeerError = (reply: import('fastify').FastifyReply, error: { code: string; message: string }) => {
    switch (error.code) {
      case 'plugin_disabled':
      case 'E_PLUGIN_DISABLED':
        return reply.code(409).send({ error: error.message, code: 'E_PLUGIN_DISABLED' });
      case 'conflict':
        return reply.code(409).send({ error: error.message, code: 'E_CONFLICT' });
      case 'not_found':
      case 'NOT_FOUND':
        return reply.code(404).send({ error: error.message });
      case 'not_supported':
      case 'UNSUPPORTED_ACTION':
        return reply.code(400).send({ error: error.message });
      default:
        return reply.code(400).send({ error: error.message });
    }
  };

  const resolveAccountsProviderForProfile = async (
    profileId: string,
    explicitProviderInstanceId?: string,
  ) => {
    if (explicitProviderInstanceId) {
      return resolveAgyAccountsProvider(pluginManager, {
        explicitInstanceId: explicitProviderInstanceId,
      });
    }
    const entry = registry.getEntry(profileId);
    if (entry?.providerInstanceId) {
      return resolveAgyAccountsProvider(pluginManager, {
        explicitInstanceId: entry.providerInstanceId,
      });
    }
    const activeProviders = listActiveAgyAccountsProviders(pluginManager);
    for (const prov of activeProviders) {
      const info = await prov.service.getProviderInfo();
      if (info.ok && info.value.managedHarnessIds.includes(profileId)) {
        return prov;
      }
    }
    return resolveAgyAccountsProvider(pluginManager, { allowSingleCandidate: true });
  };

  const toLegacyAuthState = (state: {
    instanceId: string;
    phase: string;
    flowId?: string | null;
    authUrl?: string | null;
    message?: string | null;
    error?: string | null;
  }) => ({
    instanceId: state.instanceId,
    phase: state.phase,
    flowId: state.flowId ?? null,
    authorizationUrl: state.authUrl ?? null,
    expiresAt: null,
    message: state.message ?? state.error ?? null,
  });

  app.get('/api/v1/harnesses/agy/instances', async (request, reply) => {
    const q = request.query as { providerInstanceId?: string; workspaceId?: string };
    try {
      if (q.providerInstanceId || q.workspaceId) {
        const provider = resolveAgyAccountsProvider(pluginManager, {
          explicitInstanceId: q.providerInstanceId,
          workspaceId: q.workspaceId,
          allowSingleCandidate: true,
        });
        const res = await provider.service.listInstances();
        if (!res.ok) return mapAgyPeerError(reply, res.error);
        return {
          instances: res.value.instances.map((item) => ({
            identity: item.identity,
            profile: item.profile,
            authState: toLegacyAuthState(item.authState),
          })),
        };
      }
      const providers = listActiveAgyAccountsProviders(pluginManager);
      if (providers.length === 0) {
        // Trigger exact E_PLUGIN_DISABLED / E_SERVICE_UNAVAILABLE when disabled (zero fallback)
        resolveAgyAccountsProvider(pluginManager, { allowSingleCandidate: true });
      }
      const instances: Array<Record<string, unknown>> = [];
      for (const provider of providers) {
        const res = await provider.service.listInstances();
        if (!res.ok) continue;
        for (const item of res.value.instances) {
          instances.push({
            identity: item.identity,
            profile: item.profile,
            authState: toLegacyAuthState(item.authState),
          });
        }
      }
      return { instances };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.post('/api/v1/harnesses/agy/instances', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY profiles can only be modified locally from Desktop' });
    }
    const q = request.query as { providerInstanceId?: string; workspaceId?: string };
    try {
      const provider = resolveAgyAccountsProvider(pluginManager, {
        explicitInstanceId: q.providerInstanceId,
        workspaceId: q.workspaceId,
        allowSingleCandidate: true,
      });
      const res = await provider.service.upsertInstance({
        profile: (request.body ?? {}) as Record<string, unknown>,
      });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      const harnesses = await registry.probeAll(true);
      return {
        identity: res.value.identity,
        profile: res.value.profile,
        authState: toLegacyAuthState(res.value.authState),
        harnesses,
      };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.delete('/api/v1/harnesses/agy/instances/:id', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY profiles can only be deleted locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { purgeData?: string; providerInstanceId?: string };
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.deleteInstance({
        profileInstanceId: id,
        purgeData: q.purgeData === '1' || q.purgeData === 'true',
      });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      const harnesses = await registry.probeAll(false);
      return { deleted: res.value.deleted, instanceId: res.value.instanceId, harnesses };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/harnesses/agy/instances/:id/auth/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { providerInstanceId?: string };
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.getAuthState({ profileInstanceId: id });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return { state: toLegacyAuthState(res.value.state) };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/start', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login can only be started locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { providerInstanceId?: string };
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.startLogin({ profileInstanceId: id });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return { state: toLegacyAuthState(res.value.state) };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/respond', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login code can only be submitted locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { providerInstanceId?: string };
    const parsed = AgyAuthRespondRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid login response payload' });
    }
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.respondLogin({
        profileInstanceId: id,
        flowId: parsed.data.flowId,
        codeOrUrl: parsed.data.codeOrUrl,
      });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      const harnesses = await registry.probeAll(true);
      return { state: toLegacyAuthState(res.value.state), harnesses };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/cancel', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login cancellation is local only' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { providerInstanceId?: string };
    const parsed = AgyAuthCancelRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid cancel payload' });
    }
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.cancelLogin({
        profileInstanceId: id,
        flowId: parsed.data.flowId,
      });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return { state: toLegacyAuthState(res.value.state) };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/logout', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY logout can only be triggered locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { providerInstanceId?: string };
    const parsed = AgyAuthLogoutRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid logout payload' });
    }
    try {
      const provider = await resolveAccountsProviderForProfile(id, q.providerInstanceId);
      const res = await provider.service.logout({
        profileInstanceId: id,
        confirmSharedKeyring: parsed.data.confirmSharedKeyring,
      });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      const harnesses = await registry.probeAll(true);
      return { state: toLegacyAuthState(res.value.state), harnesses };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  // ── Session Search (Peer Plugin Compat Routes) ───────────────────────

  registerSessionSearchCompatRoutes(app, {
    pluginManager,
    sessionManager,
    allowLegacyFallback: false,
  });

  // ── Modular Plugin Studio (/api/v1/plugins/*) ────────────────────────

  const buildPluginPayload = () => ({
    plugins: pluginManager.listInstalled(),
    catalog: pluginManager.listCatalog(),
    slashCommands: pluginManager.listActiveSlashCommands(),
    mcpPresets: pluginManager.listActiveMcpPresets(),
    pluginsDir: paths.pluginsDir,
    emptyComposition: pluginManager.isEmptyComposition(),
  });

  app.get('/api/v1/plugins', async () => buildPluginPayload());
  app.get('/api/v1/plugins/services', async (request) => {
    const { contract } = request.query as { contract?: string };
    return { providers: pluginManager.listServiceProviders(typeof contract === 'string' && contract.trim() ? contract.trim() : undefined) };
  });
  registerServiceResolutionRoute(app, pluginManager);
  registerUiServices(app, pluginManager);
  app.get('/api/v1/plugins/composition', async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    const workspace = typeof workspaceId === 'string'
      ? ((await findWorkspaceWithProvider(pluginManager, workspaceId).catch(() => null))?.workspace ?? store.getWorkspace(workspaceId))
      : undefined;
    return {
      ...pluginManager.getComposition(),
      filePreviewProviders: pluginManager.listFilePreviewProviders(workspace?.id),
      filePreviewViewers: pluginManager.listFilePreviewViewers(workspace?.id),
    };
  });
  registerPluginMcp(app, pluginCapabilities, store, {
    getOrchestrator: () => sessionManager.getOrchestratorService(),
    isOrchestratorEnabled: () => pluginManager.isPluginEnabled(ORCHESTRATOR_PLUGIN_ID),
  });

  app.get('/api/v1/plugins/:id/permissions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId } = request.query as { workspaceId?: string };
    const wsExists = typeof workspaceId === 'string' && (
      workspaceId === GLOBAL_WORKSPACE_SCOPE ||
      Boolean(await findWorkspaceWithProvider(pluginManager, workspaceId).catch(() => null)) ||
      Boolean(store.getWorkspace(workspaceId))
    );
    if (!wsExists) {
      return reply.code(404).send({ error: '工作区不存在' });
    }
    return { permissions: pluginCapabilities.listPermissions(workspaceId as string, id) };
  });

  app.put('/api/v1/plugins/:id/permissions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SetPluginPermissionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '插件授权参数无效' });
    try { return { permissions: await pluginCapabilities.setPermission(id, parsed.data) }; }
    catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.get('/api/v1/plugins/logs', async () => ({
    logs: pluginManager.getAllLogs(),
  }));

  app.delete('/api/v1/plugins/logs', async () => {
    pluginManager.clearLogs();
    return { ok: true };
  });

  app.get('/api/v1/plugins/:id/logs', async (request) => {
    const { id } = request.params as { id: string };
    return { logs: pluginManager.getLogs(id) };
  });

  app.delete('/api/v1/plugins/:id/logs', async (request) => {
    const { id } = request.params as { id: string };
    pluginManager.clearLogs(id);
    return { ok: true };
  });

  app.post('/api/v1/plugins/dev/preview', async (request, reply) => {
    const parsed = LinkDevPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请提供有效的本地插件源码目录', code: 'E_INVALID_INPUT' });
    try {
      return pluginManager.previewDevPlugin(parsed.data.dirPath);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.post('/api/v1/plugins/dev/link', async (request, reply) => {
    const parsed = LinkDevPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请提供有效的本地插件源码目录', code: 'E_INVALID_INPUT' });
    }
    try {
      await pluginManager.linkDevPlugin(parsed.data.dirPath, parsed.data.trustedId);
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    } finally {
      wsGateway.notifyPluginsChanged();
    }
  });

  app.post('/api/v1/plugins/dev/:id/reload', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await pluginManager.reloadDevPlugin(id);
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    } finally {
      wsGateway.notifyPluginsChanged();
    }
  });

  app.delete('/api/v1/plugins/dev/:id/trust', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await pluginManager.revokeDevTrust(id);
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    } finally {
      wsGateway.notifyPluginsChanged();
    }
  });

  app.delete('/api/v1/plugins/dev/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await pluginManager.unlinkDevPlugin(id);
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.post('/api/v1/plugins/scaffold', async (request, reply) => {
    const parsed = ScaffoldPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? '插件脚手架参数无效',
        code: 'E_INVALID_INPUT',
      });
    }
    try {
      const result = await pluginManager.scaffoldPlugin(parsed.data);
      return reply.code(201).send({
        dirPath: result.dirPath,
        files: result.files,
        ...(await updatedPlugins()),
      });
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      return reply.code(code === 'E_CONFLICT' ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });

  app.get('/api/v1/plugins/registry', async () => ({
    registry: pluginManager.registryService.getState(),
    catalog: pluginManager.listCatalog(),
  }));

  app.post('/api/v1/plugins/registry/refresh', async () => {
    const { state } = await pluginManager.registryService.refresh();
    return { registry: state, ...buildPluginPayload() };
  });

  app.put('/api/v1/plugins/registry/config', async (request, reply) => {
    const parsed = UpdatePluginRegistryConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '远程插件索引配置无效', code: 'E_INVALID_INPUT' });
    }
    try {
      pluginManager.registryService.updateConfig(parsed.data);
      const { state } = await pluginManager.registryService.refresh();
      return { registry: state, ...buildPluginPayload() };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.post('/api/v1/plugins/registry/publishers', async (request, reply) => {
    const parsed = AddTrustedPublisherRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '发布者公钥参数无效', code: 'E_INVALID_INPUT' });
    }
    try {
      const state = pluginManager.registryService.addTrustedPublisher(parsed.data);
      return reply.code(201).send({ registry: state, ...buildPluginPayload() });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.delete('/api/v1/plugins/registry/publishers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const state = pluginManager.registryService.removeTrustedPublisher(id);
    return { registry: state, ...buildPluginPayload() };
  });

  app.get('/api/v1/plugins/:id/ui-doc', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { path: uiPath } = request.query as { path?: string };
    if (typeof uiPath !== 'string' || !uiPath.trim()) {
      return reply.code(400).send({ error: '缺少 UI 入口路径 path', code: 'E_INVALID_INPUT' });
    }
    const pkg = pluginManager.getPluginPackageRoot(id);
    if (!pkg) {
      return reply.code(404).send({ error: '插件不存在或未启用', code: 'E_SERVICE_UNAVAILABLE' });
    }
    try {
      const doc = buildSandboxedPluginHtml(pkg.packageRoot, uiPath);
      return {
        pluginId: id,
        digest: pkg.digest ?? null,
        runId: pkg.runId ?? pkg.digest ?? 'declarative',
        path: doc.normalizedPath,
        csp: doc.csp,
        html: doc.html,
      };
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      const status = code === 'E_PERMISSION_DENIED' ? 403 : code === 'E_LIMIT_EXCEEDED' ? 413 : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });

  app.get('/api/v1/plugins/:id/ui/*', async (request, reply) => {
    const { id, '*': wildcardPath } = request.params as { id: string; '*': string };
    const pkg = pluginManager.getPluginPackageRoot(id);
    if (!pkg) {
      return reply.code(404).send({ error: '插件不存在或未启用', code: 'E_SERVICE_UNAVAILABLE' });
    }
    try {
      const asset = resolvePluginUiAsset(pkg.packageRoot, wildcardPath);
      reply.header('Content-Type', asset.contentType);
      reply.header('Content-Security-Policy', `${SANDBOX_IFRAME_CSP}; sandbox allow-scripts`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'no-store');
      return reply.send(asset.buffer);
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      const status = code === 'E_PERMISSION_DENIED' ? 403 : code === 'E_LIMIT_EXCEEDED' ? 413 : 404;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });

  app.post('/api/v1/plugins/:id/browser-authorize', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { runId } = (request.body ?? {}) as { runId?: unknown };
    if (typeof runId !== 'string') {
      return reply.code(409).send({ error: '插件实例已停止或已更新', code: 'E_STALE_RUN' });
    }
    const authResult = authorizeLegacyPluginBrowserView(pluginManager, id, runId);
    if (!authResult.ok) {
      return reply.code(authResult.status).send({ error: authResult.error, code: authResult.code });
    }
    return { ok: true };
  });

  app.post('/api/v1/plugin-instances/:instanceId/view-authorize', async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    const { runId, permission } = (request.body ?? {}) as { runId?: unknown; permission?: unknown };
    if (typeof runId !== 'string') {
      return reply.code(409).send({ error: '插件实例已停止或已更新', code: 'E_STALE_RUN' });
    }
    const perm = typeof permission === 'string' && permission.trim() ? permission.trim() : 'browser:preview';
    const authResult = pluginManager.authorizeInstanceView(instanceId, runId, perm);
    if (!authResult.ok) {
      return reply.code(authResult.status).send({ error: authResult.error, code: authResult.code });
    }
    return { ok: true };
  });

  app.all('/api/v1/plugin-instances/:instanceId/routes/*', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: '插件本地路由仅允许本机访问', code: 'E_PERMISSION_DENIED' });
    }
    const { instanceId, '*': wildcardPath } = request.params as { instanceId: string; '*': string };
    try {
      const routePath = `/${(wildcardPath ?? '').replace(/^\/+/, '')}`;
      const query: Record<string, string> = {};
      if (request.query && typeof request.query === 'object') {
        for (const [k, v] of Object.entries(request.query as Record<string, unknown>)) {
          if (typeof v === 'string') query[k] = v;
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const res = await pluginManager.dispatchPluginRoute(instanceId, {
        method: request.method,
        path: routePath,
        query,
        headers,
        body: request.body,
      });
      if (res?.headers) {
        for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
      }
      return reply.code(res?.status ?? 200).send(res?.body ?? { ok: true });
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INTERNAL';
      const status =
        code === 'E_PERMISSION_DENIED'
          ? 403
          : code === 'E_PLUGIN_DISABLED' || code === 'E_SERVICE_UNAVAILABLE' || code === 'E_STALE_RUN'
            ? 503
            : code === 'E_TIMEOUT'
              ? 504
              : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : String(error), code });
    }
  });

  app.post('/api/v1/plugins/:id/ui-message', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PluginUiMessageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '插件 UI 消息参数无效', code: 'E_INVALID_INPUT' });
    }
    if (!pluginManager.isolated) {
      return reply.code(400).send({ error: '当前宿主未启用隔离插件运行时', code: 'E_NOT_SUPPORTED' });
    }
    try {
      const result = await pluginManager.isolated.sendSlotMessage(
        id,
        parsed.data.slotId,
        parsed.data.runId,
        parsed.data.payload,
        parsed.data.sessionId ?? null,
        parsed.data.slot,
      );
      return { result };
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      const status = code === 'E_STALE_RUN' ? 409 : code === 'E_TIMEOUT' ? 504 : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });

  app.post('/api/v1/plugins/actions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const parsed = RunPluginActionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '插件动作参数无效' });
    try { return await sessionManager.runPluginAction(sessionId, parsed.data); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  const updatedPlugins = async () => {
    const harnesses = pluginManager.takeRegistryChanged() ? await registry.probeAll(false) : undefined;
    wsGateway.notifyPluginsChanged();
    return { ...buildPluginPayload(), ...(harnesses ? { harnesses } : {}) };
  };

  app.put('/api/v1/plugins/composition/file-preview', async (request, reply) => {
    const { pluginId, workspaceId } = (request.body ?? {}) as { pluginId?: unknown; workspaceId?: unknown };
    const wsExists = typeof workspaceId === 'string' && (
      Boolean(await findWorkspaceWithProvider(pluginManager, workspaceId).catch(() => null)) ||
      Boolean(store.getWorkspace(workspaceId))
    );
    if (pluginId !== null && (typeof pluginId !== 'string' || !wsExists)) {
      return reply.code(400).send({ error: '请选择文件预览提供方和工作区' });
    }
    try {
      await pluginManager.setFilePreviewProvider(pluginId, typeof workspaceId === 'string' ? workspaceId : undefined);
      wsGateway.notifyPluginsChanged();
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/v1/plugins/composition/bindings', async (request, reply) => {
    const { contract, instanceId } = (request.body ?? {}) as { contract?: unknown; instanceId?: unknown };
    if (typeof contract !== 'string' || !contract.trim() || (instanceId !== null && typeof instanceId !== 'string')) {
      return reply.code(400).send({ error: '请提供有效的契约名与实例 ID' });
    }
    try {
      await pluginManager.setCompositionBinding(contract.trim(), instanceId as string | null);
      wsGateway.notifyPluginsChanged();
      return { ok: true, composition: pluginManager.getComposition() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/v1/plugins/composition/instances', async (request, reply) => {
    const body = (request.body ?? {}) as {
      id?: unknown;
      name?: unknown;
      disabled?: unknown;
      config?: unknown;
      bindings?: unknown;
    };
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return reply.code(400).send({ error: '请提供有效的实例 ID' });
    }
    try {
      await pluginManager.upsertCompositionInstance({
        id: body.id.trim(),
        ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
        ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
        ...(body.config && typeof body.config === 'object' && !Array.isArray(body.config)
          ? { config: body.config as Record<string, unknown> }
          : {}),
        ...(body.bindings && typeof body.bindings === 'object' && !Array.isArray(body.bindings)
          ? { bindings: body.bindings as Record<string, string> }
          : {}),
      });
      wsGateway.notifyPluginsChanged();
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/v1/plugins/composition/instances/:instanceId', async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    try {
      await pluginManager.removeCompositionInstance(instanceId);
      wsGateway.notifyPluginsChanged();
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/v1/plugins/composition/restore', async (request, reply) => {
    const source = (request.body as { source?: unknown } | null)?.source;
    if (source !== 'previous' && source !== 'builtin' && source !== 'empty') {
      return reply.code(400).send({ error: '请选择要恢复的组合配置' });
    }
    try {
      await pluginManager.restoreComposition(source);
      wsGateway.notifyPluginsChanged();
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/v1/workspaces/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const wsFound = await findWorkspaceWithProvider(pluginManager, id);
      if (!wsFound) return reply.code(404).send({ error: 'Workspace not found' });
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    return {
      workspaceId: id,
      bindings: store.listCapabilityBindings('workspace', id),
      resolved: {
        'session.data.v1': pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionData, { workspaceId: id, allowSingleCandidate: true }),
        'session.runtime.v1': pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionRuntime, { workspaceId: id, allowSingleCandidate: true }),
        'browser.v1': pluginManager.resolveCapabilityBinding('browser.v1', { workspaceId: id }),
        'filePreview.v1': pluginManager.resolveCapabilityBinding('filePreview.v1', { workspaceId: id }),
        'approval.policy.v1': pluginManager.resolveCapabilityBinding('approval.policy.v1', { workspaceId: id }),
        'history.import.v1': pluginManager.resolveCapabilityBinding('history.import.v1', { workspaceId: id }),
        'session.search.v1': pluginManager.resolveCapabilityBinding('session.search.v1', { workspaceId: id }),
        'git.workspace.v1': pluginManager.resolveCapabilityBinding('git.workspace.v1', { workspaceId: id }),
        'git.checkpoint.v1': pluginManager.resolveCapabilityBinding('git.checkpoint.v1', { workspaceId: id }),
        'terminal.workspace.v1': pluginManager.resolveCapabilityBinding('terminal.workspace.v1', { workspaceId: id }),
        'terminal.runner.v1': pluginManager.resolveCapabilityBinding('terminal.runner.v1', { workspaceId: id }),
        'workspace.files.v1': pluginManager.resolveCapabilityBinding('workspace.files.v1', { workspaceId: id }),
        'session.attachments.v1': pluginManager.resolveCapabilityBinding('session.attachments.v1', { workspaceId: id }),
        'workspace.rules.v1': pluginManager.resolveCapabilityBinding('workspace.rules.v1', { workspaceId: id }),
        'harness.driver.codex.v1': pluginManager.resolveServiceSelection('harness.driver.codex.v1', { workspaceId: id, allowSingleCandidate: true }),
        'harness.driver.claude.v1': pluginManager.resolveServiceSelection('harness.driver.claude.v1', { workspaceId: id, allowSingleCandidate: true }),
        'harness.driver.acp.v1': pluginManager.resolveServiceSelection('harness.driver.acp.v1', { workspaceId: id, allowSingleCandidate: true }),
        'harness.driver.agy.v1': pluginManager.resolveServiceSelection('harness.driver.agy.v1', { workspaceId: id, allowSingleCandidate: true }),
        'agy.runtime.v1': pluginManager.resolveServiceSelection(AGY_RUNTIME_CONTRACT, { workspaceId: id, allowSingleCandidate: true }),
        'agy.accounts.v1': pluginManager.resolveServiceSelection(AGY_ACCOUNTS_CONTRACT, { workspaceId: id, allowSingleCandidate: true }),
        'agy.workbench.v1': pluginManager.resolveServiceSelection(AGY_WORKBENCH_CONTRACT, { workspaceId: id, allowSingleCandidate: true }),
        'session.handoff.v1': pluginManager.resolveServiceSelection('session.handoff.v1', { workspaceId: id, allowSingleCandidate: true }),
        'session.compression.v1': pluginManager.resolveServiceSelection('session.compression.v1', { workspaceId: id, allowSingleCandidate: true }),
        'session.collaboration.v1': pluginManager.resolveServiceSelection('session.collaboration.v1', { workspaceId: id, allowSingleCandidate: true }),
        'session.orchestration.v1': pluginManager.resolveServiceSelection('session.orchestration.v1', { workspaceId: id, allowSingleCandidate: true }),
      },
    };
  });

  app.put('/api/v1/workspaces/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const wsFound = await findWorkspaceWithProvider(pluginManager, id);
      if (!wsFound) return reply.code(404).send({ error: 'Workspace not found' });
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    const { contract, instanceId } = (request.body ?? {}) as { contract?: unknown; instanceId?: unknown };
    if (typeof contract !== 'string' || !contract.trim() || (instanceId !== null && typeof instanceId !== 'string')) {
      return reply.code(400).send({ error: '请提供有效的契约名与实例 ID' });
    }
    try {
      await pluginManager.setWorkspaceBinding(id, contract.trim(), instanceId as string | null);
      return {
        workspaceId: id,
        bindings: store.listCapabilityBindings('workspace', id),
        resolved: pluginManager.resolveCapabilityBinding(contract.trim(), { workspaceId: id }),
      };
    } catch (error) {
      return sendPluginError(reply, error, 400);
    }
  });

  app.get('/api/v1/sessions/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return {
      sessionId: id,
      bindings: store.listCapabilityBindings('session', id),
      resolved: {
        'session.data.v1': pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionData, { sessionId: id, workspaceId: session.workspaceId, allowSingleCandidate: true }),
        'session.runtime.v1': pluginManager.resolveServiceSelection(PEER_CONTRACTS.sessionRuntime, { sessionId: id, workspaceId: session.workspaceId, allowSingleCandidate: true }),
        'browser.v1': pluginManager.resolveCapabilityBinding('browser.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'filePreview.v1': pluginManager.resolveCapabilityBinding('filePreview.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'approval.policy.v1': pluginManager.resolveCapabilityBinding('approval.policy.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'git.workspace.v1': pluginManager.resolveCapabilityBinding('git.workspace.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'git.checkpoint.v1': pluginManager.resolveCapabilityBinding('git.checkpoint.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'terminal.workspace.v1': pluginManager.resolveCapabilityBinding('terminal.workspace.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'terminal.runner.v1': pluginManager.resolveCapabilityBinding('terminal.runner.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'workspace.files.v1': pluginManager.resolveCapabilityBinding('workspace.files.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'session.attachments.v1': pluginManager.resolveCapabilityBinding('session.attachments.v1', { sessionId: id, workspaceId: session.workspaceId }),
        'workspace.rules.v1': pluginManager.resolveCapabilityBinding('workspace.rules.v1', { sessionId: id, workspaceId: session.workspaceId }),
      },
    };
  });

  app.put('/api/v1/sessions/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const { contract, instanceId } = (request.body ?? {}) as { contract?: unknown; instanceId?: unknown };
    if (typeof contract !== 'string' || !contract.trim() || (instanceId !== null && typeof instanceId !== 'string')) {
      return reply.code(400).send({ error: '请提供有效的契约名与实例 ID' });
    }
    try {
      await pluginManager.setSessionBinding(id, contract.trim(), instanceId as string | null);
      return {
        sessionId: id,
        bindings: store.listCapabilityBindings('session', id),
        resolved: pluginManager.resolveCapabilityBinding(contract.trim(), { sessionId: id, workspaceId: session.workspaceId }),
      };
    } catch (error) {
      return sendPluginError(reply, error, 400);
    }
  });

  app.post('/api/v1/plugins/preview', async (request, reply) => {
    const parsed = InstallPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '插件清单或目录无效' });
    try {
      return await pluginManager.previewInstallAsync(parsed.data);
    } catch (error) {
      const code = error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT';
      return reply.code(error instanceof PluginRevisionConflictError ? 409 : code === 'E_PERMISSION_DENIED' ? 403 : 400).send({
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  });

  app.post('/api/v1/plugins/generate', async (request, reply) => {
    const parsed = GeneratePluginDraftRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请输入需求并选择工作区与 Harness' });
    const workspace = store.getWorkspace(parsed.data.workspaceId);
    if (!workspace) return reply.code(404).send({ error: '工作区不存在' });
    const abort = new AbortController();
    const disconnect = () => abort.abort(new Error('插件生成请求已取消'));
    reply.raw.once('close', disconnect);
    try {
      const editing = parsed.data.editing;
      const base = editing && pluginManager.getAuthoringBase(editing.id, editing.digest);
      const manifest = await pluginAuthoring.generate(parsed.data, workspace.rootPath, abort.signal, base);
      if (editing) pluginManager.getAuthoringBase(editing.id, editing.digest);
      pluginManager.validateManifest(manifest);
      return { manifest };
    } catch (error) {
      return reply.code(error instanceof PluginRevisionConflictError ? 409 : 400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      reply.raw.off('close', disconnect);
    }
  });

  app.post('/api/v1/plugins/builder-v2/generate', async (request, reply) => {
    const parsed = BuilderV2GenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? '请提供完整的插件需求、工作区与 Harness',
        code: 'E_INVALID_INPUT',
      });
    }
    const workspace = store.getWorkspace(parsed.data.workspaceId);
    if (!workspace) return reply.code(404).send({ error: '工作区不存在' });
    const abort = new AbortController();
    const disconnect = () => abort.abort(new Error('AI Plugin Builder v2 请求已取消'));
    reply.raw.once('close', disconnect);
    try {
      const result = await pluginBuilderV2.generate(parsed.data, workspace.rootPath, abort.signal);
      return result;
    } catch (error) {
      const status =
        error instanceof PluginRevisionConflictError
          ? 409
          : error instanceof PluginApiError && error.code === 'E_PERMISSION_DENIED'
            ? 403
            : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    } finally {
      reply.raw.off('close', disconnect);
    }
  });

  app.post('/api/v1/plugins/builder-v2/audit', async (request, reply) => {
    const parsed = BuilderV2AuditRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '无效的代码包审计参数', code: 'E_INVALID_INPUT' });
    }
    const audit = auditPluginPackage(parsed.data.files, parsed.data.manifest);
    return { audit };
  });

  app.post('/api/v1/plugins/builder-v2/install', async (request, reply) => {
    const parsed = BuilderV2InstallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? '无效的 Builder v2 安装参数',
        code: 'E_INVALID_INPUT',
      });
    }
    try {
      const res = await pluginBuilderV2.installDraft(parsed.data);
      return reply.code(201).send({
        ...(await updatedPlugins()),
        installedId: res.installedId,
        installMode: res.installMode,
        dirPath: res.dirPath,
      });
    } catch (error) {
      const status =
        error instanceof PluginRevisionConflictError
          ? 409
          : error instanceof PluginApiError && error.code === 'E_PERMISSION_DENIED'
            ? 403
            : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.post('/api/v1/plugins/preview/replay', async (request, reply) => {
    const parsed = ReplayPluginDraftRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '仅支持符合 SDK 的声明式面板草稿' });
    const { manifest, sessionId, panelId, query } = parsed.data;
    const session = sessionManager.getSession(sessionId);
    if (!session) return reply.code(404).send({ error: '历史会话不存在' });
    try {
      pluginManager.validateManifest(manifest);
      const panel = manifest.contributes.dataPanels?.find(({ id }) => id === panelId);
      const projection = manifest.contributes.projections?.find(({ id }) => id === panel?.projection);
      if (!panel || !projection) return reply.code(404).send({ error: '找不到草稿面板' });
      return readPluginPanel(store, session, panel, projection, query);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/v1/plugins/preview/program', async (request, reply) => {
    const parsed = PreviewPluginProgramRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '处理程序预览参数无效' });
    const { manifest, programId, text } = parsed.data;
    try {
      pluginManager.validateManifest(manifest);
      const program = manifest.contributes.programs?.find(({ id }) => id === programId);
      if (!program) return reply.code(404).send({ error: '找不到草稿处理程序' });
      return { output: runPluginProgram(program, text) };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post('/api/v1/plugins/:id/rollback', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await pluginManager.rollbackPlugin(id);
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      wsGateway.notifyPluginsChanged();
    }
  });

  app.post('/api/v1/plugins/install', async (request, reply) => {
    const parsed = InstallPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid plugin install payload' });
    }
    try {
      await pluginManager.installPlugin(parsed.data);
      return reply.code(201).send(await updatedPlugins());
    } catch (err) {
      return reply.code(err instanceof PluginRevisionConflictError ? 409 : 400).send({
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof PluginApiError ? err.code : 'E_INVALID_INPUT',
      });
    }
  });

  app.patch('/api/v1/plugins/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = TogglePluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid toggle payload' });
    }
    try {
      await pluginManager.togglePlugin(id, parsed.data.enabled);
      return await updatedPlugins();
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/plugins/reload', async (request, reply) => {
    try {
      await pluginManager.reloadAll();
      return await updatedPlugins();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/v1/plugins/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await pluginManager.uninstallPlugin(id);
      store.clearPluginPermissions(id);
      return await updatedPlugins();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  registerHarnessIntegrationCompat(app, pluginManager, registry, store);

  // ── Workspaces ───────────────────────────────────────────────────────

  app.get('/api/v1/workspaces', async (_request, reply) => {
    try {
      return { workspaces: await sessionManager.listWorkspacesAsync() };
    } catch (err) {
      return sendPluginError(reply, err, 500);
    }
  });

  app.post('/api/v1/workspaces', async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid workspace' });
    }
    try {
      const workspace = await sessionManager.addWorkspace(
        parsed.data.rootPath,
        parsed.data.name,
        parsed.data.dataInstanceId,
      );
      return reply.code(201).send({ workspace });
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.delete('/api/v1/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const deleted = await sessionManager.deleteWorkspace(id);
      if (!deleted) return reply.code(404).send({ error: 'Workspace not found' });
      return { deleted: true };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  registerSessionAssistanceCompatRoutes(app, pluginManager, store);

  app.get('/api/v1/sessions', async (request, reply) => {
    const q = request.query as {
      workspaceId?: string;
      harnessId?: string;
      includeArchived?: string;
    };
    try {
      const sessions = await sessionManager.listSessionsAsync({
        workspaceId: q.workspaceId,
        harnessId: q.harnessId,
        includeArchived: q.includeArchived === '1' || q.includeArchived === 'true',
      });
      return { sessions };
    } catch (err) {
      return sendPluginError(reply, err, 500);
    }
  });

  app.post('/api/v1/sessions', async (request, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid session payload' });
    }
    try {
      const session = await sessionManager.createSession(parsed.data);
      return reply.code(201).send({ session });
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const pendingApprovals = sessionManager.listPendingApprovals(id);
    const taskState = await readSessionLedger(pluginManager, store, id);
    return { session, pendingApprovals, taskState };
  });

  app.patch('/api/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid update' });
    }
    try {
      const session = await sessionManager.updateSession(id, parsed.data);
      return { session };
    } catch (err) {
      return sendPluginError(reply, err, 404);
    }
  });

  app.delete('/api/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const deleted = await sessionManager.deleteSession(id);
      if (!deleted) return reply.code(404).send({ error: 'Session not found' });
      return { deleted: true };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.get('/api/v1/sessions/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { afterSeq?: string };
    const parsedSeq = Number(q.afterSeq ?? 0);
    if (!Number.isSafeInteger(parsedSeq) || parsedSeq < 0) return reply.code(400).send({ error: 'Invalid event cursor' });
    const afterSeq = parsedSeq;
    try {
      const page = await sessionManager.getSessionEventsPageAsync(id, afterSeq);
      return {
        events: page.events,
        lastSeq: page.lastSeq,
        hasMore: page.hasMore,
        ...(page.stream ? { stream: page.stream } : {}),
      };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.get('/api/v1/sessions/:id/plugin-panels/:pluginId/:panelId', async (request, reply) => {
    const { id, pluginId, panelId } = request.params as { id: string; pluginId: string; panelId: string };
    const session = await sessionManager.getSessionAsync(id);
    const contribution = pluginManager.getDataPanel(pluginId, panelId);
    if (!session || !contribution) return reply.code(404).send({ error: '会话或插件面板不存在' });
    const query = PluginPanelQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '面板筛选条件无效' });
    return readPluginPanel(store, session, contribution.panel, contribution.projection, query.data);
  });

  app.get('/api/v1/sessions/:id/commands', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await sessionManager.getSessionAsync(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const pluginCommands = pluginManager.isolated?.listCommands().map(({ pluginId, pluginName, command, description, argumentHint }) =>
      ({ pluginId, pluginName, command, description, argumentHint })) ?? [];
    return { commands: sessionManager.getHarnessCommands(session), pluginActions: sessionManager.listPluginActions(session), pluginCommands,
      modelTools: sessionManager.getModelPluginTools(session) };
  });

  app.post('/api/v1/sessions/:id/commands', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Native CLI commands are local only' });
    }
    const { id } = request.params as { id: string };
    const parsed = RunHarnessCommandRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid CLI command input' });
    try {
      return await sessionManager.runHarnessCommand(id, parsed.data,
        mintAgyDispatchProvenance('human_direct', 'desktop', 'POST /api/v1/sessions/:id/commands'));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/sessions/:id/turns', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SendTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid turn input' });
    }
    try {
      const principal = (request as unknown as { principal?: { kind: 'local' | 'device' } }).principal;
      const actor = principal?.kind === 'device' ? 'mobile' : 'desktop';
      const result = await sessionManager.sendTurn(id, parsed.data.text, parsed.data.attachments, {
        requestId: parsed.data.requestId,
        harnessId: parsed.data.harnessId,
        model: parsed.data.model,
        turnOptions: parsed.data.turnOptions,
        omitHandoff: parsed.data.omitHandoff,
        literalText: parsed.data.literalText,
        mode: parsed.data.mode,
        terminalContexts: parsed.data.terminalContexts,
        dispatchProvenance: mintAgyDispatchProvenance('human_direct', actor, 'POST /api/v1/sessions/:id/turns'),
      });
      return reply.code(202).send(result);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/turn-suggestion', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) return reply.code(403).send({ error: '插件建议仅在本机预览' });
    const { id } = request.params as { id: string };
    const parsed = SendTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '消息草稿无效' });
    try {
      return { suggestion: await sessionManager.previewTurnSuggestionAsync(id, parsed.data.text, parsed.data.attachments) };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/switch-harness', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SwitchHarnessRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid switch payload' });
    }
    try {
      return await sessionManager.switchHarness(id, parsed.data);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.get('/api/v1/sessions/:id/context-preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { targetHarnessId?: string; syncMode?: ContextSyncMode };
    try {
      const preview = await sessionManager.getContextPreview(id, q.targetHarnessId, q.syncMode);
      return { preview };
    } catch (err) {
      return sendPluginError(reply, err, 404);
    }
  });

  app.post('/api/v1/sessions/:id/failover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = FailoverRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid failover payload' });
    }
    try {
      const principal = (request as unknown as { principal?: { kind: 'local' | 'device' } }).principal;
      const provenance = principal?.kind === 'local' && isLoopbackAddress(request.socket.remoteAddress)
        ? mintAgyDispatchProvenance('manual_user_switch', 'desktop', 'POST /api/v1/sessions/:id/failover')
        : undefined;
      return await sessionManager.failoverSession(id, parsed.data, provenance);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/sessions/:id/interrupt', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    try {
      await sessionManager.interruptSession(id);
      return { interrupted: true };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  registerFilesAttachmentsRulesCompatRoutes(app, {
    store,
    pluginManager,
    sessionManager,
    attachmentsRoot: paths.attachmentsDir,
  });

  app.post('/api/v1/sessions/:id/browser/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await sessionManager.getSessionAsync(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const { url, instanceId: explicitInstanceId } = (request.body ?? {}) as { url?: unknown; instanceId?: unknown };
    if (typeof url !== 'string' || !url.trim()) {
      return reply.code(400).send({ error: '请提供要打开的网址' });
    }
    const availableBrowsers = pluginManager.listServiceProviders('browser.v1');
    const resolved = pluginManager.resolveCapabilityBinding('browser.v1', {
      sessionId: session.id,
      workspaceId: session.workspaceId,
    });
    const targetId = typeof explicitInstanceId === 'string' && explicitInstanceId.trim()
      ? explicitInstanceId.trim()
      : resolved.instanceId;
    if (!targetId) {
      return {
        ok: false,
        dependencyStatus: 'unavailable',
        instanceId: null,
        boundSource: resolved.source,
        dependencyMessage: '当前没有可用的浏览器插件实例',
        availableBrowsers,
      };
    }
    const service = pluginManager.host.getServiceByInstance<Record<string, (...args: unknown[]) => Promise<unknown>>>(
      targetId,
      'browser.v1',
    );
    if (!service || typeof service.open !== 'function' || !pluginManager.isInstanceEnabled(targetId)) {
      return {
        ok: false,
        dependencyStatus: 'unavailable',
        instanceId: targetId,
        boundSource: resolved.source,
        dependencyMessage: `浏览器实例 ${targetId} 当前已停用或未就绪`,
        availableBrowsers,
      };
    }
    try {
      const result = await service.open(url.trim(), session.id);
      const slots = pluginManager.isolated?.listSlots(targetId) ?? [];
      const pageSlot = slots.find((s) => s.slot === 'workspace.pages');
      return {
        ok: true,
        dependencyStatus: 'ready',
        instanceId: targetId,
        boundSource: resolved.source,
        pageKey: pageSlot ? `${targetId}:${pageSlot.id}` : null,
        result,
        availableBrowsers,
      };
    } catch (error) {
      return {
        ok: false,
        dependencyStatus: 'failed',
        instanceId: targetId,
        boundSource: resolved.source,
        dependencyMessage: error instanceof Error ? error.message : String(error),
        availableBrowsers,
      };
    }
  });

  registerTerminalCompatRoutes(app, {
    store,
    pluginManager,
    sessionManager,
    terminalSessionOwners,
  });

  app.post('/api/v1/sessions/:id/handoff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { targetHarnessId?: string; targetModel?: string | null };
    if (!body?.targetHarnessId) {
      return reply.code(400).send({ error: 'targetHarnessId is required' });
    }
    try {
      const res = await sessionManager.handoffSession(id, body.targetHarnessId, body.targetModel);
      return reply.code(201).send(res);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.get('/api/v1/sessions/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { format?: string; redact?: string };
    const format = q.format === 'json_bundle' ? 'json_bundle' : 'markdown';
    const redact = q.redact === '1' || q.redact === 'true';
    try {
      return sessionManager.exportSession(id, format, { redact });
    } catch (err) {
      return sendPluginError(reply, err, 404);
    }
  });

  app.post('/api/v1/sessions/:id/fork', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ForkSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid fork payload' });
    }
    try {
      const result = await sessionManager.forkSession(id, parsed.data);
      return reply.code(201).send(result);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/merge-back', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = MergeBackRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid merge-back payload' });
    }
    try {
      const result = sessionManager.mergeBackSession(id, parsed.data);
      return result;
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  // ── Multi-Harness Parallel Orchestrator (Scenario D) ─────────────────

  app.get('/api/v1/sessions/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      return sessionManager.getOrchestratorService(id).getBoard(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DelegateSubagentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid delegation payload' });
    }
    try {
      const subagent = await sessionManager.getOrchestratorService(id).delegateTask(id, parsed.data);
      return reply.code(201).send({ subagent });
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : 'E_DELEGATE_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SESSION_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.get('/api/v1/subagents/:subagentId', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    try {
      return sessionManager.getOrchestratorService().getSubagentResult(subagentId);
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : 'E_SUBAGENT_NOT_FOUND';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.post('/api/v1/subagents/:subagentId/send', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    const parsed = SendToSubagentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid subagent message' });
    }
    try {
      return await sessionManager.getOrchestratorService().sendToSubagent(subagentId, parsed.data.text);
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : 'E_SUBAGENT_SEND_FAILED';
      const status = code === 'E_SUBAGENT_NOT_FOUND' ? 404 : code === 'E_PLUGIN_DISABLED' || code === 'E_SUBAGENT_BUSY' ? 409 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  app.post('/api/v1/subagents/:subagentId/stop', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    const body = (request.body ?? {}) as { reason?: string };
    try {
      const subagent = await sessionManager.getOrchestratorService().stopSubagent(subagentId, body.reason);
      return { subagent };
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : 'E_SUBAGENT_STOP_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.post('/api/v1/subagents/:subagentId/dry-run-merge', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    const parsed = DryRunSubagentMergeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid dry-run merge request' });
    }
    try {
      return await sessionManager.getOrchestratorService().dryRunMergeSubagent(subagentId, parsed.data.baseBranch);
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : err instanceof GitOperationError ? err.code : 'E_MERGE_PRECHECK_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.post('/api/v1/subagents/:subagentId/merge-back', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    const parsed = MergeSubagentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid merge-back request' });
    }
    try {
      return await sessionManager.getOrchestratorService().mergeBackSubagent(subagentId, parsed.data);
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : err instanceof GitOperationError ? err.code : 'E_MERGE_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' || code === 'E_MERGE_CONFLICT' || code === 'E_SUBAGENT_ACTIVE' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
        ...(err instanceof OrchestratorError && err.conflictFiles ? { conflictFiles: err.conflictFiles } : {}),
      });
    }
  });

  app.delete('/api/v1/subagents/:subagentId/worktree', async (request, reply) => {
    const { subagentId } = request.params as { subagentId: string };
    const q = request.query as { force?: string; deleteBranch?: string };
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as {
      force?: boolean;
      deleteBranch?: boolean;
    };
    try {
      return await sessionManager.getOrchestratorService().cleanupSubagentWorktree(subagentId, {
        force: body.force ?? (q.force === '1' || q.force === 'true'),
        deleteBranch: body.deleteBranch ?? (q.deleteBranch === '1' || q.deleteBranch === 'true'),
      });
    } catch (err) {
      const code = err instanceof OrchestratorError ? err.code : err instanceof GitOperationError ? err.code : 'E_WORKTREE_REMOVE_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' || code === 'E_WORKTREE_BUSY' || code === 'E_SUBAGENT_ACTIVE' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  // ── AI Context Compression & Symbol Index ─────────────────────────────

  app.get('/api/v1/sessions/:id/compression', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      return await sessionManager.getContextCompressionService(id).getSessionStatus(id);
    } catch (err) {
      const code = err instanceof ContextCompressionError ? err.code : 'E_COMPRESSION_STATUS_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SESSION_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.post('/api/v1/sessions/:id/compression/compress', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (!pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID)) {
      return reply.code(409).send({
        error: '上下文压缩与符号索引插件当前未启用，请先在插件管理中启用。',
        code: 'E_PLUGIN_DISABLED',
      });
    }
    const parsed = ManualCompressRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid compression payload' });
    }
    try {
      const svc = sessionManager.getContextCompressionService(id);
      const fromSeq = parsed.data.fromSeq ?? 1;
      const toSeq = parsed.data.toSeq ?? session.lastSeq;
      const budgetChars = parsed.data.budgetChars ?? 6_000;
      const result = await svc.compressRange(id, fromSeq, toSeq, budgetChars, {
        forceRecompute: parsed.data.forceRecompute,
      });
      const status = await svc.getSessionStatus(id);
      return { result, status };
    } catch (err) {
      const code = err instanceof ContextCompressionError ? err.code : 'E_COMPRESS_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SESSION_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.delete('/api/v1/sessions/:id/compression/cache', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      const svc = sessionManager.getContextCompressionService(id);
      const cleared = svc.clearSessionCache(id);
      const status = await svc.getSessionStatus(id);
      return { ...cleared, status };
    } catch (err) {
      const code = err instanceof ContextCompressionError ? err.code : 'E_CACHE_CLEAR_FAILED';
      const status = code === 'E_PLUGIN_DISABLED' ? 409 : code === 'E_SESSION_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.get('/api/v1/compression/config', async (_request, reply) => {
    try {
      const svc = sessionManager.getContextCompressionService();
      return {
        enabled: pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID),
        config: svc.getConfig(),
      };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.put('/api/v1/compression/config', async (request, reply) => {
    const parsed = UpdateCompressionConfigRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid compression config' });
    }
    try {
      const svc = sessionManager.getContextCompressionService();
      const config = svc.updateConfig(parsed.data);
      return {
        enabled: pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID),
        config,
      };
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/sessions/:id/side-chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      return { messages: sessionManager.getSideChat(id) };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/side-chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SideChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid side chat prompt' });
    }
    try {
      return await sessionManager.sendSideChat(id, parsed.data);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.delete('/api/v1/sessions/:id/side-chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      sessionManager.clearSideChat(id);
      return { ok: true };
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  app.post('/api/v1/sessions/:id/side-chat/promote', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SideChatPromoteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid side chat promote payload' });
    }
    try {
      const result = await sessionManager.promoteSideChatToFork(id, parsed.data);
      return reply.code(201).send(result);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
  });

  registerGitWorktreesCompatRoutes(app, { store, pluginManager, sessionManager });
  registerCheckpointsCompatRoutes(app, { store, registry, pluginManager, sessionManager });

  // ── Approvals, Questions, Secret Requests & Risk Rules ───────────────

  app.get('/api/v1/approvals', async (request) => {
    const q = request.query as { sessionId?: string; includeHistory?: string };
    if (q.includeHistory === '1' || q.includeHistory === 'true') {
      return { approvals: store.listApprovals({ sessionId: q.sessionId, limit: 100 }) };
    }
    return { approvals: sessionManager.listPendingApprovals(q.sessionId) };
  });

  app.post('/api/v1/approvals/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ResolveApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid decision' });
    }
    const principal = (request as unknown as { principal?: { kind: 'local' | 'device' } }).principal;
    const resolvedBy: 'desktop' | 'mobile' = principal?.kind === 'device' ? 'mobile' : parsed.data.resolvedBy;
    try {
      const outcome = await sessionManager.resolveRuntimeRequest(id, parsed.data, resolvedBy);
      if (outcome.conflict) {
        return reply.code(409).send({
          error: 'Already Resolved',
          code: 'E_ALREADY_RESOLVED',
          resolvedBy: outcome.approval.resolvedBy ?? null,
          approval: outcome.approval,
        });
      }
      return { approval: outcome.approval };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('not found') ? 404 : 400;
      return reply.code(status).send({ error: msg });
    }
  });

  app.get('/api/v1/approval-center/rules', async () => {
    return { rules: sessionManager.getApprovalCenter().listRules() };
  });

  app.post('/api/v1/approval-center/rules', async (request, reply) => {
    const parsed = CreateCustomRiskRuleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid risk rule payload' });
    }
    try {
      const rule = sessionManager.getApprovalCenter().addCustomRule(parsed.data);
      return reply.code(201).send({ rule, rules: sessionManager.getApprovalCenter().listRules() });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/v1/approval-center/rules/:ruleId', async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    try {
      const deleted = sessionManager.getApprovalCenter().deleteCustomRule(ruleId);
      if (!deleted) return reply.code(404).send({ error: 'Rule not found' });
      return { deleted: true, rules: sessionManager.getApprovalCenter().listRules() };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Remote Access & Mobile Pairing (HM-Remote v1) ────────────────────

  const buildRemoteStatus = (): RemoteAccessStatus => {
    const { lanAddresses, tailscaleAddresses } = discoverNetworkAddresses();
    const active = auth.getActivePairing();
    const allHosts = [...tailscaleAddresses, ...lanAddresses].map((ip) => `${ip}:${boundPort}`);
    return {
      protocolVersion: PROTOCOL_VERSION,
      desktopId: config.desktopId,
      desktopName: config.desktopName,
      port: boundPort,
      lanEnabled: config.lanEnabled,
      lanAddresses,
      tailscaleAddresses,
      activePairing: active
        ? {
            code: active.code,
            expiresAt: active.expiresAt,
            qrUri: `harnessmate://pair?hosts=${encodeURIComponent(allHosts.join(','))}&code=${active.code}&fp=${encodeURIComponent(config.desktopId)}&name=${encodeURIComponent(config.desktopName)}`,
          }
        : null,
      pairedDevices: auth.listDevices(),
    };
  };

  app.get('/api/v1/remote/status', async () => buildRemoteStatus());

  app.patch('/api/v1/remote/config', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Remote config can only be changed locally from Desktop' });
    }
    const parsed = UpdateRemoteConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid remote config' });
    }
    config.lanEnabled = parsed.data.lanEnabled;
    saveConfig(paths.configPath, config);
    return {
      ...buildRemoteStatus(),
      restartRequired: (boundHost === '127.0.0.1') === config.lanEnabled,
    };
  });

  app.post('/api/v1/pair/create', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Pairing codes can only be generated from Desktop' });
    }
    auth.generatePairingCode();
    return buildRemoteStatus();
  });

  app.post('/api/v1/pair/exchange', async (request, reply) => {
    const parsed = PairExchangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid pairing payload' });
    }
    try {
      const { device, token } = auth.exchangePairingCode(
        parsed.data.pairingCode,
        parsed.data.deviceName,
        parsed.data.platform,
      );
      return reply.code(201).send({
        protocolVersion: PROTOCOL_VERSION,
        desktopId: config.desktopId,
        desktopName: config.desktopName,
        device,
        token,
      });
    } catch (err) {
      return reply.code(401).send({ error: err instanceof Error ? err.message : 'Pairing failed' });
    }
  });

  app.delete('/api/v1/remote/devices/:id', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Devices can only be revoked locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const revoked = auth.revokeDevice(id);
    if (!revoked) return reply.code(404).send({ error: 'Device not found' });
    return { revoked: true };
  });

  if (paths.webDistDir && fs.existsSync(paths.webDistDir)) {
    const distRoot = paths.webDistDir;
    void app.register(fastifyStatic, {
      root: distRoot,
      prefix: '/',
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html', distRoot);
    });
  }

  app.server.on('upgrade', (req, socket, head) => {
    if (nativeWsGateway.handleUpgrade(req, socket, head)) {
      return;
    }
    wsGateway.handleUpgrade(req, socket, head);
  });

  app.get('/api/v1/sessions/:id/items', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { afterSeq?: string; turnId?: string; limit?: string };
    const rawItems = await sessionManager.getSessionTurnItemsAsync(id, {
      afterSeq: q.afterSeq !== undefined ? Number(q.afterSeq) : undefined,
      turnId: q.turnId || undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    const items = rawItems.map((item) =>
      item.outputOmitted && item.textBody.length > 16_384
        ? { ...item, textBody: item.textBody.slice(0, 16_384) }
        : item,
    );
    return { items };
  });

  app.get('/api/v1/sessions/:id/items/:itemId', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { textOffset?: string; maxChars?: string };
    const textOffset = Math.max(0, Number(q.textOffset ?? 0) || 0);
    const maxChars = Math.min(262_144, Math.max(256, Number(q.maxChars ?? 65_536) || 65_536));
    const slice = await sessionManager.getSessionTurnItemSliceAsync(id, itemId, { textOffset, maxChars });
    if (!slice) return reply.code(404).send({ error: 'Turn item not found' });
    return slice;
  });

  app.get('/api/v1/sessions/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    let session;
    try {
      session = await sessionManager.getSessionAsync(id);
    } catch (err) {
      return sendPluginError(reply, err, 400);
    }
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { runs: await sessionManager.getSessionRunsAsync(id) };
  });

  app.get('/api/v1/sessions/:id/agy/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.harnessKind !== 'agy') return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    try {
      const provider = resolveAgyRuntimeProvider(pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        driverProviderInstanceId: registry.get(session.harnessId)?.providerInstanceId,
        store,
        allowSingleCandidate: true,
      });
      if (!provider.service.listSubagents) return { subagents: [] };
      const res = await provider.service.listSubagents({ sessionId: session.id });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return res.value;
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/sessions/:id/agy/subagents/:subagentId', async (request, reply) => {
    const { id, subagentId } = request.params as { id: string; subagentId: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.harnessKind !== 'agy') return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    try {
      const provider = resolveAgyRuntimeProvider(pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        driverProviderInstanceId: registry.get(session.harnessId)?.providerInstanceId,
        store,
        allowSingleCandidate: true,
      });
      if (!provider.service.readSubagentDetail) return reply.code(404).send({ error: 'Subagent trace not found' });
      const res = await provider.service.readSubagentDetail({ sessionId: session.id, subagentId });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return res.value;
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/sessions/:id/agy/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.harnessKind !== 'agy') return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    try {
      const provider = resolveAgyRuntimeProvider(pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        driverProviderInstanceId: registry.get(session.harnessId)?.providerInstanceId,
        store,
        allowSingleCandidate: true,
      });
      if (!provider.service.listArtifacts) return { artifacts: [] };
      const res = await provider.service.listArtifacts({ sessionId: session.id });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return res.value;
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/sessions/:id/agy/artifacts/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.harnessKind !== 'agy') return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    try {
      const provider = resolveAgyRuntimeProvider(pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        driverProviderInstanceId: registry.get(session.harnessId)?.providerInstanceId,
        store,
        allowSingleCandidate: true,
      });
      if (!provider.service.readArtifact) return reply.code(404).send({ error: 'Artifact not found' });
      const res = await provider.service.readArtifact({ sessionId: session.id, name });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return res.value;
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  app.get('/api/v1/sessions/:id/agy/ecosystem', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.harnessKind !== 'agy') return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    try {
      const provider = resolveAgyRuntimeProvider(pluginManager, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        driverProviderInstanceId: registry.get(session.harnessId)?.providerInstanceId,
        store,
        allowSingleCandidate: true,
      });
      if (!provider.service.getEcosystem) return reply.code(404).send({ error: 'AGY ecosystem snapshot unavailable' });
      const res = await provider.service.getEcosystem({ sessionId: session.id });
      if (!res.ok) return mapAgyPeerError(reply, res.error);
      return res.value;
    } catch (err) {
      return sendPluginError(reply, err, 409);
    }
  });

  registerAgyNativeRoutes(app, {
    sessionManager,
    harnessRegistry: registry,
    pluginManager,
    store,
  });

  return {
    app,
    store,
    registry,
    pluginManager,
    pluginSecrets,
    sessionManager,
    get nativeRegistry(): AgyNativeRuntimeRegistry {
      const resolved = resolveOptionalAgyRuntimeProvider(pluginManager, { allowSingleCandidate: true });
      const internal = resolved
        ? pluginManager.host.getServiceByInstance<AgyRuntimeInternalHandle>(
            resolved.instanceId,
            AGY_RUNTIME_INTERNAL_SERVICE,
          )
        : undefined;
      return internal?.nativeRegistry as AgyNativeRuntimeRegistry;
    },
    commandOutputHub,
    terminalWorkspace,
    outboxWorker,
    auth,
    config,
    paths,
    async start() {
      await pluginManager.reloadAll();
      pluginManager.takeRegistryChanged();
      sessionManager.bindSettlementSinkToActiveAgy();
      for (const rt of listActiveSessionRuntimeProviders(pluginManager)) {
        await rt.service.recoverStaleRuns().catch(() => {});
      }
      await app.listen({ port: config.port, host: boundHost });
      const addrObj = app.server.address();
      if (addrObj && typeof addrObj === 'object') {
        boundPort = addrObj.port;
      }
      return { port: boundPort, host: boundHost };
    },
    async stop() {
      nativeWsGateway.close();
      wsGateway.close();
      pluginAuthoring.cancel();
      pluginBuilderV2.cancel();
      await terminalWorkspace.disposeAll();
      await sessionManager.shutdown();
      await app.close();
      await pluginManager.close();
      store.close();
    },
  };
}
