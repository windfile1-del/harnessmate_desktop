import path from 'node:path';
import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  AddMcpServerRequestSchema,
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
  FailoverPolicySchema,
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
  MarkSessionViewedRequestSchema,
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
  ToggleMcpServerRequestSchema,
  TogglePluginRequestSchema,
  TrustSetupScriptRequestSchema,
  UpdateCompressionConfigRequestSchema,
  UpdatePluginRegistryConfigRequestSchema,
  UpdateRemoteConfigRequestSchema,
  UpdateSessionRequestSchema,
  UpdateTaskStateRequestSchema,
  UpdateSessionTriageRequestSchema,
  PluginPanelQuerySchema,
  PluginUiMessageRequestSchema,
  PreviewPluginProgramRequestSchema,
  ReplayPluginDraftRequestSchema,
  RunPluginActionRequestSchema,
  SetPluginPermissionRequestSchema,
  UploadAttachmentRequestSchema,
  UpsertAgyInstanceRequestSchema,
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
import { McpService } from '../core/mcp-service.js';
import { SessionManager } from '../core/session-manager.js';
import { TriageInboxService } from '../core/triage-inbox-service.js';
import {
  TerminalWorkspaceService,
} from '../core/terminal-workspace-service.js';
import type { UsageService } from '../core/usage-service.js';
import type { FailoverCoordinator } from '../core/failover-service.js';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  ContextCompressionError,
} from '../core/context-compression-service.js';
import { ORCHESTRATOR_PLUGIN_ID, OrchestratorError } from '../core/orchestrator-service.js';
import { createBuiltinPlugins, type FailoverService, type GitService } from '../plugin-host/builtin/services.js';
import { GitOperationError } from '../core/git-service.js';
import { FILE_PREVIEW_PERMISSION, PLUGIN_EVENT_VERSION, PluginApiError } from '@harnessmate/plugin-api';
import { HarnessMateStore } from '../db/sqlite.js';
import { HarnessRegistry } from '../harnesses/registry.js';
import { AgyAuthService } from '../harnesses/agy/agy-auth-service.js';
import { listAgySessionArtifacts, readAgySessionArtifact } from '../harnesses/agy/agy-artifacts.js';
import { listAgySubagentRecords, readAgySubagentDetail } from '../harnesses/agy/agy-child-work.js';
import { AgyAdapter } from '../harnesses/agy/agy-driver.js';
import { collectAgyEcosystemSnapshot } from '../harnesses/agy/agy-ecosystem.js';
import { resolveAgyProfileDirectories } from '../harnesses/agy/agy-profile-manager.js';
import {
  AgyNativeRuntimeRegistry,
  NativeWsFeedGateway,
  AgyConsumerProvenanceError,
  mintAgyDispatchProvenance,
  registerAgyNativeRoutes,
} from '../harnesses/agy/native/wiring/index.js';
import { wireAgyNativeRuntime } from '../harnesses/agy/native/wiring/composition.js';
import type { AgyNativeFeatureFlags } from '../harnesses/agy/native/wiring/types.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { PluginManager, PluginRevisionConflictError } from '../plugins/plugin-manager.js';
import { PluginAuthoring } from '../plugins/plugin-authoring.js';
import { PluginBuilderV2 } from '../plugins/plugin-builder-v2.js';
import { auditPluginPackage } from '../plugins/plugin-static-audit.js';
import { readPluginPanel } from '../plugins/plugin-panels.js';
import { PluginCapabilities } from '../plugins/plugin-capabilities.js';
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
import { registerServiceResolutionRoute } from '../plugin-host/composition/resolve-route.js';
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
  const triageInbox = new TriageInboxService(store, (session, event) => {
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
  });
  const terminalSessionOwners = new Map<string, string>();
  const sessionChangeFeed = new SessionChangeFeedService(store);
  const historyImportAdapter = new HistoryImportAdapter(store, registry, sessionChangeFeed);
  const pluginManager: PluginManager = new PluginManager(
    paths.pluginsDir,
    registry,
    () => config.disabledPlugins,
    createBuiltinPlugins(
      store,
      registry,
      config,
      (state) => {
        if (!store.getSession(state.sessionId)) return;
        eventBus.publishEvent(store.appendEvent(state.sessionId, 'task.state_updated', {
          version: state.version, objective: state.objective, stepsCount: state.steps.length,
          doneStepsCount: state.steps.filter(({ status }) => status === 'done').length,
          touchedFilesCount: state.touchedFiles.length, ledgerFilePath: state.ledgerFilePath ?? null,
        }));
      },
      () => pluginManager.host.events,
      opts.customAdapters,
      async (event) => (await pluginManager.isolated?.collectHandoffSections(event)) ?? [],
      terminalWorkspace,
      { service: triageInbox, bus: eventBus },
      paths.agyProfilesDir,
      historyImportAdapter,
      paths.attachmentsDir,
    ),
    { store, permissions: pluginPermissions, pluginSecrets, crashPolicy: opts.pluginCrashPolicy, safeMode: opts.pluginSafeMode,
      bundledPluginsDir: opts.bundledPluginsDir, onDevReload: () => wsGateway.notifyPluginsChanged() },
  );
  const pluginAuthoring = new PluginAuthoring(registry);
  const pluginBuilderV2 = new PluginBuilderV2(paths.dataDir, registry, pluginAuthoring, pluginManager);
  const mcpService = new McpService(registry, config.binaryOverrides);

  let boundPort = config.port;
  const commandOutputHub = new CommandOutputHub();
  const outboxWorker = new EffectOutboxWorker(store);
  const nativeRegistry = new AgyNativeRuntimeRegistry(store, opts.nativeFeatureFlags);
  const pluginCapabilities = new PluginCapabilities(store, pluginManager, () => `http://127.0.0.1:${boundPort}${pluginMcpPath}`, pluginPermissions);
  const sessionManager = new SessionManager(store, registry, eventBus, pluginManager, pluginCapabilities, commandOutputHub, terminalWorkspace, nativeRegistry);
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
  const disposeNativeRuntime = wireAgyNativeRuntime(nativeRegistry, sessionManager, registry, config.binaryOverrides);
  const agyAuthService = new AgyAuthService({
    getAdapter: (instanceId) => {
      const adapter = registry.get(instanceId);
      return adapter instanceof AgyAdapter ? adapter : undefined;
    },
    stopInstanceSessions: (instanceId) => sessionManager.closeSessionsForHarness(instanceId),
    onIdentityUpdated: (instanceId, identity) => {
      const idx = config.agyProfiles.findIndex((p) => p.instanceId === instanceId);
      if (idx >= 0) {
        config.agyProfiles[idx] = { ...config.agyProfiles[idx]!, identity };
        saveConfig(paths.configPath, config);
      }
    },
    onUsageCacheInvalidate: (instanceId) => {
      pluginManager.host.get<UsageService>('usage')?.invalidateCache(instanceId);
    },
    onStateChanged: (state) => {
      wsGateway.notifyAgyAuthState(state);
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
    const session = store.getSession(sessionId);
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
  const wsGateway = new WsGateway({
    desktopId: config.desktopId,
    desktopName: config.desktopName,
    auth,
    eventBus,
    sessionManager,
    terminalWorkspace,
    pluginManager,
  });
  pluginManager.host.events.on('plugin.state', ({ data }) => {
    syncTerminalOwnerListeners();
    if (data.pluginId === pluginManager.filePreviewProviderId) wsGateway.notifyPluginsChanged();
  });
  pluginPermissions.onChange(({ capability }) => {
    if (capability === FILE_PREVIEW_PERMISSION) wsGateway.notifyPluginsChanged();
  });
  const nativeWsGateway = new NativeWsFeedGateway({
    auth,
    sessionManager,
    nativeRegistry,
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
  });

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
        disposeNativeRuntime();
        await app.close();
        await pluginManager.close();
        store.close();
        process.exit(0);
      })();
    }, 80);
    return reply;
  });

  app.get('/api/v1/harnesses', async (request) => {
    const query = request.query as { refresh?: string };
    const harnesses = await registry.probeAll(query.refresh === '1' || query.refresh === 'true');
    return { harnesses };
  });

  app.post('/api/v1/harnesses/custom', async (request, reply) => {
    if (!pluginManager.host.get('harness.acp')) return reply.code(409).send({ error: '自定义 ACP 引擎插件已停用' });
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
    registry.registerCustomAcp(parsed.data);
    const harnesses = await registry.probeAll(true);
    return { harnesses };
  });

  app.delete('/api/v1/harnesses/custom/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = config.customAcpHarnesses.length;
    config.customAcpHarnesses = config.customAcpHarnesses.filter((h) => h.id !== id);
    if (config.customAcpHarnesses.length === before) {
      return reply.code(404).send({ error: 'Custom harness not found' });
    }
    saveConfig(paths.configPath, config);
    if (!registry.isReserved(id) && registry.get(id)?.isCustom) registry.unregister(id);
    const harnesses = await registry.probeAll(false);
    return { harnesses };
  });

  registerHistoryImportCompatRoutes(app, {
    store,
    pluginManager,
    adapter: historyImportAdapter,
  });

  // ── Phase AGY-2: Multi-Account Profiles & Official Auth Endpoints ────

  app.get('/api/v1/harnesses/agy/instances', async () => {
    const instances = registry
      .listAdapters()
      .filter((adapter): adapter is AgyAdapter => adapter instanceof AgyAdapter)
      .map((adapter) => ({
        profile: adapter.getProfile(),
        authState: agyAuthService.getState(adapter.id),
      }));
    return { instances };
  });

  app.post('/api/v1/harnesses/agy/instances', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY profiles can only be modified locally from Desktop' });
    }
    const parsed = UpsertAgyInstanceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid AGY profile payload' });
    }
    const req = parsed.data;
    if (req.instanceId === 'codex' || req.instanceId === 'claude') {
      return reply.code(409).send({ error: `Harness ID "${req.instanceId}" 已被内置引擎保留` });
    }
    const existingAdapter = registry.get(req.instanceId);
    if (existingAdapter && existingAdapter.driverId !== 'agy' && existingAdapter.kind !== 'agy') {
      return reply.code(409).send({ error: `Harness ID "${req.instanceId}" 已被其他引擎占用` });
    }

    const existingIdx = config.agyProfiles.findIndex((p) => p.instanceId === req.instanceId);
    const existingProfile = existingIdx >= 0 ? config.agyProfiles[existingIdx] : undefined;
    const isolationMode =
      req.instanceId === 'agy' ? (req.isolationMode ?? existingProfile?.isolationMode ?? 'official_default') : 'profile_isolated';

    const profile: AgyProfileConfig = {
      instanceId: req.instanceId,
      displayName: req.displayName,
      description: req.description,
      isolationMode,
      authMethod: req.authMethod,
      geminiDir: req.geminiDir?.trim() || existingProfile?.geminiDir,
      appDataDirName: req.appDataDirName,
      binaryPath: req.binaryPath?.trim() || undefined,
      gcpProject: req.gcpProject?.trim() || undefined,
      gcpLocation: req.gcpLocation?.trim() || undefined,
      defaults: req.defaults ?? existingProfile?.defaults ?? {
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
      identity: existingProfile?.identity,
      enabled: req.enabled,
    };

    if (existingIdx >= 0) {
      config.agyProfiles[existingIdx] = profile;
    } else {
      config.agyProfiles.push(profile);
    }
    saveConfig(paths.configPath, config);

    await sessionManager.closeSessionsForHarness(profile.instanceId);
    if (profile.enabled && registry.hasDriver('agy')) {
      registry.registerInstance({
        instanceId: profile.instanceId,
        driverId: 'agy',
        displayName: profile.displayName,
        description: profile.description,
        binaryPath: profile.binaryPath ?? config.binaryOverrides.agy,
        homeDir: profile.geminiDir,
        enabled: profile.enabled,
      });
    } else {
      registry.unregister(profile.instanceId);
    }
    pluginManager.host.get<UsageService>('usage')?.invalidateCache(profile.instanceId);

    const harnesses = await registry.probeAll(true);
    return {
      profile,
      authState: agyAuthService.getState(profile.instanceId),
      harnesses,
    };
  });

  app.delete('/api/v1/harnesses/agy/instances/:id', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY profiles can only be deleted locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const q = request.query as { purgeData?: string };
    if (id === 'agy') {
      return reply.code(400).send({ error: '不能删除内置主 AGY 实例，仅可删除自定义隔离账号或修改其模式。' });
    }
    const idx = config.agyProfiles.findIndex((p) => p.instanceId === id);
    const existingAdapter = registry.get(id);
    if (idx < 0 && !(existingAdapter instanceof AgyAdapter)) {
      return reply.code(404).send({ error: 'AGY profile not found' });
    }

    await agyAuthService.cancelLogin(id).catch(() => {});
    await sessionManager.closeSessionsForHarness(id);

    if (idx >= 0) {
      config.agyProfiles.splice(idx, 1);
      saveConfig(paths.configPath, config);
    }
    registry.unregister(id);
    pluginManager.host.get<UsageService>('usage')?.invalidateCache(id);

    if (q.purgeData === '1' || q.purgeData === 'true') {
      const dirs = resolveAgyProfileDirectories(paths.agyProfilesDir, id);
      const profilesRootResolved = path.resolve(paths.agyProfilesDir);
      if (path.resolve(dirs.geminiDir).startsWith(`${profilesRootResolved}${path.sep}`)) {
        fs.rmSync(dirs.geminiDir, { recursive: true, force: true });
      }
      if (path.resolve(dirs.runtimeTempDir).startsWith(`${profilesRootResolved}${path.sep}`)) {
        fs.rmSync(dirs.runtimeTempDir, { recursive: true, force: true });
      }
    }

    const harnesses = await registry.probeAll(false);
    return { deleted: true, instanceId: id, harnesses };
  });

  app.get('/api/v1/harnesses/agy/instances/:id/auth/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const adapter = registry.get(id);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(404).send({ error: 'AGY instance not found' });
    }
    return { state: agyAuthService.getState(id) };
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/start', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login can only be started locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    try {
      const state = await agyAuthService.startLogin(id);
      return { state };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/respond', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login code can only be submitted locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const parsed = AgyAuthRespondRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid login response payload' });
    }
    try {
      const state = await agyAuthService.respondLogin(id, parsed.data.flowId, parsed.data.codeOrUrl);
      const harnesses = await registry.probeAll(true);
      return { state, harnesses };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/cancel', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY login cancellation is local only' });
    }
    const { id } = request.params as { id: string };
    const parsed = AgyAuthCancelRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid cancel payload' });
    }
    const state = await agyAuthService.cancelLogin(id, parsed.data.flowId);
    return { state };
  });

  app.post('/api/v1/harnesses/agy/instances/:id/auth/logout', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'AGY logout can only be triggered locally from Desktop' });
    }
    const { id } = request.params as { id: string };
    const parsed = AgyAuthLogoutRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid logout payload' });
    }
    try {
      const state = await agyAuthService.logout(id, parsed.data);
      const harnesses = await registry.probeAll(true);
      return { state, harnesses };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
  app.get('/api/v1/plugins/composition', async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    const workspace = typeof workspaceId === 'string' ? store.getWorkspace(workspaceId) : undefined;
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
    if (typeof workspaceId !== 'string' || (workspaceId !== GLOBAL_WORKSPACE_SCOPE && !store.getWorkspace(workspaceId))) {
      return reply.code(404).send({ error: '工作区不存在' });
    }
    return { permissions: pluginCapabilities.listPermissions(workspaceId, id) };
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
    return { ...buildPluginPayload(), ...(harnesses ? { harnesses } : {}) };
  };

  app.put('/api/v1/plugins/composition/file-preview', async (request, reply) => {
    const { pluginId, workspaceId } = (request.body ?? {}) as { pluginId?: unknown; workspaceId?: unknown };
    if (pluginId !== null && (typeof pluginId !== 'string' || typeof workspaceId !== 'string' || !store.getWorkspace(workspaceId))) {
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
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: 'Workspace not found' });
    return {
      workspaceId: id,
      bindings: store.listCapabilityBindings('workspace', id),
      resolved: {
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
      },
    };
  });

  app.put('/api/v1/workspaces/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getWorkspace(id)) return reply.code(404).send({ error: 'Workspace not found' });
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
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/v1/sessions/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return {
      sessionId: id,
      bindings: store.listCapabilityBindings('session', id),
      resolved: {
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
    const session = sessionManager.getSession(id);
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
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
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

  // ── Unified Cross-CLI MCP Hub (/api/v1/mcp/*) ────────────────────────

  app.get('/api/v1/mcp/servers', async () => {
    const servers = await mcpService.listAllServers();
    return { servers, presets: pluginManager.listActiveMcpPresets() };
  });

  app.post('/api/v1/mcp/servers', async (request, reply) => {
    const parsed = AddMcpServerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP payload' });
    }
    const { results } = await mcpService.addServer(parsed.data);
    const servers = await mcpService.listAllServers();
    return { results, servers };
  });

  app.patch('/api/v1/mcp/servers/toggle', async (request, reply) => {
    const parsed = ToggleMcpServerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MCP toggle payload' });
    }
    const result = await mcpService.toggleServer(parsed.data);
    const servers = await mcpService.listAllServers();
    return { result, servers };
  });

  app.delete('/api/v1/mcp/servers/:harnessId/:name', async (request, reply) => {
    const { harnessId, name } = request.params as { harnessId: string; name: string };
    if (harnessId !== 'codex' && harnessId !== 'agy' && harnessId !== 'claude') {
      return reply.code(400).send({ error: 'Unsupported harness for MCP removal' });
    }
    const result = await mcpService.removeServer(harnessId, name);
    const servers = await mcpService.listAllServers();
    return { result, servers };
  });

  // ── Multi-Account & Quota Usage (/api/v1/usage/*) ────────────────────

  app.get('/api/v1/usage/accounts', async (request, reply) => {
    const usage = pluginManager.host.get<UsageService>('usage');
    if (!usage) return reply.code(409).send({ error: '额度服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    const q = request.query as { refresh?: string };
    const forceRefresh = q.refresh === '1' || q.refresh === 'true';
    const accounts = await usage.collectAccountUsage({ forceRefresh });
    return { accounts, collectedAt: Date.now() };
  });

  app.get('/api/v1/usage/failover-policy', async (_request, reply) => {
    const failover = pluginManager.host.get<FailoverService>('failover') as FailoverCoordinator | undefined;
    if (!failover || typeof failover.getPolicy !== 'function') {
      return reply.code(409).send({ error: 'Failover 服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    }
    return { policy: failover.getPolicy() };
  });

  app.put('/api/v1/usage/failover-policy', async (request, reply) => {
    const failover = pluginManager.host.get<FailoverService>('failover') as FailoverCoordinator | undefined;
    if (!failover || typeof failover.setPolicy !== 'function') {
      return reply.code(409).send({ error: 'Failover 服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    }
    const parsed = FailoverPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid failover policy' });
    }
    return { policy: failover.setPolicy(parsed.data) };
  });

  app.get('/api/v1/sessions/:id/failover-recommendation', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const failover = pluginManager.host.get<FailoverService>('failover') as FailoverCoordinator | undefined;
    if (!failover || typeof failover.recommendFailover !== 'function') {
      return reply.code(409).send({ error: 'Failover 服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    }
    const q = request.query as { failedInstanceId?: string; failureClass?: string };
    const recommendation = failover.recommendFailover(
      id,
      q.failedInstanceId || session.harnessId,
      q.failureClass || 'usage_limit',
    );
    return { recommendation };
  });

  // ── Workspaces ───────────────────────────────────────────────────────

  app.get('/api/v1/workspaces', async () => ({
    workspaces: sessionManager.listWorkspaces(),
  }));

  app.post('/api/v1/workspaces', async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid workspace' });
    }
    try {
      const workspace = await sessionManager.addWorkspace(parsed.data.rootPath, parsed.data.name);
      return reply.code(201).send({ workspace });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/v1/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await sessionManager.deleteWorkspace(id);
    if (!deleted) return reply.code(404).send({ error: 'Workspace not found' });
    return { deleted: true };
  });

  // ── Session Triage ─────────────────────────────────────────────────

  const activeTriage = () => pluginManager.host.get<TriageInboxService>('triage-inbox');
  app.get('/api/v1/triage/state', async (_request, reply) => {
    const service = activeTriage();
    if (!service) return reply.code(409).send({ error: '会话待办插件已停用' });
    return { sessions: service.list() };
  });

  app.patch('/api/v1/triage/sessions/:id', async (request, reply) => {
    const service = activeTriage();
    if (!service) return reply.code(409).send({ error: '会话待办插件已停用' });
    const parsed = UpdateSessionTriageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { id } = request.params as { id: string };
    const session = service.update(id, parsed.data);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { session };
  });

  app.post('/api/v1/triage/sessions/:id/viewed', async (request, reply) => {
    const service = activeTriage();
    if (!service) return reply.code(409).send({ error: '会话待办插件已停用' });
    const parsed = MarkSessionViewedRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { id } = request.params as { id: string };
    const session = service.markViewed(id, parsed.data);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { session };
  });

  app.post('/api/v1/triage/check-snoozes', async (_request, reply) => {
    const service = activeTriage();
    if (!service) return reply.code(409).send({ error: '会话待办插件已停用' });
    const expired = service.checkExpiredSnoozes();
    return { expired, sessions: service.list() };
  });

  // ── Sessions, Attachments, Files, Rules, Terminal & Handoff ──────────

  app.get('/api/v1/sessions', async (request) => {
    const q = request.query as {
      workspaceId?: string;
      harnessId?: string;
      includeArchived?: string;
    };
    const sessions = sessionManager.listSessions({
      workspaceId: q.workspaceId,
      harnessId: q.harnessId,
      includeArchived: q.includeArchived === '1' || q.includeArchived === 'true',
    });
    return { sessions };
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const pendingApprovals = sessionManager.listPendingApprovals(id);
    const taskState = sessionManager.getTaskState(id);
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
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await sessionManager.deleteSession(id);
    if (!deleted) return reply.code(404).send({ error: 'Session not found' });
    return { deleted: true };
  });

  app.get('/api/v1/sessions/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { afterSeq?: string };
    const parsedSeq = Number(q.afterSeq ?? 0);
    if (!Number.isSafeInteger(parsedSeq) || parsedSeq < 0) return reply.code(400).send({ error: 'Invalid event cursor' });
    const afterSeq = parsedSeq;
    const events = sessionManager.getSessionEvents(id, afterSeq);
    return { events, lastSeq: session.lastSeq };
  });

  app.get('/api/v1/sessions/:id/plugin-panels/:pluginId/:panelId', async (request, reply) => {
    const { id, pluginId, panelId } = request.params as { id: string; pluginId: string; panelId: string };
    const session = sessionManager.getSession(id);
    const contribution = pluginManager.getDataPanel(pluginId, panelId);
    if (!session || !contribution) return reply.code(404).send({ error: '会话或插件面板不存在' });
    const query = PluginPanelQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '面板筛选条件无效' });
    return readPluginPanel(store, session, contribution.panel, contribution.projection, query.data);
  });

  app.get('/api/v1/sessions/:id/commands', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/sessions/:id/turn-suggestion', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) return reply.code(403).send({ error: '插件建议仅在本机预览' });
    const { id } = request.params as { id: string };
    const parsed = SendTurnRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '消息草稿无效' });
    try {
      return { suggestion: await sessionManager.previewTurnSuggestion(id, parsed.data.text, parsed.data.attachments) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/sessions/:id/context-preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { targetHarnessId?: string; syncMode?: ContextSyncMode };
    try {
      const preview = await sessionManager.getContextPreview(id, q.targetHarnessId, q.syncMode);
      return { preview };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/sessions/:id/task-state', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { taskState: sessionManager.getTaskState(id) };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/v1/sessions/:id/task-state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateTaskStateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid task state' });
    }
    try {
      return { taskState: sessionManager.updateTaskState(id, parsed.data) };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/sessions/:id/task-state/summarize', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { taskState: sessionManager.summarizeTaskState(id) };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
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
    if (!sessionManager.getSession(id)) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    await sessionManager.interruptSession(id);
    return { interrupted: true };
  });

  registerFilesAttachmentsRulesCompatRoutes(app, {
    store,
    pluginManager,
    sessionManager,
    attachmentsRoot: paths.attachmentsDir,
  });

  app.post('/api/v1/sessions/:id/browser/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Multi-Harness Parallel Orchestrator (Scenario D) ─────────────────

  app.get('/api/v1/sessions/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    return sessionManager.getOrchestratorService().getBoard(id);
  });

  app.post('/api/v1/sessions/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DelegateSubagentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid delegation payload' });
    }
    try {
      const subagent = await sessionManager.getOrchestratorService().delegateTask(id, parsed.data);
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
      return reply.code(code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400).send({
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
      return reply.code(code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400).send({
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
      return reply.code(code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400).send({
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
      const status = code === 'E_MERGE_CONFLICT' || code === 'E_SUBAGENT_ACTIVE' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
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
      const status = code === 'E_WORKTREE_BUSY' || code === 'E_SUBAGENT_ACTIVE' ? 409 : code === 'E_SUBAGENT_NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err), code });
    }
  });

  // ── AI Context Compression & Symbol Index ─────────────────────────────

  app.get('/api/v1/sessions/:id/compression', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      return await sessionManager.getContextCompressionService().getSessionStatus(id);
    } catch (err) {
      const code = err instanceof ContextCompressionError ? err.code : 'E_COMPRESSION_STATUS_FAILED';
      return reply.code(code === 'E_SESSION_NOT_FOUND' ? 404 : 400).send({
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
      const svc = sessionManager.getContextCompressionService();
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
      return reply.code(code === 'E_SESSION_NOT_FOUND' ? 404 : 400).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.delete('/api/v1/sessions/:id/compression/cache', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    try {
      const svc = sessionManager.getContextCompressionService();
      const cleared = svc.clearSessionCache(id);
      const status = await svc.getSessionStatus(id);
      return { ...cleared, status };
    } catch (err) {
      const code = err instanceof ContextCompressionError ? err.code : 'E_CACHE_CLEAR_FAILED';
      return reply.code(code === 'E_SESSION_NOT_FOUND' ? 404 : 400).send({
        error: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  });

  app.get('/api/v1/compression/config', async () => {
    const svc = sessionManager.getContextCompressionService();
    return {
      enabled: pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID),
      config: svc.getConfig(),
    };
  });

  app.put('/api/v1/compression/config', async (request, reply) => {
    const parsed = UpdateCompressionConfigRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid compression config' });
    }
    const svc = sessionManager.getContextCompressionService();
    const config = svc.updateConfig(parsed.data);
    return {
      enabled: pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID),
      config,
    };
  });

  app.get('/api/v1/sessions/:id/side-chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    return { messages: sessionManager.getSideChat(id) };
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/v1/sessions/:id/side-chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) return reply.code(404).send({ error: 'Session not found' });
    sessionManager.clearSideChat(id);
    return { ok: true };
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
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { afterSeq?: string; turnId?: string; limit?: string };
    const rawItems = sessionManager.getSessionTurnItems(id, {
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
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { textOffset?: string; maxChars?: string };
    const textOffset = Math.max(0, Number(q.textOffset ?? 0) || 0);
    const maxChars = Math.min(262_144, Math.max(256, Number(q.maxChars ?? 65_536) || 65_536));
    const slice = sessionManager.getSessionTurnItemSlice(id, itemId, { textOffset, maxChars });
    if (!slice) return reply.code(404).send({ error: 'Turn item not found' });
    return slice;
  });

  app.get('/api/v1/sessions/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { runs: sessionManager.getSessionRuns(id) };
  });

  app.get('/api/v1/sessions/:id/agy/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    }
    if (!session.nativeSessionId) {
      return { subagents: [] };
    }
    const ctx = adapter.getLaunchContextSync();
    return { subagents: listAgySubagentRecords(ctx.appDataPath, session.nativeSessionId) };
  });

  app.get('/api/v1/sessions/:id/agy/subagents/:subagentId', async (request, reply) => {
    const { id, subagentId } = request.params as { id: string; subagentId: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    }
    if (!session.nativeSessionId) {
      return reply.code(404).send({ error: 'Native session not initialized' });
    }
    const ctx = adapter.getLaunchContextSync();
    const detail = readAgySubagentDetail(ctx.appDataPath, session.nativeSessionId, subagentId);
    if (!detail) {
      return reply.code(404).send({ error: 'Subagent trace not found' });
    }
    return { subagent: detail };
  });

  app.get('/api/v1/sessions/:id/agy/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    }
    if (!session.nativeSessionId) {
      return { artifacts: [] };
    }
    const ctx = adapter.getLaunchContextSync();
    return { artifacts: listAgySessionArtifacts(ctx.appDataPath, session.nativeSessionId) };
  });

  app.get('/api/v1/sessions/:id/agy/artifacts/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    }
    if (!session.nativeSessionId) {
      return reply.code(404).send({ error: 'Native session not initialized' });
    }
    const ctx = adapter.getLaunchContextSync();
    const artifact = readAgySessionArtifact(ctx.appDataPath, session.nativeSessionId, name);
    if (!artifact) {
      return reply.code(404).send({ error: 'Artifact not found' });
    }
    return { artifact };
  });

  app.get('/api/v1/sessions/:id/agy/ecosystem', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const adapter = registry.get(session.harnessId);
    if (!(adapter instanceof AgyAdapter)) {
      return reply.code(400).send({ error: 'Session is not bound to an AGY adapter' });
    }
    const profile = adapter.getProfile();
    const snapshot = collectAgyEcosystemSnapshot({
      launchContext: adapter.getLaunchContextSync(),
      workspaceRoot: session.cwd,
      additionalDirectories: profile.defaults?.additionalDirectories ?? [],
      harnessMateActivePluginsCount: pluginManager.listInstalled().filter((p) => p.enabled).length,
    });
    return { ecosystem: snapshot };
  });

  registerAgyNativeRoutes(app, {
    sessionManager,
    harnessRegistry: registry,
    nativeRegistry,
  });

  return {
    app,
    store,
    registry,
    pluginManager,
    pluginSecrets,
    sessionManager,
    nativeRegistry,
    commandOutputHub,
    terminalWorkspace,
    outboxWorker,
    auth,
    config,
    paths,
    async start() {
      await pluginManager.reloadAll();
      pluginManager.takeRegistryChanged();
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
      await agyAuthService.dispose();
      await terminalWorkspace.disposeAll();
      await sessionManager.shutdown();
      disposeNativeRuntime();
      await app.close();
      await pluginManager.close();
      store.close();
    },
  };
}
