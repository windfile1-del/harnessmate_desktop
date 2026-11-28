import type { FastifyInstance } from 'fastify';
import { PluginApiError, type PluginSettingsDescriptorV1 } from '@harnessmate/plugin-api';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type { DaemonPersistedConfig, DaemonRuntimePaths } from '../../config.js';
import { saveConfig } from '../../config.js';
import { isLoopbackAddress } from '../auth.js';
export function registerPluginSettings(app: FastifyInstance, manager: PluginManager, config: DaemonPersistedConfig, paths: DaemonRuntimePaths, changed: () => void) {
  const describe = (instanceId: string): PluginSettingsDescriptorV1 => {
    const plugin = manager.listInstalled().find(p => (p.instanceId ?? p.id) === instanceId);
    if (!plugin) throw new PluginApiError('E_INVALID_INPUT', '插件实例不存在');
    const entry = manager.getComposition().entries.find(e => e.id === instanceId);
    return { instanceId, pluginId: plugin.id, version: plugin.version,
      schemaVersion: plugin.contributes.settingsVersion ?? 1, settings: plugin.contributes.settings ?? {},
      config: { ...config.pluginConfig?.[instanceId], ...entry?.config },
      views: (plugin.contributes.slots ?? []).filter(s => s.slot === 'harness.settings' || s.slot === 'workspace.pages').map(s => ({ slot: s.slot, id: s.id, title: s.title })) };
  };
  app.addHook('preHandler', async (req, reply) => {
    if (/^\/api\/v1\/plugins\/(?:settings|host-config|[^/]+\/settings)(?:\?|$)/.test(req.url) && !isLoopbackAddress(req.socket.remoteAddress)) return reply.code(403).send({ error: '设置仅供本机管理' });
  });
  app.get('/api/v1/plugins/settings', async () => ({ settings: manager.listInstalled().map(p => describe(p.instanceId ?? p.id)) }));
  app.get('/api/v1/plugins/:id/settings', async req => describe((req.params as { id: string }).id));
  app.put('/api/v1/plugins/:id/settings', async (req, reply) => {
    try {
      const id = (req.params as { id: string }).id;
      const descriptor = describe(id);
      const body = req.body as { config?: Record<string, unknown>; schemaVersion?: number; expectedVersion?: string };
      if (!body.config || Array.isArray(body.config) || typeof body.config !== 'object') throw new PluginApiError('E_INVALID_INPUT', '配置必须是对象');
      if (body.expectedVersion && descriptor.version !== body.expectedVersion) throw new PluginApiError('E_CONFLICT', '插件修订已改变，请重新读取设置');
      if (body.schemaVersion !== undefined && body.schemaVersion !== descriptor.schemaVersion) throw new PluginApiError('E_CONFLICT', '设置 schema 版本已改变');
      for (const [key, spec] of Object.entries(descriptor.settings)) {
        const value = body.config[key];
        if (value === undefined) continue;
        if (spec.type === 'array' ? !Array.isArray(value) : spec.type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== spec.type) throw new PluginApiError('E_INVALID_INPUT', key + ' 类型必须为 ' + spec.type);
      }
      const owned = config.pluginConfig ??= {};
      const previous = owned[id];
      owned[id] = body.config;
      const existing = manager.getComposition().entries.find(e => e.id === id);
      try { await manager.upsertCompositionInstance({ id, name: descriptor.pluginId, disabled: existing?.disabled, bindings: existing?.bindings, config: {} }); }
      catch (error) { if (previous === undefined) delete owned[id]; else owned[id] = previous; throw error; }
      saveConfig(paths.configPath, config); changed();
      return { settings: describe(id), activation: { status: 'applied', restartRequired: false } };
    } catch (e) { const code = (e as { code?: string }).code; return reply.code(code === 'E_CONFLICT' ? 409 : 400).send({ error: String(e), code }); }
  });
  app.get('/api/v1/plugins/host-config', async () => ({ port: config.port, dataRoot: paths.dataDir,
    schema: { port: { type: 'number', minimum: 0, maximum: 65535 }, dataRoot: { type: 'string', startupOnly: true } },
    restartRequired: false }));
  app.put('/api/v1/plugins/host-config', async (req, reply) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return reply.code(403).send({ error: '仅本机可修改启动配置' });
    const body = req.body as { port?: number; dataRoot?: string };
    if (body.port !== undefined && (!Number.isInteger(body.port) || body.port < 0 || body.port > 65535)) return reply.code(400).send({ error: '端口范围为 0–65535' });
    if (body.dataRoot !== undefined && !/^(?:[a-z]:[\\/]|\/)/i.test(body.dataRoot)) return reply.code(400).send({ error: '数据根需要绝对路径' });
    if (body.port !== undefined) config.port = body.port;
    saveConfig(paths.configPath, config);
    return { status: 'restart_required', restartRequired: true, reason: '启动参数在新进程生效；数据根切换保留原目录',
      launch: { executable: process.execPath, args: process.argv.slice(1), env: { ...(process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}), HARNESSMATE_DATA_DIR: body.dataRoot ?? paths.dataDir, HARNESSMATE_PORT: String(body.port ?? config.port) } } };
  });
}
