import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginApiError } from '@harnessmate/plugin-api';
import {
  HarnessCommandNameSchema,
  GeneratedPluginManifestSchema,
  PluginManifestSchema,
  type Attachment,
  type CanonicalEvent,
  type InstalledPluginInfo,
  type InstallPluginRequest,
  type PluginCatalogItem,
  type PluginManifest,
  type PluginMcpPreset,
  type PluginSlashCommand,
} from '@harnessmate/protocol';
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
import { CURATED_PLUGIN_CATALOG } from './plugin-catalog.js';

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

export class PluginManager {
  private plugins = new Map<string, LoadedPluginRecord>();
  private readonly pluginHarnesses = new Map<string, { adapter: HarnessAdapter; config: string }>();
  private mutation = Promise.resolve();
  private registryChanged = false;
  private readonly composition: PluginComposition;
  private compositionError?: string;
  readonly host = new PluginHost((error) => console.error('插件生命周期错误', error));

  constructor(
    private readonly pluginsDir: string,
    private readonly registry: HarnessRegistry,
    private readonly getDisabledIds: () => string[],
    private readonly firstParty: ReadonlyMap<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>> = new Map(),
  ) {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    this.pluginsDir = fs.realpathSync(this.pluginsDir);
    this.composition = new PluginComposition(path.dirname(this.pluginsDir), BUILTIN_PLUGINS.map(({ id }) => id));
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
    this.activate(next);
  }

  private tryPrevious(root: string): string | undefined {
    try { return readRevisionPointer(root)?.previous; } catch { return undefined; }
  }

  private activate(next: Map<string, LoadedPluginRecord>): void {
    const previousAdapters = this.registry.listAdapters();
    const composition = this.composition.resolve(this.installedNames(next));
    const entries = new Map(composition.entries.map((entry) => [entry.name, entry]));
    const ranked = [...next.values()].sort((first, second) =>
      composition.entries.findIndex(({ name }) => name === first.info.id) -
      composition.entries.findIndex(({ name }) => name === second.info.id));
    const definitions: HostPlugin[] = ranked.map(({ info, digest, packageRoot }) => {
      const entry = entries.get(info.id);
      const core = this.firstParty.get(info.id);
      return { id: info.id, enabled: info.enabled, revision: JSON.stringify([digest, entry?.config, info.inject]),
        error: info.loadError && !packageRoot && !info.builtin ? info.loadError : undefined,
        inject: core?.inject ?? info.inject, provides: core?.provides, apply: core?.apply ?? (() => {}),
        config: entry?.config };
    });
    this.host.reconcile(definitions);
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
    if ((!manifest.entry && normalized.main) || normalized.provides?.length) {
      throw new PluginApiError('E_NOT_SUPPORTED', 'V4 代码入口与第三方服务提供方将在隔离运行时开放');
    }
    if (manifest.id.startsWith('core.') || manifest.id.startsWith('broken.')) throw new Error('插件 ID 使用了保留前缀');
    const other = [...occupied.values()].filter(({ info }) => info.id !== manifest.id);
    const commands = new Set<string>([...HarnessCommandNameSchema.options, 'quota', 'plugins']);
    const contributedHarnesses = new Set<string>();
    const commandNames = (plugin: PluginManifest) => [
      ...(plugin.contributes.slashCommands ?? []).map(({ command }) => command),
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
      return { ...info, runtimeState: runtime?.failed ? 'FAILED' : status?.state,
        missingServices: status?.missingServices, loadError: status?.error ?? info.loadError };
    });
  }

  listCatalog(): PluginCatalogItem[] {
    return CURATED_PLUGIN_CATALOG.map((item) => ({
      ...item,
      installed: this.plugins.has(item.id),
    }));
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
        if (record.digest !== pack.digest) throw new Error('插件文件已变更，请重新预览并安装');
        this.validateManifest(pack.manifest);
        candidate = await this.prepare(pack, record.packageRoot, record.info.sourcePath!, true, Boolean(record.info.canRollback));
      }
      try {
        if (this.compositionError) throw new PluginApiError('E_INVALID_INPUT', this.compositionError);
        this.composition.setEnabled(id, enabled, this.installedNames());
      } catch (error) {
        if (candidate.runtime !== record.runtime) candidate.runtime?.retire();
        throw error;
      }
      this.activate(new Map(this.plugins).set(id, candidate));
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
    if (req.mode === 'local_dir') return readPluginPackage(req.dirPath);
    const source = req.mode === 'manifest' ? req.manifest : CURATED_PLUGIN_CATALOG.find(({ id }) => id === req.catalogId);
    if (!source) throw new Error('找不到目录中的插件');
    const manifest = PluginManifestSchema.parse(source);
    if (manifest.entry) throw new Error('带 JavaScript 入口的插件必须通过本地目录导入');
    return manifestPluginPackage(manifest);
  }

  previewInstall(req: InstallPluginRequest) {
    const { manifest, files, digest } = this.resolveInstallPackage(req);
    return { ...this.reviewManifest(manifest, req.expectedInstalledDigest), digest, fileCount: files.size,
      requiresTrust: requiresPluginTrust(manifest) };
  }

  installPlugin(req: InstallPluginRequest): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const pack = this.resolveInstallPackage(req);
      if (req.expectedDigest && req.expectedDigest !== pack.digest) throw new Error('插件文件已更改，请重新预览');
      const trusted = requiresPluginTrust(pack.manifest);
      if (trusted && (!req.trustCode || !req.expectedDigest)) throw new Error('请预览并确认信任此插件包');
      this.validateManifest(pack.manifest);
      const id = pack.manifest.id;
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
      const next = new Map(this.plugins);
      for (const [otherId, record] of next) {
        if (otherId !== id && otherId.startsWith('broken.') && record.info.sourcePath === root) next.delete(otherId);
      }
      this.activate(next.set(id, candidate));
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
      const next = new Map(this.plugins);
      next.delete(id);
      next.set(pack.manifest.id, candidate);
      this.activate(next);
      return this.listInstalled();
    });
  }

  uninstallPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const root = this.plugins.get(id)?.info.sourcePath;
      if (!root) throw new Error('只能卸载外部插件');
      this.checkPluginRoot(root);
      const removed = path.join(this.pluginsDir, `.uninstalled-${randomUUID()}`);
      fs.renameSync(root, removed);
      try {
        if (!this.compositionError) this.composition.removePlugin(id);
      } catch (error) {
        fs.renameSync(removed, root);
        throw error;
      }
      const next = new Map(this.plugins);
      next.delete(id);
      this.activate(next);
      try { fs.rmSync(removed, { recursive: true, force: true }); } catch { /* Loaded files may still be open. */ }
      return this.listInstalled();
    });
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

  notifyEvent(event: CanonicalEvent): void {
    const mapped = toPluginEvent(event);
    if (!mapped) return;
    void this.host.events.dispatch(mapped);
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
    await this.mutation;
    for (const record of this.plugins.values()) record.runtime?.retire();
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
