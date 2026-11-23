import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  AddMcpServerRequestSchema,
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  CustomAcpHarnessConfigSchema,
  FailoverRequestSchema,
  GeneratePluginDraftRequestSchema,
  ImportNativeSessionRequestSchema,
  InstallPluginRequestSchema,
  PROTOCOL_VERSION,
  PairExchangeRequestSchema,
  ResolveApprovalRequestSchema,
  RunHarnessCommandRequestSchema,
  SendTurnRequestSchema,
  SwitchHarnessRequestSchema,
  ToggleMcpServerRequestSchema,
  TogglePluginRequestSchema,
  UpdateRemoteConfigRequestSchema,
  UpdateSessionRequestSchema,
  UpdateTaskStateRequestSchema,
  PluginPanelQuerySchema,
  PreviewPluginProgramRequestSchema,
  ReplayPluginDraftRequestSchema,
  RunPluginActionRequestSchema,
  SetPluginPermissionRequestSchema,
  UploadAttachmentRequestSchema,
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
import {
  AttachmentService,
  discoverProjectRulesAndSkills,
  inferMimeType,
  readWorkspaceFilePreview,
  searchWorkspaceFiles,
} from '../core/attachment-service.js';
import { DaemonEventBus } from '../core/event-bus.js';
import { McpService } from '../core/mcp-service.js';
import { SessionManager } from '../core/session-manager.js';
import { runWorkspaceCommand } from '../core/terminal-service.js';
import type { UsageService } from '../core/usage-service.js';
import { createBuiltinPlugins, type GitService } from '../plugin-host/builtin/services.js';
import { PluginApiError } from '@harnessmate/plugin-api';
import { HarnessMateStore } from '../db/sqlite.js';
import { scanLocalCliSessions } from '../harnesses/history-scanner.js';
import { HarnessRegistry } from '../harnesses/registry.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { PluginManager, PluginRevisionConflictError } from '../plugins/plugin-manager.js';
import { PluginAuthoring } from '../plugins/plugin-authoring.js';
import { readPluginPanel } from '../plugins/plugin-panels.js';
import { PluginCapabilities } from '../plugins/plugin-capabilities.js';
import { pluginMcpPath, registerPluginMcp } from '../plugins/plugin-mcp.js';
import { runPluginProgram } from '../plugins/plugin-program.js';
import { RemoteAuthService, isLocalBrowserRequest, isLoopbackAddress } from './auth.js';
import { WsGateway } from './ws.js';

export interface CreateDaemonOptions {
  dataDir?: string;
  port?: number;
  hostOverride?: string;
  customAdapters?: HarnessAdapter[];
  webDistDir?: string | null;
}

export interface DaemonInstance {
  app: FastifyInstance;
  store: HarnessMateStore;
  registry: HarnessRegistry;
  pluginManager: PluginManager;
  sessionManager: SessionManager;
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
  const store = new HarnessMateStore(paths.dbPath);
  const eventBus = new DaemonEventBus();
  const registry = new HarnessRegistry();
  if (opts.customAdapters) {
    for (const adapter of opts.customAdapters) {
      if (!registry.isReserved(adapter.id)) registry.register(adapter);
    }
  }

  const pluginManager: PluginManager = new PluginManager(
    paths.pluginsDir,
    registry,
    () => config.disabledPlugins,
    createBuiltinPlugins(store, registry, config, (state) => {
      if (!store.getSession(state.sessionId)) return;
      eventBus.publishEvent(store.appendEvent(state.sessionId, 'task.state_updated', {
        version: state.version, objective: state.objective, stepsCount: state.steps.length,
        doneStepsCount: state.steps.filter(({ status }) => status === 'done').length,
        touchedFilesCount: state.touchedFiles.length, ledgerFilePath: state.ledgerFilePath ?? null,
      }));
    }, () => pluginManager.host.events, opts.customAdapters),
  );
  const pluginAuthoring = new PluginAuthoring(registry);
  const attachmentService = new AttachmentService(paths.attachmentsDir);
  const mcpService = new McpService(registry, config.binaryOverrides);

  let boundPort = config.port;
  const pluginCapabilities = new PluginCapabilities(store, pluginManager, () => `http://127.0.0.1:${boundPort}${pluginMcpPath}`);
  const sessionManager = new SessionManager(store, registry, eventBus, pluginManager, pluginCapabilities);
  const auth = new RemoteAuthService(store, config.localToken);
  const wsGateway = new WsGateway({
    desktopId: config.desktopId,
    desktopName: config.desktopName,
    auth,
    eventBus,
    sessionManager,
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
      urlPath === '/api/v1/pair/exchange' ||
      urlPath.startsWith('/api/v1/attachments/')
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
    if (urlPath.startsWith('/api/v1/plugins/') && (request.method !== 'GET' || urlPath === '/api/v1/plugins/composition')
      && (principal.kind !== 'local' || !isLoopbackAddress(request.socket.remoteAddress))) {
      return reply.code(403).send({ error: '插件管理仅在本机可用' });
    }
    (request as unknown as { principal: typeof principal }).principal = principal;
  });

  // ── Health & Harnesses ───────────────────────────────────────────────

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    daemonVersion: process.env.HARNESSMATE_APP_VERSION || '0.5.0',
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

  app.get('/api/v1/harnesses/discovered-sessions', async (request, reply) => {
    const { limit: rawLimit } = request.query as { limit?: string };
    const limit = Number(rawLimit ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return reply.code(400).send({ error: 'Invalid history list limit' });
    }
    const found = await scanLocalCliSessions(limit + 1);
    const counts = new Map<string, number>();
    const sessions = found.filter((item) => {
      const source = item.source ?? item.harnessKind;
      const count = (counts.get(source) ?? 0) + 1;
      counts.set(source, count);
      return count <= limit;
    });
    return { sessions, hasMore: limit < 1000 && found.length > sessions.length };
  });

