import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PluginApiError,
  isBuiltinPublicService,
  isReservedServiceName,
  isThirdPartyCustomServiceName,
  normalizePluginSlotKey,
  type PluginEventV4,
} from '@harnessmate/plugin-api';
import {
  HarnessCommandNameSchema,
  GeneratedPluginManifestSchema,
  PluginManifestSchema,
  type Attachment,
  type CanonicalEvent,
  type InstalledPluginInfo,
  type InstallPluginRequest,
  type PluginCatalogItem,
  type PluginLogEntryDto,
  type PluginManifest,
  type PluginMcpPreset,
  type PluginSlashCommand,
  type ScaffoldPluginRequest,
} from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { MANIFEST_FILE, manifestPluginPackage, readPluginPackage, readRevisionPointer, requiresPluginTrust, revisionDirectory, writeRevision,
  writeRevisionPointer, type PluginPackage } from './plugin-package.js';
import { PluginRuntime } from './plugin-runtime.js';
import { normalizePluginManifest } from '../plugin-host/manifest/normalize.js';
import { PluginHost, type HostPlugin } from '../plugin-host/runtime/lifecycle.js';
import { toPluginEvent } from '../plugin-host/runtime/map-event.js';
import { PluginComposition } from '../plugin-host/composition/profile.js';
import { BUILTIN_PLUGINS } from '../plugin-host/builtin/manifests.js';
import { IsolatedPluginManager } from '../plugin-host/isolation/isolated-manager.js';
import type { CrashPolicy } from '../plugin-host/isolation/isolated-process.js';
import { GLOBAL_WORKSPACE_SCOPE, PluginPermissionService } from '../plugin-host/permissions/permissions.js';
import { CURATED_PLUGIN_CATALOG } from './plugin-catalog.js';
import { PluginDevWatcher } from './plugin-dev-mode.js';
import { PluginRegistryService } from './plugin-registry.js';
import { buildScaffoldFiles, writeScaffoldToDirectory } from './plugin-scaffold.js';

export interface PluginTurnHookContext {
  sessionId: string;
  harnessId: string;
  cwd: string;
  text: string;
  attachments?: Attachment[];
}

interface LoadedPluginRecord {
  info: InstalledPluginInfo;
  runtime?: PluginRuntime;
  packageRoot?: string;
  digest?: string;
}

export class PluginRevisionConflictError extends PluginApiError {
  constructor() {
    super('E_CONFLICT', '已安装的插件版本已变更，请重新预览后再安装');
  }
}

export interface PluginManagerOptions {
  store?: HarnessMateStore;
  permissions?: PluginPermissionService;
  crashPolicy?: CrashPolicy;
  onDevReload?: () => void;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPluginRecord>();
  private readonly pluginHarnesses = new Map<string, { adapter: HarnessAdapter; config: string }>();
  private mutation = Promise.resolve();
  private registryChanged = false;
  private readonly composition: PluginComposition;
  private compositionError?: string;
  private readonly restartGeneration = new Map<string, number>();
  private readonly permissionRevision = new Map<string, number>();
  private readonly hostLogs = new Map<string, PluginLogEntryDto[]>();
  private readonly dataDir: string;
  readonly host = new PluginHost((error) => console.error('插件生命周期错误', error));
  readonly permissions?: PluginPermissionService;
  readonly isolated?: IsolatedPluginManager;
  readonly registryService: PluginRegistryService;
  readonly devWatcher: PluginDevWatcher;

