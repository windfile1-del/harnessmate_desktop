import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  AddMcpServerRequestSchema,
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  CustomAcpHarnessConfigSchema,
  FailoverRequestSchema,
  InstallPluginRequestSchema,
  PROTOCOL_VERSION,
  PairExchangeRequestSchema,
  ResolveApprovalRequestSchema,
  SendTurnRequestSchema,
  SwitchHarnessRequestSchema,
  ToggleMcpServerRequestSchema,
  TogglePluginRequestSchema,
  UpdateRemoteConfigRequestSchema,
  UpdateSessionRequestSchema,
  UpdateTaskStateRequestSchema,
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
import { getGitStatusSummary } from '../core/git-service.js';
import { McpService } from '../core/mcp-service.js';
import { SessionManager } from '../core/session-manager.js';
import { runWorkspaceCommand } from '../core/terminal-service.js';
import { UsageService } from '../core/usage-service.js';
import { HarnessMateStore } from '../db/sqlite.js';
import { scanLocalCliSessions } from '../harnesses/history-scanner.js';
import { HarnessRegistry } from '../harnesses/registry.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { PluginManager } from '../plugins/plugin-manager.js';
import { RemoteAuthService, isLoopbackAddress } from './auth.js';
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
  const registry = new HarnessRegistry(config.binaryOverrides, config.customAcpHarnesses);
  if (opts.customAdapters) {
    for (const adapter of opts.customAdapters) {
      registry.register(adapter);
    }
  }

  const pluginManager = new PluginManager(
    paths.pluginsDir,
    registry,
    () => config.disabledPlugins,
    (ids) => {
      config.disabledPlugins = ids;
      saveConfig(paths.configPath, config);
    },
  );
  const attachmentService = new AttachmentService(paths.attachmentsDir);
  const mcpService = new McpService(registry, config.binaryOverrides);
  const usageService = new UsageService(store, registry, config.binaryOverrides);

  const eventBus = new DaemonEventBus();
  const sessionManager = new SessionManager(store, registry, eventBus, pluginManager);
  const auth = new RemoteAuthService(store, config.localToken);
  const wsGateway = new WsGateway({
    desktopId: config.desktopId,
    desktopName: config.desktopName,
    auth,
    eventBus,
    sessionManager,
  });

  const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 });
  let boundPort = config.port;
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
    (request as unknown as { principal: typeof principal }).principal = principal;
  });

  // ── Health & Harnesses ───────────────────────────────────────────────

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    daemonVersion: process.env.HARNESSMATE_APP_VERSION || '0.3.0',
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
        await sessionManager.shutdown();
        await app.close();
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
    const parsed = CustomAcpHarnessConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid harness config' });
    }
    const existingIdx = config.customAcpHarnesses.findIndex((h) => h.id === parsed.data.id);
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
    registry.unregister(id);
    const harnesses = await registry.probeAll(false);
    return { harnesses };
  });

  app.get('/api/v1/harnesses/discovered-sessions', async () => {
    return { sessions: scanLocalCliSessions(20) };
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

  app.post('/api/v1/plugins/install', async (request, reply) => {
    const parsed = InstallPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid plugin install payload' });
    }
    try {
      const beforeCount = registry.listAdapters().length;
      await pluginManager.installPlugin(parsed.data);
      const harnessesChanged = registry.listAdapters().length !== beforeCount;
      const harnesses = harnessesChanged ? await registry.probeAll(false) : undefined;
      return reply.code(201).send({ ...buildPluginPayload(), ...(harnesses ? { harnesses } : {}) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/v1/plugins/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = TogglePluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid toggle payload' });
    }
    try {
      const beforeCount = registry.listAdapters().length;
      await pluginManager.togglePlugin(id, parsed.data.enabled);
      const harnessesChanged = registry.listAdapters().length !== beforeCount;
      const harnesses = harnessesChanged ? await registry.probeAll(false) : undefined;
      return { ...buildPluginPayload(), ...(harnesses ? { harnesses } : {}) };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/v1/plugins/reload', async () => {
    await pluginManager.reloadAll();
    const harnesses = await registry.probeAll(true);
    return { ...buildPluginPayload(), harnesses };
  });

  app.delete('/api/v1/plugins/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const beforeCount = registry.listAdapters().length;
      await pluginManager.uninstallPlugin(id);
      const harnessesChanged = registry.listAdapters().length !== beforeCount;
      const harnesses = harnessesChanged ? await registry.probeAll(false) : undefined;
      return { ...buildPluginPayload(), ...(harnesses ? { harnesses } : {}) };
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

  app.get('/api/v1/usage/accounts', async () => {
    const accounts = await usageService.collectAccountUsage();
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
    const afterSeq = Math.max(0, Number(q.afterSeq ?? 0) || 0);
    const events = sessionManager.getSessionEvents(id, afterSeq);
    return { events, lastSeq: session.lastSeq };
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
      });
      return reply.code(202).send(result);
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
    const git = await getGitStatusSummary(session.cwd);
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
      await app.listen({ port: config.port, host: boundHost });
      const addrObj = app.server.address();
      if (addrObj && typeof addrObj === 'object') {
        boundPort = addrObj.port;
      }
      return { port: boundPort, host: boundHost };
    },
    async stop() {
      wsGateway.close();
      await sessionManager.shutdown();
      await app.close();
      store.close();
    },
  };
}