  app.post('/api/v1/harnesses/import-session', async (request, reply) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Native history import is local only' });
    }
    const parsed = ImportNativeSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid history import request' });
    try {
      return { session: await sessionManager.importNativeSession(parsed.data) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Modular Plugin Studio (/api/v1/plugins/*) ────────────────────────

  const buildPluginPayload = () => ({
    plugins: pluginManager.listInstalled(),
    catalog: pluginManager.listCatalog(),
    slashCommands: pluginManager.listActiveSlashCommands(),
    mcpPresets: pluginManager.listActiveMcpPresets(),
    pluginsDir: paths.pluginsDir,
  });

  app.get('/api/v1/plugins', async () => buildPluginPayload());
  app.get('/api/v1/plugins/composition', async () => pluginManager.getComposition());
  registerPluginMcp(app, pluginCapabilities);

  app.get('/api/v1/plugins/:id/permissions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId } = request.query as { workspaceId?: string };
    if (typeof workspaceId !== 'string' || !store.getWorkspace(workspaceId)) return reply.code(404).send({ error: '工作区不存在' });
    return { permissions: pluginCapabilities.listPermissions(workspaceId, id) };
  });

  app.put('/api/v1/plugins/:id/permissions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SetPluginPermissionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '插件授权参数无效' });
    try { return { permissions: pluginCapabilities.setPermission(id, parsed.data) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
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

  app.post('/api/v1/plugins/preview', async (request, reply) => {
    const parsed = InstallPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '插件清单或目录无效' });
    try {
      return pluginManager.previewInstall(parsed.data);
    } catch (error) {
      return reply.code(error instanceof PluginRevisionConflictError ? 409 : 400).send({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof PluginApiError ? error.code : 'E_INVALID_INPUT',
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

  app.get('/api/v1/usage/accounts', async (_request, reply) => {
    const usage = pluginManager.host.get<UsageService>('usage');
    if (!usage) return reply.code(409).send({ error: '额度服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    const accounts = await usage.collectAccountUsage();
    return { accounts, collectedAt: Date.now() };
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
    return { commands: sessionManager.getHarnessCommands(session), pluginActions: sessionManager.listPluginActions(session),
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
      return await sessionManager.runHarnessCommand(id, parsed.data);
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
      const result = await sessionManager.sendTurn(id, parsed.data.text, parsed.data.attachments, {
        harnessId: parsed.data.harnessId,
        model: parsed.data.model,
        omitHandoff: parsed.data.omitHandoff,
        literalText: parsed.data.literalText,
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
      return await sessionManager.failoverSession(id, parsed.data);
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

  app.post('/api/v1/sessions/:id/attachments', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.getSession(id)) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    const parsed = UploadAttachmentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid attachment' });
    }
    try {
      const attachment = attachmentService.saveSessionAttachment(id, parsed.data);
      return reply.code(201).send({ attachment });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/attachments/:sessionId/:filename', async (request, reply) => {
    const { sessionId, filename } = request.params as { sessionId: string; filename: string };
    const filePath = attachmentService.resolveAttachmentFile(sessionId, filename);
    if (!filePath) return reply.code(404).send({ error: 'Attachment not found' });
    reply.header('Content-Type', inferMimeType(filePath));
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(filePath));
  });

  app.get('/api/v1/sessions/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { q?: string };
    return { files: searchWorkspaceFiles(session.cwd, q.q ?? '', 120) };
  });

  app.get('/api/v1/sessions/:id/file-content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'Missing path parameter' });
    try {
      return readWorkspaceFilePreview(session.cwd, q.path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/sessions/:id/rules', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { instructions: discoverProjectRulesAndSkills(session.cwd) };
  });

  app.post('/api/v1/sessions/:id/terminal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const body = request.body as { command?: string };
    if (!body?.command?.trim()) {
      return reply.code(400).send({ error: 'Command is required' });
    }
    try {
      const result = await runWorkspaceCommand(session.cwd, body.command);
      return { result };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
    try {
      return sessionManager.exportSessionMarkdown(id);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/v1/sessions/:id/git', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const service = pluginManager.host.get<GitService>('git');
    if (!service) return reply.code(409).send({ error: 'Git 服务已停用', code: 'E_SERVICE_UNAVAILABLE' });
    const git = await service.status(session.cwd);
    return { git };
  });

  // ── Approvals ────────────────────────────────────────────────────────

  app.get('/api/v1/approvals', async (request) => {
    const q = request.query as { sessionId?: string };
    return { approvals: sessionManager.listPendingApprovals(q.sessionId) };
  });

  app.post('/api/v1/approvals/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ResolveApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid decision' });
    }
    const principal = (request as unknown as { principal?: { kind: 'local' | 'device' } }).principal;
    const resolvedBy = principal?.kind === 'device' ? 'mobile' : parsed.data.resolvedBy;
    try {
      const approval = await sessionManager.resolveApproval(
        id,
        parsed.data.decision,
        resolvedBy,
        parsed.data.comment,
      );
      return { approval };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
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
    wsGateway.handleUpgrade(req, socket, head);
  });

  return {
    app,
    store,
    registry,
    pluginManager,
    sessionManager,
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
      wsGateway.close();
      pluginAuthoring.cancel();
      await sessionManager.shutdown();
      await app.close();
      await pluginManager.close();
      store.close();
    },
  };
}