  constructor(
    private readonly pluginsDir: string,
    private readonly registry: HarnessRegistry,
    private readonly getDisabledIds: () => string[],
    private readonly firstParty: ReadonlyMap<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>> = new Map(),
    options?: PluginManagerOptions,
  ) {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    this.pluginsDir = fs.realpathSync(this.pluginsDir);
    this.dataDir = path.dirname(this.pluginsDir);
    this.composition = new PluginComposition(this.dataDir, BUILTIN_PLUGINS.map(({ id }) => id));
    this.registryService = new PluginRegistryService(this.dataDir);
    this.devWatcher = new PluginDevWatcher(this.dataDir, (pluginId, filename) => {
      this.appendHostLog(pluginId, 'info', `检测到源码变更${filename ? ` (${filename})` : ''}，正在热重载…`);
      void this.reloadDevPlugin(pluginId).catch((err: unknown) => {
        this.appendHostLog(pluginId, 'error', `开发模式热重载失败: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => options?.onDevReload?.());
    });
    if (options?.store) {
      this.permissions = options.permissions ?? new PluginPermissionService(options.store);
      this.isolated = new IsolatedPluginManager({
        store: options.store,
        host: this.host,
        permissions: this.permissions,
        getPluginInfo: (pluginId) => this.plugins.get(pluginId)?.info,
        requestRestart: (pluginId) => this.restartIsolatedPlugin(pluginId),
        crashPolicy: options.crashPolicy,
      });
    }
  }

  appendHostLog(
    pluginId: string,
    level: PluginLogEntryDto['level'],
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const list = this.hostLogs.get(pluginId) ?? [];
    list.push({
      timestamp: Date.now(),
      pluginId,
      runId: this.isolated?.getRunId(pluginId) ?? 'host',
      level,
      source: 'host',
      message: message.slice(0, 2000),
      meta,
    });
    if (list.length > 200) list.splice(0, list.length - 200);
    this.hostLogs.set(pluginId, list);
  }

  getLogs(pluginId: string): PluginLogEntryDto[] {
    const hostEntries = this.hostLogs.get(pluginId) ?? [];
    const pluginEntries: PluginLogEntryDto[] = (this.isolated?.getLogs(pluginId) ?? []).map((entry) => ({
      ...entry,
      source: 'plugin',
    }));
    return [...hostEntries, ...pluginEntries].sort((a, b) => a.timestamp - b.timestamp);
  }

  getAllLogs(): PluginLogEntryDto[] {
    const hostEntries = [...this.hostLogs.values()].flat();
    const pluginEntries: PluginLogEntryDto[] = (this.isolated?.getAllLogs() ?? []).map((entry) => ({
      ...entry,
      source: 'plugin',
    }));
    return [...hostEntries, ...pluginEntries].sort((a, b) => a.timestamp - b.timestamp).slice(-400);
  }

  clearLogs(pluginId?: string): void {
    if (pluginId) this.hostLogs.delete(pluginId);
    else this.hostLogs.clear();
    this.isolated?.clearLogs(pluginId);
  }

  private restartIsolatedPlugin(pluginId: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.plugins.has(pluginId)) return;
      this.restartGeneration.set(pluginId, (this.restartGeneration.get(pluginId) ?? 0) + 1);
      await this.activate(this.plugins);
    });
  }

  reconcilePermissionsChange(pluginId: string): Promise<void> {
    return this.serialize(async () => {
      const record = this.plugins.get(pluginId);
      if (!record?.info.main) return;
      this.isolated?.clearCrashHistory(pluginId);
      this.permissionRevision.set(pluginId, (this.permissionRevision.get(pluginId) ?? 0) + 1);
      await this.activate(this.plugins);
    });
  }

  private installedNames(records = this.plugins): string[] {
    return [...records.values()].filter(({ info }) => !info.builtin && !info.id.startsWith('broken.')).map(({ info }) => info.id);
  }

  getComposition() {
    return { ...this.composition.resolve(this.installedNames()), error: this.compositionError };
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  takeRegistryChanged(): boolean {
    const changed = this.registryChanged;
    this.registryChanged = false;
    return changed;
  }

  reloadAll(): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      await this.loadRegistry();
      return this.listInstalled();
    });
  }

  private async loadRegistry(): Promise<void> {
    const next = new Map<string, LoadedPluginRecord>();
    try {
      this.composition.reload(this.getDisabledIds());
      this.compositionError = undefined;
    } catch (error) {
      this.compositionError = error instanceof Error ? error.message : String(error);
    }

    for (const manifest of BUILTIN_PLUGINS) {
      const enabled = this.desiredEnabled(manifest.id, true);
      next.set(manifest.id, {
        info: {
          ...manifest,
          builtin: true,
          enabled,
          sourcePath: null,
          hasRuntimeHook: Boolean(manifest.contributes.hooks?.length),
          loadError: null,
        },
      });
    }

    const directories = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const root = path.join(this.pluginsDir, entry.name);
      let manifest: PluginManifest | undefined;
      try {
        const pointer = readRevisionPointer(root);
        const directory = pointer ? revisionDirectory(root, pointer.current) : root;
        if (!pointer && !fs.existsSync(path.join(root, MANIFEST_FILE))) continue;
        const pack = readPluginPackage(directory);
        manifest = pack.manifest;
        if (pointer?.currentDigest && pointer.currentDigest !== pack.digest) {
          throw new Error('插件文件已变更，请重新预览并安装');
        }
        this.checkPackageTrust(pack, pointer?.currentDigest, pointer?.currentTrusted);
        if (next.has(pack.manifest.id)) throw new Error('插件 ID 重复');
        this.validateManifest(pack.manifest, next);
        const enabled = this.desiredEnabled(pack.manifest.id, false);
        const record = await this.prepare(pack, directory, root, enabled, Boolean(pointer?.previous));
        next.set(pack.manifest.id, record);
      } catch (error) {
        const previous = [...this.plugins.values()].find((record) => record.info.sourcePath === root);
        const message = error instanceof Error ? error.message : String(error);
        if (previous && !next.has(previous.info.id) && !previous.runtime?.failed && !requiresPluginTrust(previous.info)) {
          previous.info.loadError = message;
          next.set(previous.info.id, previous);
        } else {
          const preferredId = previous?.info.id ?? manifest?.id;
          const id = preferredId && !next.has(preferredId) && !preferredId.startsWith('core.')
            ? preferredId : `broken.${entry.name}`;
          next.set(id, { info: {
            ...previous?.info,
            id, name: previous?.info.name ?? manifest?.name ?? entry.name,
            version: previous?.info.version ?? manifest?.version ?? '0.0.0',
            description: previous?.info.description ?? manifest?.description ?? '插件加载失败',
            category: previous?.info.category ?? manifest?.category ?? 'workflow',
            contributes: previous?.info.contributes ?? {}, builtin: false, enabled: false,
            sourcePath: root, hasRuntimeHook: false, loadError: message,
            canRollback: Boolean(this.tryPrevious(root)),
          } });
        }
      }
    }

    // Load locally linked dev-mode plugins directly from source directories (auto-reloaded on file save)
    for (const devLink of this.devWatcher.list()) {
      try {
        if (!fs.existsSync(devLink.dirPath)) {
          throw new Error(`开发目录不存在: ${devLink.dirPath}`);
        }
        const pack = readPluginPackage(devLink.dirPath);
        if (pack.manifest.id !== devLink.id) {
          throw new Error(`开发目录清单 ID (${pack.manifest.id}) 与已关联 ID (${devLink.id}) 不一致`);
        }
        const occupied = new Map(next);
        occupied.delete(pack.manifest.id);
        this.validateManifest(pack.manifest, occupied);
        const enabled = this.desiredEnabled(pack.manifest.id, false);
        const record = await this.prepare(pack, devLink.dirPath, devLink.dirPath, enabled, false);
        record.info.devMode = true;
        record.info.devSourceDir = devLink.dirPath;
        next.set(pack.manifest.id, record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendHostLog(devLink.id, 'error', `开发插件加载失败: ${message}`);
        next.set(devLink.id, {
          info: {
            id: devLink.id,
            name: devLink.id,
            version: '0.0.0-dev',
            description: '开发模式插件加载失败',
            category: 'workflow',
            contributes: {},
            builtin: false,
            enabled: false,
            sourcePath: devLink.dirPath,
            devMode: true,
            devSourceDir: devLink.dirPath,
            hasRuntimeHook: false,
            loadError: message,
          },
        });
      }
    }
    this.devWatcher.startAllWatchers();

    await this.activate(next);
  }

  private tryPrevious(root: string): string | undefined {
    try { return readRevisionPointer(root)?.previous; } catch { return undefined; }
  }

  private async activate(next: Map<string, LoadedPluginRecord>): Promise<void> {
    const previousAdapters = this.registry.listAdapters();
    const composition = this.composition.resolve(this.installedNames(next));
    const entries = new Map(composition.entries.map((entry) => [entry.name, entry]));
    const ranked = [...next.values()].sort((first, second) =>
      composition.entries.findIndex(({ name }) => name === first.info.id) -
      composition.entries.findIndex(({ name }) => name === second.info.id));
    const definitions: HostPlugin[] = ranked.map(({ info, digest, packageRoot }) => {
      const entry = entries.get(info.id);
      const core = this.firstParty.get(info.id);
      const revision = JSON.stringify([
        digest,
        entry?.config,
        info.inject,
        info.provides,
        this.restartGeneration.get(info.id) ?? 0,
        this.permissionRevision.get(info.id) ?? 0,
      ]);
      if (!info.builtin && info.main && packageRoot && digest && this.isolated) {
        return this.isolated.createHostPlugin({
          info,
          packageRoot,
          entryRelativePath: info.main,
          digest,
          enabled: info.enabled,
          config: entry?.config,
          revision,
        });
      }
      return { id: info.id, enabled: info.enabled, revision,
        error: info.loadError && !packageRoot && !info.builtin ? info.loadError : undefined,
        inject: core?.inject ?? info.inject, provides: core?.provides, apply: core?.apply ?? (() => {}),
        config: entry?.config };
    });
    await this.host.reconcileAsync(definitions);
    const wanted = new Map<string, NonNullable<PluginManifest['contributes']['harnesses']>[number]>();
    for (const rec of next.values()) {
      if (!rec.info.enabled || this.host.status(rec.info.id)?.state !== 'ACTIVE' || !this.host.get('harness.acp')) continue;
      for (const config of rec.info.contributes.harnesses ?? []) wanted.set(config.id, config);
    }
    for (const [id, record] of this.pluginHarnesses) {
      if (!wanted.has(id)) {
        if (this.registry.get(id) === record.adapter) this.registry.unregister(id);
        this.pluginHarnesses.delete(id);
        this.registryChanged = true;
      }
    }
    for (const [id, config] of wanted) {
      const old = this.pluginHarnesses.get(id);
      const current = this.registry.get(id);
      if (current && current !== old?.adapter) continue;
      const signature = JSON.stringify(config);
      if (current && old?.config === signature) continue;
      this.registry.registerCustomAcp(config);
      this.pluginHarnesses.set(id, { adapter: this.registry.get(id)!, config: signature });
      this.registryChanged = true;
    }
    for (const [id, record] of this.plugins) {
      if (record.runtime !== next.get(id)?.runtime) record.runtime?.retire();
    }
    this.plugins = next;
    const adapters = this.registry.listAdapters();
    this.registryChanged ||= adapters.length !== previousAdapters.length ||
      previousAdapters.some((adapter) => this.registry.get(adapter.id) !== adapter);
  }

  private desiredEnabled(id: string, builtin: boolean): boolean {
    const installed = this.installedNames();
    if (!builtin && !installed.includes(id)) installed.push(id);
    const entry = this.composition.resolve(installed).entries.find(({ name }) => name === id);
    return entry ? !entry.disabled : !builtin;
  }

  private async prepare(pack: PluginPackage, directory: string, root: string, enabled: boolean, canRollback: boolean) {
    const record: LoadedPluginRecord = {
      info: { ...pack.manifest, builtin: false, enabled, sourcePath: root, canRollback, loadError: null, packageDigest: pack.digest },
      packageRoot: directory,
      digest: pack.digest,
    };
    if (enabled && pack.manifest.entry) {
      const old = this.plugins.get(pack.manifest.id);
      if (old?.packageRoot === directory && old.digest === pack.digest && old.runtime?.reusable) {
        record.runtime = old.runtime;
      } else {
        const runtime = new PluginRuntime(path.join(directory, pack.manifest.entry.replace(/\\/g, '/')), (error) => {
          const active = this.plugins.get(pack.manifest.id);
          if (active?.runtime === runtime) active.info.loadError = error.message;
        });
        try {
          await runtime.initialize();
          if (!runtime.hooks.length) throw new Error('入口需导出 beforeTurn 或 onEvent');
          record.runtime = runtime;
        } catch (error) {
          runtime.retire();
          throw error;
        }
      }
      record.info.hasRuntimeHook = true;
    }
    return record;
  }

  validateManifest(manifest: PluginManifest, occupied = this.plugins): void {
    const normalized = normalizePluginManifest(manifest);
    if (manifest.id.startsWith('core.') || manifest.id.startsWith('broken.')) throw new Error('插件 ID 使用了保留前缀');
    for (const service of normalized.provides ?? []) {
      if (isReservedServiceName(service)) {
        throw new PluginApiError('E_PERMISSION_DENIED', `服务 ${service} 为内置核心服务，不允许第三方提供`);
      }
      if (isBuiltinPublicService(service)) {
        if (!normalized.permissions?.includes(`service:provide:${service}`)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `替换公共服务 ${service} 必须在 permissions 中声明 service:provide:${service}`);
        }
      } else if (!isThirdPartyCustomServiceName(service)) {
        throw new PluginApiError('E_INVALID_INPUT', `第三方服务 ${service} 必须带命名空间前缀，例如 acme.service`);
      }
    }
    if (normalized.provides?.length && !normalized.main) {
      throw new PluginApiError('E_INVALID_INPUT', '提供服务的插件必须声明 main 代码入口');
    }
    const other = [...occupied.values()].filter(({ info }) => info.id !== manifest.id);
    const commands = new Set<string>([...HarnessCommandNameSchema.options, 'quota', 'plugins']);
    const contributedHarnesses = new Set<string>();
    const commandNames = (plugin: PluginManifest) => [
      ...(plugin.contributes.slashCommands ?? []).map(({ command }) => command),
      ...(plugin.contributes.commands ?? []).map(({ command }) => command),
      ...(plugin.contributes.actions ?? []).map(({ command }) => command),
      ...(plugin.contributes.dataPanels ?? []).flatMap(({ copySummary }) => copySummary?.command ? [copySummary.command] : []),
    ];
    for (const { info } of other) {
      for (const name of commandNames(info)) commands.add(name);
      for (const config of info.contributes.harnesses ?? []) contributedHarnesses.add(config.id);
    }
    const owns = new Set((occupied.get(manifest.id)?.info.contributes.harnesses ?? []).map(({ id }) => id));
    for (const name of commandNames(manifest)) {
      if (commands.has(name)) throw new Error(`指令 /${name} 已被占用`);
      commands.add(name);
    }
    for (const config of manifest.contributes.harnesses ?? []) {
      const current = this.registry.get(config.id);
      const owned = (owns.has(config.id) || this.plugins.get(manifest.id)?.info.contributes.harnesses?.some(({ id }) => id === config.id))
        && this.pluginHarnesses.get(config.id)?.adapter === current;
      if (this.registry.isReserved(config.id) || contributedHarnesses.has(config.id) || (current && !owned)) {
        throw new Error(`Harness ID ${config.id} 已被占用`);
      }
      contributedHarnesses.add(config.id);
    }
    const panelIds = new Set<string>();
    const ownCommands = new Set(manifest.contributes.slashCommands?.map(({ command }) => command));
    for (const panel of manifest.contributes.panels ?? []) {
      if (panelIds.has(panel.id)) throw new Error(`面板 ID ${panel.id} 重复`);
      panelIds.add(panel.id);
      for (const action of panel.actions) {
        if (!ownCommands.has(action.command)) throw new Error(`面板操作必须引用本插件的指令 /${action.command}`);
      }
    }
    const { projections, dataPanels, actions, programs } = normalized.contributes;
    const programIds = new Set(programs?.map(({ id }) => id));
    if (programIds.size !== (programs?.length ?? 0)) throw new Error('插件处理程序 ID 不能重复');
    for (const action of actions ?? []) {
      if (action.kind === 'program' && !programIds.has(action.program)) {
        throw new Error(`动作 /${action.command} 引用了不存在的处理程序 ${action.program}`);
      }
    }
    const projectionIds = new Set<string>();
    for (const projection of projections ?? []) {
      if (projectionIds.has(projection.id)) throw new Error(`事件投影 ID ${projection.id} 重复`);
      if (new Set(projection.events).size !== projection.events.length) throw new Error(`事件投影 ${projection.id} 含有重复事件`);
      projectionIds.add(projection.id);
    }
    for (const panel of dataPanels ?? []) {
      if (panelIds.has(panel.id)) throw new Error(`面板 ID ${panel.id} 重复`);
      if (!projectionIds.has(panel.projection)) throw new Error(`面板 ${panel.id} 引用了不存在的事件投影 ${panel.projection}`);
      if (panel.defaultEvent && (!panel.filters?.includes('status') ||
        !projections?.find(({ id }) => id === panel.projection)?.events.includes(panel.defaultEvent))) {
        throw new Error(`面板 ${panel.id} 的默认事件需要状态筛选器与对应的投影事件`);
      }
      if (new Set(panel.columns.map(({ field }) => field)).size !== panel.columns.length) throw new Error(`面板 ${panel.id} 含有重复列`);
      panelIds.add(panel.id);
    }
    const slotKeys = new Set<string>();
    for (const slot of normalized.contributes.slots ?? []) {
      const slotKey = `${normalizePluginSlotKey(slot.slot)}:${slot.id}`;
      if (slotKeys.has(slotKey)) throw new Error(`UI 插槽项 ${slotKey} 重复`);
      slotKeys.add(slotKey);
    }
  }

  getPluginPackageRoot(pluginId: string): { packageRoot: string; digest?: string; runId?: string } | undefined {
    const rec = this.plugins.get(pluginId);
    if (!rec || !rec.packageRoot || !this.isPluginEnabled(pluginId)) return undefined;
    return {
      packageRoot: rec.packageRoot,
      digest: rec.digest,
      runId: this.isolated?.getRunId(pluginId),
    };
  }

  getDataPanel(pluginId: string, panelId: string) {
    const plugin = this.plugins.get(pluginId)?.info;
    if (!plugin || !this.isPluginEnabled(pluginId)) return undefined;
    const panel = plugin.contributes.dataPanels?.find(({ id }) => id === panelId);
    const projection = plugin.contributes.projections?.find(({ id }) => id === panel?.projection);
    return panel && projection ? { panel, projection } : undefined;
  }

  listInstalled(): InstalledPluginInfo[] {
    return [...this.plugins.values()].map(({ info, runtime }) => {
      const status = this.host.status(info.id);
      const runId = this.isolated?.getRunId(info.id);
      const runtimeSlots = this.isolated?.listSlots(info.id);
      const runtimeMode = info.builtin ? 'kernel' : (info.main || info.entry) ? 'isolated' : 'declarative';
      return {
        ...info,
        runtimeState: runtime?.failed ? 'FAILED' : status?.state,
        missingServices: status?.missingServices,
        loadError: status?.error ?? info.loadError,
        ...(runId ? { runId } : {}),
        ...(runtimeSlots?.length ? { runtimeSlots } : {}),
        runtimeMode,
      };
    });
  }

  listCatalog(): PluginCatalogItem[] {
    const builtinItems: PluginCatalogItem[] = CURATED_PLUGIN_CATALOG.map((item) => ({
      ...item,
      installed: this.plugins.has(item.id),
      source: 'builtin',
      compatible: true,
      incompatibleReason: null,
    }));
    const remoteItems: PluginCatalogItem[] = this.registryService.listEntries().map((item) => ({
      id: item.entry.id,
      name: item.entry.name,
      version: item.entry.version,
      description: item.entry.description,
      author: item.entry.author ?? item.publisherName,
      category: item.entry.category,
      engines: item.entry.engines,
      contributes: {},
      installed: this.plugins.has(item.entry.id),
      tags: item.entry.tags,
      source: 'remote',
      registryUrl: item.registryUrl,
      publisherId: item.entry.publisherId,
      publisherName: item.publisherName,
      packageDigest: item.entry.packageDigest,
      signatureStatus: item.signatureStatus,
      compatible: item.compatible,
      incompatibleReason: item.incompatibleReason,
    }));
    return [...remoteItems, ...builtinItems];
  }

  isPluginEnabled(id: string): boolean {
    const rec = this.plugins.get(id);
    return Boolean(rec?.info.enabled && this.host.status(id)?.state === 'ACTIVE' && !rec.runtime?.failed);
  }

  listActiveSlashCommands(): Array<PluginSlashCommand & { pluginId: string; pluginName: string }> {
    const cmds: Array<PluginSlashCommand & { pluginId: string; pluginName: string }> = [];
    for (const rec of this.plugins.values()) {
      if (!this.isPluginEnabled(rec.info.id)) continue;
      for (const cmd of rec.info.contributes.slashCommands ?? []) {
        cmds.push({
          ...cmd,
          pluginId: rec.info.id,
          pluginName: rec.info.name,
        });
      }
    }
    return cmds;
  }

  listActiveMcpPresets(): Array<PluginMcpPreset & { pluginId: string; pluginName: string }> {
    const presets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }> = [];
    for (const rec of this.plugins.values()) {
      if (!this.isPluginEnabled(rec.info.id)) continue;
      for (const preset of rec.info.contributes.mcpPresets ?? []) {
        presets.push({
          ...preset,
          pluginId: rec.info.id,
          pluginName: rec.info.name,
        });
      }
    }
    return presets;
  }

  togglePlugin(id: string, enabled: boolean): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const record = this.plugins.get(id);
      if (!record) throw new Error(`Plugin not found: ${id}`);
      let candidate: LoadedPluginRecord = { ...record, info: { ...record.info, enabled }, runtime: undefined };
      if (enabled && !record.info.builtin) {
        if (!record.packageRoot) throw new Error('请先修复或回退损坏的插件');
        const pack = readPluginPackage(record.packageRoot);
        if (!record.info.devMode && record.digest !== pack.digest) throw new Error('插件文件已变更，请重新预览并安装');
        const occupied = new Map(this.plugins);
        occupied.delete(id);
        this.validateManifest(pack.manifest, occupied);
        candidate = await this.prepare(pack, record.packageRoot, record.info.sourcePath!, true, Boolean(record.info.canRollback));
        if (record.info.devMode) {
          candidate.info.devMode = true;
          candidate.info.devSourceDir = record.info.devSourceDir;
        }
      }
      try {
        if (this.compositionError) throw new PluginApiError('E_INVALID_INPUT', this.compositionError);
        this.composition.setEnabled(id, enabled, this.installedNames());
      } catch (error) {
        if (candidate.runtime !== record.runtime) candidate.runtime?.retire();
        throw error;
      }
      if (enabled) this.isolated?.clearCrashHistory(id);
      await this.activate(new Map(this.plugins).set(id, candidate));
      return this.listInstalled();
    });
  }

  private checkInstalledDigest(id: string, expected: string | null | undefined) {
    const current = this.plugins.get(id);
    if (expected !== undefined && expected !== (current?.digest ?? null)) throw new PluginRevisionConflictError();
    return current;
  }

  getAuthoringBase(id: string, digest: string): PluginManifest {
    const current = this.checkInstalledDigest(id, digest);
    if (!current || current.info.builtin) throw new Error('找不到可修改的插件');
    return GeneratedPluginManifestSchema.parse(PluginManifestSchema.parse(current.info));
  }

  reviewManifest(manifest: PluginManifest, expectedInstalledDigest?: string | null) {
    const current = this.checkInstalledDigest(manifest.id, expectedInstalledDigest);
    this.validateManifest(manifest);
    return {
      manifest,
      installedVersion: current?.info.version,
      installedManifest: current?.packageRoot ? PluginManifestSchema.parse(current.info) : undefined,
      installedDigest: current?.digest ?? null,
      installedEnabled: current?.info.enabled,
      missingServices: manifest.inject?.filter((name) => !this.host.get(name)) ?? [],
    };
  }

  inspectPackage(directory: string, expectedInstalledDigest?: string | null) {
    const { manifest, digest, files } = readPluginPackage(directory);
    return { ...this.reviewManifest(manifest, expectedInstalledDigest), digest, fileCount: files.size };
  }

  private checkPackageTrust(pack: PluginPackage, digest?: string, trusted?: boolean): void {
    const manifest = pack.manifest;
    const legacyCodeApproval = manifest.entry && !manifest.contributes.harnesses?.length && !manifest.contributes.mcpPresets?.length;
    if (requiresPluginTrust(manifest) && (digest !== pack.digest || !(trusted || legacyCodeApproval))) {
      throw new Error('请在插件中心重新预览并确认信任此插件包');
    }
  }

  private resolveInstallPackage(req: InstallPluginRequest): PluginPackage {
    if (req.mode === 'remote_index') {
      throw new PluginApiError('E_INVALID_INPUT', '远程索引插件请使用异步预览或安装接口');
    }
    if (req.mode === 'local_dir') return readPluginPackage(req.dirPath);
    const source = req.mode === 'manifest' ? req.manifest : CURATED_PLUGIN_CATALOG.find(({ id }) => id === req.catalogId);
    if (!source) throw new Error('找不到目录中的插件');
    const manifest = PluginManifestSchema.parse(source);
    if (manifest.entry || manifest.main) throw new Error('带 JavaScript 入口的插件必须通过本地目录导入');
    return manifestPluginPackage(manifest);
  }

  private async resolveInstallPackageAsync(req: InstallPluginRequest): Promise<PluginPackage> {
    if (req.mode === 'remote_index') {
      const { pack } = await this.registryService.resolveRemotePackage(req.pluginId, req.version, {
        allowUntrusted: req.allowUntrusted,
      });
      return pack;
    }
    return this.resolveInstallPackage(req);
  }

  previewInstall(req: InstallPluginRequest) {
    const { manifest, files, digest } = this.resolveInstallPackage(req);
    return { ...this.reviewManifest(manifest, req.expectedInstalledDigest), digest, fileCount: files.size,
      requiresTrust: requiresPluginTrust(manifest) };
  }

  async previewInstallAsync(req: InstallPluginRequest) {
    const { manifest, files, digest } = await this.resolveInstallPackageAsync(req);
    return { ...this.reviewManifest(manifest, req.expectedInstalledDigest), digest, fileCount: files.size,
      requiresTrust: requiresPluginTrust(manifest) };
  }

  installPlugin(req: InstallPluginRequest): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const pack = await this.resolveInstallPackageAsync(req);
      if (req.expectedDigest && req.expectedDigest !== pack.digest) throw new Error('插件文件已更改，请重新预览');
      const trusted = requiresPluginTrust(pack.manifest);
      if (trusted && (!req.trustCode || !req.expectedDigest)) throw new Error('请预览并确认信任此插件包');
      this.validateManifest(pack.manifest);
      const id = pack.manifest.id;
      this.appendHostLog(id, 'info', `正在安装插件 v${pack.manifest.version} (${req.mode})`);
      const old = this.checkInstalledDigest(id, req.expectedInstalledDigest);
      const broken = [...this.plugins.values()].find(({ info }) => info.id === `broken.${id}`);
      const root = old?.info.sourcePath ?? broken?.info.sourcePath ?? path.join(this.pluginsDir, id);
      this.checkPluginRoot(root);
      const pointer = readRevisionPointer(root);
      const legacy = !pointer && old?.packageRoot ? readPluginPackage(old.packageRoot) : undefined;
      const previous = pointer?.current ?? (legacy ? writeRevision(root, legacy.files) : undefined);
      const previousDigest = pointer?.currentDigest ?? old?.digest ?? legacy?.digest;
      const revision = writeRevision(root, pack.files);
      const directory = revisionDirectory(root, revision);
      const enabled = this.desiredEnabled(id, false);
      let candidate: LoadedPluginRecord | undefined;
      try {
        const saved = readPluginPackage(directory);
        if (saved.digest !== pack.digest) throw new PluginApiError('E_CONFLICT', '待安装插件包内容发生变化');
        candidate = await this.prepare(saved, directory, root, true, Boolean(previous));
        if (!enabled) {
          candidate.runtime?.retire();
          candidate = { ...candidate, runtime: undefined, info: { ...candidate.info, enabled, hasRuntimeHook: false } };
        }
        writeRevisionPointer(root, { current: revision, previous, currentDigest: candidate.digest, previousDigest,
          currentTrusted: trusted, previousTrusted: pointer?.currentTrusted });
      } catch (error) {
        candidate?.runtime?.retire();
        this.removeRevision(root, revision);
        if (!pointer && previous) this.removeRevision(root, previous);
        throw error;
      }
      this.isolated?.clearCrashHistory(id);
      const next = new Map(this.plugins);
      for (const [otherId, record] of next) {
        if (otherId !== id && otherId.startsWith('broken.') && record.info.sourcePath === root) next.delete(otherId);
      }
      await this.activate(next.set(id, candidate));
      // Transactional check for V4 main plugins: if activation failed for non-permission/non-conflict reason, rollback!
      const status = this.host.status(id);
      const awaitingProvidePermission = (candidate.info.provides ?? []).some(
        (service) => isBuiltinPublicService(service) && !this.permissions?.isGranted(candidate.info, `service:provide:${service}`, GLOBAL_WORKSPACE_SCOPE),
      );
      const provideConflict = (candidate.info.provides ?? []).some((service) => Boolean(this.host.get(service)));
      if (enabled && candidate.info.main && status?.state === 'FAILED' && !awaitingProvidePermission && !provideConflict) {
        const failMessage = status.error ?? '隔离插件激活失败';
        await this.isolated?.awaitPendingDisposals();
        if (pointer) {
          writeRevisionPointer(root, pointer);
        } else if (previous) {
          writeRevisionPointer(root, { current: previous, currentDigest: previousDigest, currentTrusted: Boolean(old && requiresPluginTrust(old.info)) });
        } else {
          try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup */ }
        }
        this.removeRevision(root, revision);
        const restored = new Map(this.plugins);
        if (old) restored.set(id, old);
        else restored.delete(id);
        await this.activate(restored);
        throw new Error(failMessage);
      }
      if (pointer?.previous) this.removeRevision(root, pointer.previous);
      return this.listInstalled();
    });
  }

  rollbackPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const root = this.plugins.get(id)?.info.sourcePath;
      const pointer = root ? readRevisionPointer(root) : undefined;
      if (!root || !pointer?.previous) throw new Error('没有可回退的版本');
      this.checkPluginRoot(root);
      const directory = revisionDirectory(root, pointer.previous);
      const pack = readPluginPackage(directory);
      if (pointer.previousDigest && pointer.previousDigest !== pack.digest) {
        throw new Error('回退版本的插件文件已变更，请重新预览并安装');
      }
      if (pack.manifest.id !== id) throw new Error('回退版本的插件 ID 不匹配');
      this.checkPackageTrust(pack, pointer.previousDigest, pointer.previousTrusted);
      this.validateManifest(pack.manifest);
      const candidate = await this.prepare(pack, directory, root, this.desiredEnabled(pack.manifest.id, false), true);
      try {
        writeRevisionPointer(root, { current: pointer.previous, previous: pointer.current,
          currentDigest: pack.digest, previousDigest: pointer.currentDigest,
          currentTrusted: pointer.previousTrusted, previousTrusted: pointer.currentTrusted });
      } catch (error) {
        candidate.runtime?.retire();
        throw error;
      }
      this.isolated?.clearCrashHistory(id);
      const next = new Map(this.plugins);
      next.delete(id);
      next.set(pack.manifest.id, candidate);
      await this.activate(next);
      return this.listInstalled();
    });
  }

  uninstallPlugin(id: string): Promise<InstalledPluginInfo[]> {
    if (this.devWatcher.has(id) || this.plugins.get(id)?.info.devMode) {
      return this.unlinkDevPlugin(id);
    }
    return this.serialize(async () => {
      const root = this.plugins.get(id)?.info.sourcePath;
      if (!root) throw new Error('只能卸载外部插件');
      this.checkPluginRoot(root);
      this.isolated?.clearCrashHistory(id);
      const previous = new Map(this.plugins);
      const next = new Map(this.plugins);
      next.delete(id);
      // Stop any isolated child process holding a CWD handle inside `root` before renaming/deleting on Windows.
      await this.activate(next);
      await this.isolated?.awaitPendingDisposals();
      const removed = path.join(this.pluginsDir, `.uninstalled-${randomUUID()}`);
      try {
        fs.renameSync(root, removed);
        try {
          if (!this.compositionError) this.composition.removePlugin(id);
        } catch (error) {
          fs.renameSync(removed, root);
          throw error;
        }
      } catch (error) {
        await this.activate(previous);
        throw error;
      }
      try { fs.rmSync(removed, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Loaded files may still be open. */ }
      this.appendHostLog(id, 'info', '插件已卸载');
      return this.listInstalled();
    });
  }

  linkDevPlugin(dirPath: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const resolvedDir = fs.realpathSync(dirPath);
      const pack = readPluginPackage(resolvedDir);
      const occupied = new Map(this.plugins);
      occupied.delete(pack.manifest.id);
      this.validateManifest(pack.manifest, occupied);
      this.devWatcher.link(pack.manifest.id, resolvedDir);
      this.isolated?.clearCrashHistory(pack.manifest.id);
      const enabled = this.desiredEnabled(pack.manifest.id, false);
      const candidate = await this.prepare(pack, resolvedDir, resolvedDir, enabled, false);
      candidate.info.devMode = true;
      candidate.info.devSourceDir = resolvedDir;
      const next = new Map(this.plugins);
      next.set(pack.manifest.id, candidate);
      await this.activate(next);
      this.appendHostLog(pack.manifest.id, 'info', `已关联开发目录: ${resolvedDir}`);
      return this.listInstalled();
    });
  }

  reloadDevPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const link = this.devWatcher.get(id);
      if (!link) throw new PluginApiError('E_INVALID_INPUT', `插件 ${id} 未处于开发模式`);
      const next = new Map(this.plugins);
      try {
        const pack = readPluginPackage(link.dirPath);
        if (pack.manifest.id !== id) {
          throw new PluginApiError('E_CONFLICT', `开发目录清单 ID (${pack.manifest.id}) 与已关联 ID (${id}) 不一致`);
        }
        const occupied = new Map(next);
        occupied.delete(id);
        this.validateManifest(pack.manifest, occupied);
        this.isolated?.clearCrashHistory(id);
        const enabled = this.plugins.get(id)?.info.enabled ?? this.desiredEnabled(id, false);
        const candidate = await this.prepare(pack, link.dirPath, link.dirPath, enabled, false);
        candidate.info.devMode = true;
        candidate.info.devSourceDir = link.dirPath;
        this.restartGeneration.set(id, (this.restartGeneration.get(id) ?? 0) + 1);
        next.set(id, candidate);
        await this.activate(next);
        this.appendHostLog(id, 'info', `开发模式热重载完成 (v${pack.manifest.version}, digest ${pack.digest.slice(0, 8)})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendHostLog(id, 'error', `开发模式热重载失败: ${message}`);
        const existing = next.get(id);
        if (existing) {
          next.set(id, { ...existing, info: { ...existing.info, loadError: message } });
          this.plugins = next;
        }
        throw error;
      }
      return this.listInstalled();
    });
  }

  unlinkDevPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const existed = this.devWatcher.unlink(id);
      if (!existed && !this.plugins.get(id)?.info.devMode) {
        throw new PluginApiError('E_INVALID_INPUT', `插件 ${id} 未处于开发模式`);
      }
      this.isolated?.clearCrashHistory(id);
      const next = new Map(this.plugins);
      next.delete(id);
      await this.activate(next);
      await this.isolated?.awaitPendingDisposals();
      this.appendHostLog(id, 'info', '已取消关联开发模式插件（源码目录已保留）');
      return this.listInstalled();
    });
  }

  async scaffoldPlugin(req: ScaffoldPluginRequest): Promise<{
    dirPath: string;
    files: string[];
    plugins: InstalledPluginInfo[];
  }> {
    const { files } = buildScaffoldFiles(req);
    const defaultDir = path.join(this.dataDir, 'dev-plugins', req.id);
    const targetDir = req.targetDir?.trim() ? path.resolve(req.targetDir.trim()) : defaultDir;
    const writtenDir = writeScaffoldToDirectory(targetDir, files);
    const plugins = req.linkDevMode ? await this.linkDevPlugin(writtenDir) : this.listInstalled();
    return {
      dirPath: writtenDir,
      files: Object.keys(files),
      plugins,
    };
  }

  private checkPluginRoot(root: string): void {
    if (path.dirname(root) !== this.pluginsDir || (fs.existsSync(root) && fs.realpathSync(root) !== root)) {
      throw new Error('插件安装路径无效');
    }
  }

  private removeRevision(root: string, revision: string): void {
    try { fs.rmSync(revisionDirectory(root, revision), { recursive: true, force: true }); }
    catch { /* An inactive revision can be removed on the next maintenance pass. */ }
  }

  async dispatchLifecycleEvent(event: PluginEventV4, workspaceId?: string): Promise<void> {
    await this.host.events.dispatch(event);
    await this.isolated?.dispatchEvent(event, workspaceId);
  }

  notifyEvent(event: CanonicalEvent, workspaceId?: string): void {
    const mapped = toPluginEvent(event);
    if (!mapped) return;
    void this.host.events.dispatch(mapped);
    void this.isolated?.dispatchEvent(mapped, workspaceId);
    if (mapped.type !== 'turn.completed' && mapped.type !== 'turn.failed' && mapped.type !== 'turn.cancelled') return;
    const { harnessKind, model, actualModel, code, maintenance } = event.payload;
    const legacy = { sessionId: event.sessionId, seq: event.seq, type: mapped.type, turnId: event.turnId,
      createdAt: event.createdAt, payload: { ...mapped.data,
        ...(typeof harnessKind === 'string' ? { harnessKind } : {}),
        ...(typeof model === 'string' || model === null ? { model } : {}),
        ...(typeof actualModel === 'string' || actualModel === null ? { actualModel } : {}),
        ...(typeof code === 'string' ? { code } : {}),
        ...(maintenance === true ? { maintenance } : {}),
      } };
    for (const record of this.plugins.values()) {
      if (!this.isPluginEnabled(record.info.id) || !record.runtime?.hooks.includes('onEvent')) continue;
      const hooks = record.info.contributes.hooks ?? [];
      if (!hooks.includes('on_event') && !hooks.includes('after_turn')) continue;
      void record.runtime.request('onEvent', legacy).catch((error: Error) => {
        record.info.loadError = error.message;
      });
    }
  }

  async close(): Promise<void> {
    this.devWatcher.close();
    await this.mutation;
    for (const record of this.plugins.values()) record.runtime?.retire();
    await this.isolated?.close();
    this.host.reconcile([]);
  }

  expandSlashCommand(input: string): {
    text: string;
    expandedCommand?: string;
  } {
    let text = input;
    let expandedCommand: string | undefined;

    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const match = trimmed.match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
      if (match?.[1]) {
        const cmdName = match[1].toLowerCase();
        if ([...this.plugins.values()].some(({ info }) => this.isPluginEnabled(info.id) &&
          (info.contributes.dataPanels?.some(({ copySummary }) => copySummary?.command === cmdName) ||
            info.contributes.actions?.some(({ command }) => command === cmdName)))) {
          throw new Error(`/${cmdName} 是桌面插件面板命令或动作，请在桌面聊天中使用`);
        }
        const args = (match[2] ?? '').trim();
        const found = this.listActiveSlashCommands().find((c) => c.command === cmdName);
        if (found) {
          text = found.template.replace(/\{\{args\}\}/g, () => args || '（无额外参数）');
          expandedCommand = `/${cmdName}`;
        }
      }
    }

    return { text, expandedCommand };
  }

  async suggestBeforeTurn(ctx: PluginTurnHookContext): Promise<{ text: string; pluginNames: string[] } | null> {
    const expanded = this.expandSlashCommand(ctx.text);
    let text = expanded.text;
    const pluginNames: string[] = [];
    const deadline = Date.now() + 1500;
    for (const rec of this.plugins.values()) {
      if (!this.isPluginEnabled(rec.info.id) || !rec.runtime?.hooks.includes('beforeTurn')) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const res = await rec.runtime.request('beforeTurn', { ...ctx, text }, Math.min(800, remaining)) as { text?: string } | undefined;
        if (res && typeof res.text === 'string' && res.text !== text && res.text.trim() &&
          res.text.length <= Math.max(100_000, text.length) && this.plugins.get(rec.info.id)?.runtime === rec.runtime) {
          text = res.text;
          pluginNames.push(rec.info.name);
        }
      } catch (error) {
        rec.info.loadError = error instanceof Error ? error.message : String(error);
      }
    }

    return text !== expanded.text ? { text, pluginNames } : null;
  }
}
