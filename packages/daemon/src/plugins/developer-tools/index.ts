import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION, HOST_SUPPORTED_FEATURES, PluginApiError, type Context, type PluginRouteRequest, type DeveloperTaskV1 } from '@harnessmate/plugin-api';
import { ReplayPluginDraftRequestSchema, PreviewPluginProgramRequestSchema, BuilderV2GenerateRequestSchema, BuilderV2InstallRequestSchema, GeneratePluginDraftRequestSchema, GeneratedPluginManifestSchema, PluginManifestSchema, ScaffoldPluginRequestSchema, type BuilderV2Result, type InstalledPluginInfo } from '@harnessmate/protocol';
import { runPluginProgram } from '../plugin-program.js';
import { PluginAuthoring } from './plugin-authoring.js';
import { PluginBuilderV2 } from './plugin-builder-v2.js';
import { buildScaffoldFiles, writeScaffoldToDirectory } from './plugin-scaffold.js';
import { pluginDevelopmentBrief } from './plugin-development-prompt.js';
import { auditPluginPackage } from '../plugin-static-audit.js';
import { normalizePluginManifest } from '../../plugin-host/manifest/normalize.js';
import type { AuthoringRegistry, DeveloperKernelPort } from './ports.js';

/** Ordinary package entry. No object, task, route or process exists before apply. */
export async function apply(ctx: Context) {
  if (!ctx.runtime.trustedLocal || !ctx.runtime.requestHost || !ctx.runtime.dataDirectory) {
    throw new PluginApiError('E_PERMISSION_DENIED', '开发工具需要现有的可信本地源码授权');
  }
  const directory = ctx.runtime.dataDirectory;
  fs.mkdirSync(directory, { recursive: true });
  const request = <T = Record<string, unknown>>(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    ctx.runtime.requestHost!<T>({ path: url, method, body });
  const listPlugins = () => request<{ plugins: InstalledPluginInfo[] }>('/api/v1/plugins');
  const kernel: DeveloperKernelPort = {
    async getAuthoringBase(id, digest) {
      const current = (await listPlugins()).plugins.find(p => p.id === id);
      if (!current || current.packageDigest !== digest) throw new PluginApiError('E_CONFLICT', '已安装修订已变化，请重新预览');
      return GeneratedPluginManifestSchema.parse(PluginManifestSchema.parse(current));
    },
    validateManifest(manifest) { normalizePluginManifest(manifest); },
    async linkDevPlugin(dirPath, trustedId) { return (await request<{ plugins: InstalledPluginInfo[] }>('/api/v1/plugins/dev/link', { dirPath, trustedId })).plugins; },
    async isTrustedDevSource(dir, id) { return (await listPlugins()).plugins.some(p => p.id === id && p.devSourceDir === dir && p.devTrustedLocal); },
    async installPlugin(input) { return (await request<{ plugins: InstalledPluginInfo[] }>('/api/v1/plugins/install', input)).plugins; },
  };
  const registry: AuthoringRegistry = { get(harnessId) {
    return { createSession: async config => {
      if (!ctx.harnesses.openSession) throw new PluginApiError('E_NOT_SUPPORTED', '缺少公开 Harness 会话租约');
      return await ctx.harnesses.openSession(harnessId, config) as unknown as Awaited<ReturnType<NonNullable<ReturnType<AuthoringRegistry['get']>>['createSession']>>;
    } };
  } };
  const authoring = new PluginAuthoring(registry);
  const builder = new PluginBuilderV2(directory, registry, authoring, kernel);
  const journal = path.join(directory, 'tasks.json');
  const tasks = new Map<string, DeveloperTaskV1>();
  const aborts = new Map<string, AbortController>();
  let alive = true;
  const save = () => {
    for (const [id, task] of tasks) { if (tasks.size <= 60) break; if (task.status !== 'running' && task.status !== 'queued') tasks.delete(id); }
    const tmp = journal + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...tasks.values()].slice(-60)));
    fs.renameSync(tmp, journal);
  };
  if (fs.existsSync(journal)) {
    for (const task of JSON.parse(fs.readFileSync(journal, 'utf8')) as DeveloperTaskV1[]) {
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'cancelled'; task.error = '工具停用或进程中断，任务未继续执行'; task.updatedAt = Date.now();
      }
      tasks.set(task.taskId, task);
    }
    save();
  }
  const getTask = (taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) throw new PluginApiError('E_INVALID_INPUT', '任务不存在');
    return task;
  };
  const cancel = (taskId: string, reason = '用户取消') => {
    const task = getTask(taskId);
    if (task.status === 'running' || task.status === 'queued') {
      task.status = 'cancelled'; task.error = reason; task.updatedAt = Date.now();
      aborts.get(taskId)?.abort(new Error(reason)); builder.cancel(); save();
    }
    return task;
  };
  const start = (input: Record<string, unknown>) => {
    if (!alive) throw new PluginApiError('E_STALE_RUN', '工具已停用');
    const taskId = typeof input.taskId === 'string' ? input.taskId : randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(taskId)) throw new PluginApiError('E_INVALID_INPUT', '任务 ID 无效');
    if (tasks.has(taskId)) return getTask(taskId); // idempotent reconnect; never generate twice
    if (aborts.size) throw new PluginApiError('E_CONFLICT', '当前实例已有生成任务，请取消或等待完成');
    const kind = input.kind === 'author' ? 'author' : 'generate';
    const parsed = kind === 'author' ? GeneratePluginDraftRequestSchema.parse(input.input) : BuilderV2GenerateRequestSchema.parse(input.input);
    const abort = new AbortController();
    const task: DeveloperTaskV1 = { taskId, instanceId: ctx.instanceId, runId: ctx.runId, kind, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), closePolicy: input.closePolicy === 'cancel' ? 'cancel' : 'background' };
    tasks.set(taskId, task); aborts.set(taskId, abort); save();
    void (async () => {
      try {
        const { workspaces } = await request<{ workspaces: Array<{ id: string; rootPath: string }> }>('/api/v1/workspaces');
        const workspace = workspaces.find(w => w.id === parsed.workspaceId);
        if (!workspace) throw new PluginApiError('E_INVALID_INPUT', '工作区不存在');
        abort.signal.throwIfAborted();
        const result = kind === 'author'
          ? { manifest: await authoring.generate(GeneratePluginDraftRequestSchema.parse(parsed), workspace.rootPath, abort.signal, parsed.editing ? await kernel.getAuthoringBase(parsed.editing.id, parsed.editing.digest) : undefined) }
          : await builder.generate(BuilderV2GenerateRequestSchema.parse(parsed), workspace.rootPath, abort.signal);
        if (!alive || abort.signal.aborted || task.status === 'cancelled') return;
        task.result = result as unknown as Record<string, unknown>;
        task.status = 'verified' in result && !result.verified ? 'failed' : 'completed';
        if ('error' in result && result.error) task.error = result.error;
      } catch (error) {
        if (!alive || task.status === 'cancelled') return;
        task.status = abort.signal.aborted ? 'cancelled' : 'failed';
        task.error = error instanceof Error ? error.message : String(error);
      } finally {
        aborts.delete(taskId); task.updatedAt = Date.now(); if (alive) save();
      }
    })();
    return task;
  };
  const developmentContext = async () => {
    const { providers } = await request<{ providers: unknown[] }>('/api/v1/plugins/services');
    return { sdkVersion: PLUGIN_API_VERSION, features: HOST_SUPPORTED_FEATURES, providers,
      userMessage: pluginDevelopmentBrief + '\nSDK: ' + PLUGIN_API_VERSION + '\n可用服务: ' + JSON.stringify(providers) };
  };
  const install = async (input: unknown) => {
    const parsed = BuilderV2InstallRequestSchema.parse(input);
    // A reconnect may follow a tool restart. Restore reviewed files by digest, never regenerate.
    if (parsed.draftId && !builder.getStagedDraft(parsed.draftId)) {
      const saved = [...tasks.values()].find(t => t.result?.draftId === parsed.draftId)?.result as BuilderV2Result | undefined;
      if (!saved?.verified || !saved.files || saved.digest !== parsed.expectedDigest) throw new PluginApiError('E_CONFLICT', '草稿不存在或未通过诊断');
      parsed.files = saved.files; parsed.draftId = undefined;
    }
    const result = await builder.installDraft(parsed);
    return { ...(await listPlugins()), ...result, activation: { status: 'applied', restartRequired: false,
      previewPages: result.plugins.filter(p => p.id === result.installedId).flatMap(p => (p.contributes.slots ?? []).filter(s => s.slot === 'workspace.pages').map(s => ({ instanceId: p.instanceId ?? p.id, pageId: s.id }))) } };
  };
  ctx.provide('developer.tools.v1', {
    getInfo: async () => ({ version: '1.0.0', sdkVersion: PLUGIN_API_VERSION }),
    developmentContext,
    listTasks: async () => ({ tasks: [...tasks.values()] }),
  });
  ctx.routes.register('/', async (req: PluginRouteRequest) => {
    try {
      if (req.path === '/context' && req.method === 'GET') return { body: await developmentContext() };
      if (req.path === '/tasks' && req.method === 'GET') return { body: { tasks: [...tasks.values()] } };
      if (req.path === '/tasks' && req.method === 'POST') return { status: 202, body: { task: start(req.body as Record<string, unknown>) } };
      const match = /^\/tasks\/([a-zA-Z0-9_-]+)(\/cancel)?$/.exec(req.path);
      if (match && req.method === (match[2] ? 'POST' : 'GET')) return { body: { task: match[2] ? cancel(match[1]!) : getTask(match[1]!) } };
      if (req.path === '/install' && req.method === 'POST') return { status: 201, body: await install(req.body) };
      if (req.path === '/preview/program' && req.method === 'POST') {
        const { manifest, programId, text } = PreviewPluginProgramRequestSchema.parse(req.body);
        const program = manifest.contributes.programs?.find(p => p.id === programId);
        if (!program) throw new PluginApiError('E_INVALID_INPUT', '草稿处理程序不存在');
        return { body: { output: runPluginProgram(program, text) } };
      }
      if (req.path === '/preview/replay' && req.method === 'POST') {
        const { manifest, sessionId, panelId, query } = ReplayPluginDraftRequestSchema.parse(req.body);
        const panel = manifest.contributes.dataPanels?.find(p => p.id === panelId);
        const projection = manifest.contributes.projections?.find(p => p.id === panel?.projection);
        if (!panel || !projection) throw new PluginApiError('E_INVALID_INPUT', '草稿面板不存在');
        return { body: await request('/api/v1/sessions/' + encodeURIComponent(sessionId) + '/turn-projection', { panel, projection, query }) };
      }
      if (req.path === '/audit' && req.method === 'POST') {
        const body = req.body as { files: Record<string, string>; manifest?: Record<string, unknown> };
        return { body: { audit: auditPluginPackage(body.files, body.manifest) } };
      }
      if (req.path === '/scaffold' && req.method === 'POST') {
        const input = ScaffoldPluginRequestSchema.parse(req.body);
        const { files } = buildScaffoldFiles(input);
        const dirPath = writeScaffoldToDirectory(input.targetDir?.trim() || path.join(directory, 'sources', input.id), files);
        if (input.linkDevMode && input.template !== 'browser-workspace') await kernel.linkDevPlugin(dirPath);
        return { status: 201, body: { ...(await listPlugins()), dirPath, files: Object.keys(files) } };
      }
      return { status: 404, body: { error: '开发工具路由不存在', code: 'E_NOT_SUPPORTED' } };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'E_INVALID_INPUT';
      return { status: code === 'E_PERMISSION_DENIED' ? 403 : code === 'E_CONFLICT' ? 409 : 400,
        body: { error: error instanceof Error ? error.message : String(error), code } };
    }
  });
  ctx.effect(() => () => {
    for (const taskId of aborts.keys()) cancel(taskId, '开发工具实例已停用');
    alive = false; builder.dispose();
  });
}
