import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  FILE_PREVIEW_PERMISSION,
  FilePreviewResultSchema,
  PEER_CONTRACTS,
  PluginApiError,
  isBuiltinPublicService,
  isPeerContractName,
  isReservedServiceName,
  isThirdPartyCustomServiceName,
  normalizePluginSlotKey,
  serviceResolutionErrorCode,
  type FilePreviewRequest,
  type FilePreviewResult,
  type PluginEventV4,
  type PluginRouteRequest,
  type PluginRouteResponse,
  type ResolveServiceSelectionOptions,
  type ServiceResolutionV1,
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
import { PluginComposition, type CompositionEntry, type CompositionLayerEntry } from '../plugin-host/composition/profile.js';
import {
  resolveCapabilityBinding,
  resolveServiceSelection as resolveServiceSelectionImpl,
  type ResolvedCapabilityBinding,
} from '../plugin-host/composition/bindings.js';
import { BUILTIN_PLUGINS, BUNDLED_PLUGIN_IDS, BUNDLED_TRUSTED_LOCAL_IDS } from '../plugin-host/builtin/manifests.js';
import { IsolatedPluginManager } from '../plugin-host/isolation/isolated-manager.js';
import type { CrashPolicy } from '../plugin-host/isolation/isolated-process.js';
import { PluginSecretStore } from '../plugin-host/isolation/plugin-secrets.js';
import { GLOBAL_WORKSPACE_SCOPE, PluginPermissionService } from '../plugin-host/permissions/permissions.js';
import { CURATED_PLUGIN_CATALOG } from './plugin-catalog.js';
import { PluginDevWatcher, type DevPluginLink } from './plugin-dev-mode.js';
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
  safeMode?: boolean;
  store?: HarnessMateStore;
  permissions?: PluginPermissionService;
  pluginSecrets?: PluginSecretStore;
  crashPolicy?: CrashPolicy;
  bundledPluginsDir?: string;
  onDevReload?: () => void;
}

function resolveBundledPluginsDir(explicitDir?: string): string | undefined {
  const candidates = [
    explicitDir,
    process.env.HARNESSMATE_BUNDLED_PLUGINS_DIR,
    typeof (process as unknown as { resourcesPath?: string }).resourcesPath === 'string'
      ? path.resolve((process as unknown as { resourcesPath: string }).resourcesPath, 'bundled-plugins')
      : undefined,
    path.resolve(process.cwd(), 'plugins', 'bundled'),
    path.resolve(process.cwd(), '..', '..', 'plugins', 'bundled'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return fs.realpathSync(candidate);
    }
  }
  return undefined;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPluginRecord>();
  private instances = new Map<string, LoadedPluginRecord>();
  private readonly pluginHarnesses = new Map<string, { adapter: HarnessAdapter; config: string }>();
  private mutation = Promise.resolve();
  private registryChanged = false;
  private readonly composition: PluginComposition;
  private readonly safeComposition?: PluginComposition;
  private compositionError?: string;
  private readonly restartGeneration = new Map<string, number>();
  private readonly permissionRevision = new Map<string, number>();
  private readonly hostLogs = new Map<string, PluginLogEntryDto[]>();
  private readonly dataDir: string;
  private readonly store?: HarnessMateStore;
  private readonly bundledPluginsDir?: string;
  readonly host = new PluginHost((error) => console.error('插件生命周期错误', error));
  readonly permissions?: PluginPermissionService;
  readonly pluginSecrets?: PluginSecretStore;
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
    this.store = options?.store;
    this.bundledPluginsDir = resolveBundledPluginsDir(options?.bundledPluginsDir);
    const builtins = [...BUILTIN_PLUGINS.map(({ id }) => id), ...BUNDLED_PLUGIN_IDS];
    this.composition = new PluginComposition(this.dataDir, builtins);
    if (options?.safeMode) this.safeComposition = new PluginComposition(this.dataDir, builtins);
    this.registryService = new PluginRegistryService(this.dataDir);
    this.devWatcher = new PluginDevWatcher(this.dataDir, (pluginId, filename) => {
      this.appendHostLog(pluginId, 'info', `检测到源码变更${filename ? ` (${filename})` : ''}，正在热重载…`);
      void this.reloadDevPlugin(pluginId, false).catch((err: unknown) => {
        this.appendHostLog(pluginId, 'error', `开发模式热重载失败: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => options?.onDevReload?.());
    });
    if (options?.store) {
      this.permissions = options.permissions ?? new PluginPermissionService(options.store);
      this.pluginSecrets = options.pluginSecrets ?? new PluginSecretStore();
      this.isolated = new IsolatedPluginManager({
        store: options.store,
        host: this.host,
        permissions: this.permissions,
        pluginSecrets: this.pluginSecrets,
        getPluginInfo: (id) => this.instances.get(id)?.info ?? this.plugins.get(id)?.info,
        requestRestart: (instanceId) => this.restartIsolatedPlugin(instanceId),
        crashPolicy: options.crashPolicy,
        resolveServiceSelection: (contract, resolveOpts) => this.resolveServiceSelection(contract, resolveOpts),
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

  private restartIsolatedPlugin(instanceId: string): Promise<void> {
    return this.serialize(async () => {
      const inst = this.instances.get(instanceId);
      const pluginId = inst?.info.id ?? instanceId;
      if (!this.plugins.has(pluginId) && !inst) return;
      this.restartGeneration.set(instanceId, (this.restartGeneration.get(instanceId) ?? 0) + 1);
      await this.activate(this.plugins);
    });
  }

  reconcilePermissionsChange(pluginId: string): Promise<void> {
    return this.serialize(async () => {
      const record = this.plugins.get(pluginId);
      if (!record?.info.main) return;
      this.isolated?.clearCrashHistory(pluginId);
      for (const [instId, inst] of this.instances) {
        if (inst.info.id === pluginId) this.isolated?.clearCrashHistory(instId);
      }
      this.permissionRevision.set(pluginId, (this.permissionRevision.get(pluginId) ?? 0) + 1);
      await this.activate(this.plugins);
    });
  }

  private installedNames(records = this.plugins): string[] {
    return [...records.values()]
      .filter(({ info }) => !info.builtin && info.sourceKind !== 'bundled' && !info.id.startsWith('broken.'))
      .map(({ info }) => info.id);
  }

  isEmptyComposition(): boolean {
    return !this.safeComposition && !this.compositionError && this.composition.isEmptyComposition;
  }

  getComposition() {
    const resolved = this.safeComposition?.resolve([]) ?? this.composition.resolve(this.installedNames());
    return {
      ...resolved,
      emptyComposition: this.isEmptyComposition(),
      serviceProviders: this.listServiceProviders(),
      error: this.compositionError,
      safeMode: Boolean(this.safeComposition),
      canRestore: this.composition.canRestore(),
    };
  }

  listServiceProviders(contract?: string) {
    return this.host.listServiceProviders(contract).map((item) => ({
      ...item,
      state: this.host.status(item.instanceId)?.state ?? 'DISPOSED',
      name: this.instances.get(item.instanceId)?.info.name ?? this.plugins.get(item.pluginId)?.info.name ?? item.pluginId,
      sourceKind: this.instances.get(item.instanceId)?.info.sourceKind ?? this.plugins.get(item.pluginId)?.info.sourceKind ?? 'installed',
    }));
  }

  private isEntryInComposition(instanceId: string): boolean {
    const resolved = this.safeComposition?.resolve([]) ?? this.composition.resolve(this.installedNames());
    return resolved.entries.some((entry) => entry.id === instanceId && !entry.disabled);
  }

  resolveCapabilityBinding(contract: string, scope?: { sessionId?: string; workspaceId?: string }): ResolvedCapabilityBinding {
    return resolveCapabilityBinding({
      contract,
      sessionId: scope?.sessionId,
      workspaceId: scope?.workspaceId,
      store: this.store,
      composition: this.safeComposition ?? this.composition,
      isEntryInComposition: (instanceId) => this.isEntryInComposition(instanceId),
    });
  }

  private isInstanceServiceActive(instanceId: string): boolean {
    if (this.host.status(instanceId)?.state !== 'ACTIVE') return false;
    const inst = this.instances.get(instanceId);
    if (!inst) return true;
    if (!inst.info.enabled || inst.runtime?.failed) return false;
    if (inst.info.main && this.isolated && !this.isolated.getActive(instanceId)?.process.alive) {
      return false;
    }
    return true;
  }

  private isInstanceKnownDisabled(instanceId: string): boolean {
    const inst = this.instances.get(instanceId);
    if (inst) return !inst.info.enabled;
    const pkg = this.plugins.get(instanceId);
    if (pkg) return !pkg.info.enabled;
    const resolved = (this.safeComposition ?? this.composition).resolve(this.installedNames());
    return Boolean(resolved.entries.find((entry) => entry.id === instanceId)?.disabled);
  }

  resolveServiceSelection(
    contract: string,
    options?: ResolveServiceSelectionOptions,
  ): ServiceResolutionV1 {
    return resolveServiceSelectionImpl({
      contract,
      options,
      host: this.host,
      composition: this.safeComposition ?? this.composition,
      store: this.store,
      isInstanceActive: (instanceId) => this.isInstanceServiceActive(instanceId),
      isInstanceDisabled: (instanceId) => this.isInstanceKnownDisabled(instanceId),
    });
  }

  async invokeServiceSelection<T = unknown>(
    contract: string,
    method: string,
    args: unknown[] = [],
    options?: ResolveServiceSelectionOptions,
  ): Promise<{ resolution: ServiceResolutionV1; value: T }> {
    const resolution = this.resolveServiceSelection(contract, options);
    if (resolution.status !== 'ready') {
      throw new PluginApiError(
        serviceResolutionErrorCode(resolution.status),
        `服务 ${contract} 不可用 (${resolution.status})`,
      );
    }
    const rec = this.host.getServiceRecordByInstance(resolution.instanceId, contract);
    const service = this.host.getServiceByInstance<Record<string, unknown>>(resolution.instanceId, contract);
    if (!rec || !service) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${contract}@${resolution.instanceId} 不可用`);
    }
    const fn = service[method];
    if (typeof fn !== 'function') {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${contract}.${method} 不存在`);
    }
    const value = (await (fn as (...callArgs: unknown[]) => unknown)(...args)) as T;
    return { resolution, value };
  }

  hasInstanceRoutes(instanceId: string): boolean {
    return this.host.hasRoutes(instanceId) || Boolean(this.isolated?.listRoutes(instanceId).length);
  }

  async dispatchPluginRoute(instanceId: string, req: PluginRouteRequest): Promise<PluginRouteResponse> {
    if (this.host.hasRoutes(instanceId)) {
      return this.host.dispatchRoute(instanceId, req);
    }
    if (this.isInstanceKnownDisabled(instanceId)) {
      throw new PluginApiError('E_PLUGIN_DISABLED', `插件实例 ${instanceId} 当前已停用`);
    }
    if (this.isolated?.getActive(instanceId)) {
      return this.isolated.dispatchRoute(instanceId, req);
    }
    const inst = this.instances.get(instanceId);
    if (inst && !inst.info.main) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', `插件实例 ${instanceId} 未注册路由或未就绪`);
    }
    if (!this.isolated) {
      throw new PluginApiError('E_NOT_SUPPORTED', '隔离插件运行时不可用');
    }
    return this.isolated.dispatchRoute(instanceId, req);
  }

  setCompositionBinding(contract: string, instanceId: string | null): Promise<void> {
    return this.serialize(async () => {
      if (this.safeComposition || this.compositionError) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '请在组合配置可用的正常模式中修改默认提供方');
      }
      if (instanceId !== null) {
        const prov = this.host.listServiceProviders(contract).find((p) => p.instanceId === instanceId);
        if (!prov && !this.instances.has(instanceId) && !this.plugins.has(instanceId)) {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `实例 ${instanceId} 不存在或未提供 ${contract}`);
        }
      }
      this.composition.setContractBinding(contract, instanceId);
      this.host.setDefaultBindings(this.composition.contractBindings);
    });
  }

  setWorkspaceBinding(workspaceId: string, contract: string, instanceId: string | null): Promise<void> {
    return this.serialize(async () => {
      if (!this.store) throw new PluginApiError('E_NOT_SUPPORTED', '未启用持久化存储');
      if (!this.store.getWorkspace(workspaceId)) throw new PluginApiError('E_INVALID_INPUT', '工作区不存在');
      this.store.setCapabilityBinding('workspace', workspaceId, contract, instanceId);
    });
  }

  setSessionBinding(sessionId: string, contract: string, instanceId: string | null): Promise<void> {
    return this.serialize(async () => {
      if (!this.store) throw new PluginApiError('E_NOT_SUPPORTED', '未启用持久化存储');
      if (!this.store.getSession(sessionId)) throw new PluginApiError('E_INVALID_INPUT', '会话不存在');
      this.store.setCapabilityBinding('session', sessionId, contract, instanceId);
    });
  }

  upsertCompositionInstance(entry: CompositionLayerEntry): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      if (this.safeComposition || this.compositionError) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '请在组合配置可用的正常模式中修改组合实例');
      }
      const pluginId = entry.name ?? entry.id;
      if (!this.plugins.has(pluginId)) {
        throw new PluginApiError('E_INVALID_INPUT', `插件 ${pluginId} 未安装`);
      }
      this.composition.upsertInstance(entry);
      await this.activate(this.plugins);
      return this.listInstalled();
    });
  }

  removeCompositionInstance(instanceId: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      if (this.safeComposition || this.compositionError) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '请在组合配置可用的正常模式中修改组合实例');
      }
      this.composition.removeInstance(instanceId);
      await this.activate(this.plugins);
      await this.isolated?.awaitPendingDisposals();
      return this.listInstalled();
    });
  }

  authorizeInstanceView(
    instanceId: string,
    runId: string,
    permission = 'browser:preview',
  ): { ok: true } | { ok: false; status: 403 | 409; code: 'E_PERMISSION_DENIED' | 'E_STALE_RUN'; error: string } {
    const pkg = this.getInstancePackageRoot(instanceId);
    const inst = this.instances.get(instanceId) ?? this.plugins.get(instanceId);
    if (!pkg || !inst || !this.isInstanceEnabled(instanceId) || runId !== (pkg.runId ?? pkg.digest)) {
      return { ok: false, status: 409, code: 'E_STALE_RUN', error: '插件实例已停止或已更新' };
    }
    if (this.permissions && !this.permissions.isGranted(inst.info, permission)) {
      return { ok: false, status: 403, code: 'E_PERMISSION_DENIED', error: `请在插件中心授权 ${permission}` };
    }
    return { ok: true };
  }

  get filePreviewProviderId(): string | undefined {
    if (this.safeComposition || this.compositionError) return;
    return this.composition.extensionBindings?.filePreviewProvider;
  }

  private readyFilePreviewProvider(instanceId: string) {
    const entry = this.isolated?.getActive(instanceId);
    if (entry?.process.alive && entry.handshake?.hasFilePreview && entry.info.contributes.filePreview
      && this.isInstanceEnabled(instanceId)) return entry;
  }

  listFilePreviewProviders(workspaceId?: string) {
    return this.listFilePreviewViewers(workspaceId).map(({ instanceId, name, extensions, ready, authorized }) => ({
      id: instanceId,
      name,
      extensions,
      ready,
      authorized,
    }));
  }

  listFilePreviewViewers(workspaceId?: string) {
    const viewers: Array<{
      instanceId: string;
      pluginId: string;
      name: string;
      extensions: string[];
      viewerKind: 'text' | 'markdown' | 'custom';
      ready: boolean;
      authorized: boolean;
      sourceKind: string;
    }> = [];
    const candidates = new Map<string, LoadedPluginRecord>();
    for (const [instId, rec] of this.instances) {
      if (rec.info.contributes.filePreview) candidates.set(instId, rec);
    }
    for (const [pluginId, rec] of this.plugins) {
      if (rec.info.contributes.filePreview && !candidates.has(pluginId)) candidates.set(pluginId, rec);
    }
    for (const [instanceId, rec] of candidates) {
      const fp = rec.info.contributes.filePreview;
      if (!fp) continue;
      const entry = this.readyFilePreviewProvider(instanceId);
      const ready = Boolean(entry);
      const authorized = Boolean(workspaceId && entry && this.permissions?.isGranted(entry.info, FILE_PREVIEW_PERMISSION, workspaceId));
      viewers.push({
        instanceId,
        pluginId: rec.info.id,
        name: rec.info.name,
        extensions: fp.extensions,
        viewerKind: fp.viewerKind ?? (fp.extensions.includes('*') ? 'text' : fp.extensions.includes('.md') ? 'markdown' : 'custom'),
        ready,
        authorized,
        sourceKind: rec.info.sourceKind ?? (rec.info.builtin ? 'kernel' : 'installed'),
      });
    }
    return viewers;
  }

  setFilePreviewProvider(pluginId: string | null, workspaceId?: string): Promise<void> {
    return this.serialize(async () => {
      if (this.safeComposition || this.compositionError) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', '请在组合配置可用的正常模式中切换文件预览');
      }
      if (pluginId !== null) {
        const entry = this.readyFilePreviewProvider(pluginId);
        if (!entry) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '文件预览提供方尚未就绪');
        if (!workspaceId || !this.permissions?.isGranted(entry.info, FILE_PREVIEW_PERMISSION, workspaceId)) {
          throw new PluginApiError('E_PERMISSION_DENIED', '请先为当前工作区授权 file:preview');
        }
      }
      this.composition.setFilePreviewProvider(pluginId);
      this.host.setDefaultBindings(this.composition.contractBindings);
    });
  }

  async renderPeerFilePreview(
    workspaceId: string,
    request: FilePreviewRequest,
    opts?: { sessionId?: string; explicitInstanceId?: string; requireExplicitMatch?: boolean },
  ): Promise<{
    preview: (FilePreviewResult & { pluginId: string; instanceId: string; pluginName: string }) | null;
    resolvedInstanceId: string | null;
    boundInstanceId: string | null;
    boundSource: string;
    dependencyStatus: 'ready' | 'unavailable' | 'unauthorized' | 'unsupported_extension' | 'failed';
    dependencyMessage?: string;
  }> {
    const resolvedBinding = this.resolveCapabilityBinding(PEER_CONTRACTS.filePreview, {
      sessionId: opts?.sessionId,
      workspaceId,
    });
    const targetId = opts?.explicitInstanceId ?? resolvedBinding.instanceId;
    if (!targetId) {
      return {
        preview: null,
        resolvedInstanceId: null,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'unavailable',
        dependencyMessage: '当前组合未启用任何文件预览插件',
      };
    }

    const entry = this.readyFilePreviewProvider(targetId);
    if (!entry) {
      return {
        preview: null,
        resolvedInstanceId: targetId,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'unavailable',
        dependencyMessage: `文件查看器 ${targetId} 当前已停用或未就绪`,
      };
    }

    if (!this.permissions?.isGranted(entry.info, FILE_PREVIEW_PERMISSION, workspaceId)) {
      return {
        preview: null,
        resolvedInstanceId: targetId,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'unauthorized',
        dependencyMessage: `文件查看器 ${entry.info.name} 未获得此工作区的 file:preview 权限`,
      };
    }

    const exts = entry.info.contributes.filePreview?.extensions ?? [];
    const ext = path.extname(request.relativePath).toLowerCase();
    if (!exts.includes('*') && !exts.includes(ext)) {
      return {
        preview: null,
        resolvedInstanceId: targetId,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'unsupported_extension',
      };
    }

    const bindingsBefore = this.composition.extensionBindings;
    const contractBindingsBefore = this.composition.contractBindings;
    let revoked = false;
    const unsubscribe = this.permissions.onChange((event) => {
      if (event.pluginId === entry.pluginId && event.capability === FILE_PREVIEW_PERMISSION
        && event.workspaceId === workspaceId && !this.permissions?.isGranted(entry.info, FILE_PREVIEW_PERMISSION, workspaceId)) {
        revoked = true;
      }
    });
    try {
      const result = await entry.process.call<unknown>('host.filePreview.render', { request }, 600, entry.runId);
      if (
        revoked
        || this.readyFilePreviewProvider(targetId) !== entry
        || !this.permissions.isGranted(entry.info, FILE_PREVIEW_PERMISSION, workspaceId)
        || (opts?.requireExplicitMatch && (bindingsBefore !== this.composition.extensionBindings || this.filePreviewProviderId !== targetId))
        || (!opts?.explicitInstanceId && contractBindingsBefore['filePreview.v1'] !== this.composition.contractBindings['filePreview.v1'])
      ) {
        return {
          preview: null,
          resolvedInstanceId: targetId,
          boundInstanceId: resolvedBinding.instanceId,
          boundSource: resolvedBinding.source,
          dependencyStatus: 'failed',
          dependencyMessage: '查看器状态或权限已变更，已丢弃过期结果',
        };
      }
      if (result === null) {
        return {
          preview: null,
          resolvedInstanceId: targetId,
          boundInstanceId: resolvedBinding.instanceId,
          boundSource: resolvedBinding.source,
          dependencyStatus: 'ready',
        };
      }
      const parsed = FilePreviewResultSchema.safeParse(result);
      if (!parsed.success) {
        this.appendHostLog(entry.pluginId, 'warn', '文件预览返回了无效的结果，已使用内置预览');
        return {
          preview: null,
          resolvedInstanceId: targetId,
          boundInstanceId: resolvedBinding.instanceId,
          boundSource: resolvedBinding.source,
          dependencyStatus: 'failed',
          dependencyMessage: '文件查看器返回了无效的输出格式',
        };
      }
      return {
        preview: { ...parsed.data, pluginId: entry.pluginId, instanceId: targetId, pluginName: entry.info.name },
        resolvedInstanceId: targetId,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'ready',
      };
    } catch (error) {
      const reason = error instanceof PluginApiError ? error.code : 'E_INTERNAL';
      this.appendHostLog(entry.pluginId, 'warn', `文件预览调用失败，已使用内置预览 (${reason})`);
      return {
        preview: null,
        resolvedInstanceId: targetId,
        boundInstanceId: resolvedBinding.instanceId,
        boundSource: resolvedBinding.source,
        dependencyStatus: 'failed',
        dependencyMessage: `文件查看器调用失败 (${reason})`,
      };
    } finally {
      unsubscribe();
    }
  }

  async renderFilePreview(workspaceId: string, request: FilePreviewRequest) {
    const pluginId = this.filePreviewProviderId;
    if (!pluginId) return null;
    const res = await this.renderPeerFilePreview(workspaceId, request, {
      explicitInstanceId: pluginId,
      requireExplicitMatch: true,
    });
    return res.preview;
  }

  restoreComposition(modeOrUseDefaults: boolean | 'previous' | 'builtin' | 'empty'): Promise<void> {
    return this.serialize(async () => {
      if (modeOrUseDefaults === 'empty') {
        this.composition.restore(undefined, { empty: true });
      } else {
        const useDefaults = modeOrUseDefaults === true || modeOrUseDefaults === 'builtin';
        this.composition.restore(useDefaults ? this.installedNames() : undefined);
      }
      await this.loadRegistry();
      await this.isolated?.awaitPendingDisposals();
    });
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
      this.composition.reload(this.getDisabledIds(), Boolean(this.safeComposition));
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
          sourceKind: 'kernel',
          instanceId: manifest.id,
          enabled,
          sourcePath: null,
          hasRuntimeHook: Boolean(manifest.contributes.hooks?.length),
          loadError: null,
        },
      });
    }

    if (this.bundledPluginsDir && fs.existsSync(this.bundledPluginsDir)) {
      const bundledDirs = fs.readdirSync(this.bundledPluginsDir, { withFileTypes: true });
      for (const entry of bundledDirs) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dir = path.join(this.bundledPluginsDir, entry.name);
        if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
        try {
          const pack = readPluginPackage(dir);
          const kernel = next.get(pack.manifest.id);
          if (kernel && (pack.manifest.main || !this.firstParty.has(pack.manifest.id))) continue;
          const enabled = this.desiredEnabled(pack.manifest.id, true);
          next.set(pack.manifest.id, {
            info: {
              ...pack.manifest,
              builtin: true,
              sourceKind: kernel ? 'kernel' : 'bundled',
              instanceId: pack.manifest.id,
              enabled,
              sourcePath: null,
              hasRuntimeHook: false,
              loadError: null,
              packageDigest: pack.digest,
            },
            packageRoot: dir,
            digest: pack.digest,
          });
        } catch (error) {
          this.appendHostLog(entry.name, 'error', `预装插件加载失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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

    // Use the last accepted revision on startup, even when the source has unapplied edits.
    for (const devLink of this.devWatcher.list()) {
      if (next.get(devLink.id)?.info.builtin) continue;
      try {
        const record = await this.prepareDevRevision(devLink, this.desiredEnabled(devLink.id, false), next);
        next.set(devLink.id, record);
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
            devTrustedLocal: devLink.trustedLocal,
            canRollback: Boolean(devLink.previous),
            hasRuntimeHook: false,
            loadError: message,
          },
        });
      }
    }
    if (!this.safeComposition) this.devWatcher.startAllWatchers();

    await this.activate(next);
  }

  private tryPrevious(root: string): string | undefined {
    try { return readRevisionPointer(root)?.previous; } catch { return undefined; }
  }

  private async activate(next: Map<string, LoadedPluginRecord>): Promise<void> {
    const previousAdapters = this.registry.listAdapters();
    const composition = this.safeComposition?.resolve([]) ?? this.composition.resolve(this.installedNames(next));
    this.host.setDefaultBindings(composition.bindings ?? {});

    const nextInstances = new Map<string, LoadedPluginRecord>();
    const definitions: HostPlugin[] = [];
    const seenPlugins = new Set<string>();

    for (const entry of composition.entries) {
      const pkg = next.get(entry.name) ?? next.get(entry.id);
      if (!pkg) continue;
      seenPlugins.add(pkg.info.id);
      const { info, digest, packageRoot } = pkg;
      const enabled = this.safeComposition
        ? (info.builtin && !entry.disabled)
        : !entry.disabled;
      const core = this.firstParty.get(info.id);
      const trustedLocal = Boolean(
        info.devTrustedLocal || (info.sourceKind === 'bundled' && BUNDLED_TRUSTED_LOCAL_IDS.has(info.id)),
      );
      const revision = JSON.stringify([
        digest,
        trustedLocal,
        entry.config,
        entry.bindings,
        info.inject,
        info.provides,
        this.restartGeneration.get(entry.id) ?? this.restartGeneration.get(info.id) ?? 0,
        this.permissionRevision.get(info.id) ?? 0,
      ]);
      const instRecord: LoadedPluginRecord = {
        ...pkg,
        info: {
          ...info,
          instanceId: entry.id,
          enabled,
          bindings: Object.keys(entry.bindings).length > 0 ? entry.bindings : undefined,
        },
      };
      nextInstances.set(entry.id, instRecord);
      if (entry.id === info.id || !nextInstances.has(info.id)) {
        next.set(info.id, instRecord);
      }
      if (info.main && packageRoot && digest && this.isolated) {
        definitions.push(this.isolated.createHostPlugin({
          info: instRecord.info,
          instanceId: entry.id,
          packageRoot,
          entryRelativePath: info.main,
          digest,
          enabled,
          config: entry.config,
          bindings: entry.bindings,
          trustedLocal,
          revision,
        }));
      } else {
        definitions.push({
          id: entry.id,
          pluginId: info.id,
          enabled,
          revision,
          error: info.loadError && !packageRoot && !info.builtin ? info.loadError : undefined,
          inject: core?.inject ?? info.inject,
          provides: core?.provides,
          dependencies: info.dependencies ? Object.values(info.dependencies) : undefined,
          bindings: entry.bindings,
          apply: core?.apply ?? (() => {}),
          config: entry.config,
        });
      }
    }

    // Ensure non-composition records (e.g. broken.* or empty composition disabled records) reflect disabled state
    for (const [id, pkg] of next) {
      if (!seenPlugins.has(id)) {
        pkg.info.enabled = false;
      }
    }

    await this.host.reconcileAsync(definitions);
    this.instances = nextInstances;

    const wanted = new Map<string, NonNullable<PluginManifest['contributes']['harnesses']>[number]>();
    for (const [instanceId, rec] of nextInstances) {
      if (!rec.info.enabled || this.host.status(instanceId)?.state !== 'ACTIVE' || !this.host.get('harness.acp')) continue;
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
    if (this.safeComposition) {
      return builtin && !this.safeComposition.resolve([]).entries.find((e) => e.id === id || e.name === id)?.disabled;
    }
    if (this.compositionError && !builtin) return this.plugins.get(id)?.info.enabled ?? false;
    const installed = this.installedNames();
    if (!builtin && !installed.includes(id)) installed.push(id);
    const entry = this.composition.resolve(installed).entries.find((e) => e.id === id || e.name === id);
    return entry ? !entry.disabled : false;
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
      } else if (!isPeerContractName(service) && !isThirdPartyCustomServiceName(service)) {
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

  getInstancePackageRoot(instanceId: string): { packageRoot: string; digest?: string; runId?: string } | undefined {
    const rec = this.instances.get(instanceId) ?? this.plugins.get(instanceId);
    if (!rec || !rec.packageRoot || !this.isInstanceEnabled(instanceId)) return undefined;
    return {
      packageRoot: rec.packageRoot,
      digest: rec.digest,
      runId: this.isolated?.getRunId(instanceId),
    };
  }

  getPluginPackageRoot(pluginId: string): { packageRoot: string; digest?: string; runId?: string } | undefined {
    return this.getInstancePackageRoot(pluginId);
  }

  getDataPanel(pluginId: string, panelId: string) {
    const plugin = this.plugins.get(pluginId)?.info;
    if (!plugin || !this.isPluginEnabled(pluginId)) return undefined;
    const panel = plugin.contributes.dataPanels?.find(({ id }) => id === panelId);
    const projection = plugin.contributes.projections?.find(({ id }) => id === panel?.projection);
    return panel && projection ? { panel, projection } : undefined;
  }

  private toInstalledInfo(instanceId: string, { info, runtime }: LoadedPluginRecord): InstalledPluginInfo {
    const status = this.host.status(instanceId);
    const runId = this.isolated?.getRunId(instanceId);
    const runtimeSlots = this.isolated?.listSlots(instanceId);
    const routes = this.isolated?.listRoutes(instanceId);
    const providedContracts = this.host.listServiceProviders()
      .filter((p) => p.instanceId === instanceId)
      .map(({ contract, version, metadata }) => ({ contract, version, ...(metadata ? { metadata } : {}) }));
    const isKernel = info.sourceKind === 'kernel' || (info.builtin && !info.main && !info.entry);
    const isTrustedLocal = Boolean(
      info.devTrustedLocal || (info.sourceKind === 'bundled' && BUNDLED_TRUSTED_LOCAL_IDS.has(info.id)),
    );
    const runtimeMode = isKernel ? 'kernel' : isTrustedLocal ? 'trusted-local' :
      (info.main || info.entry) ? 'isolated' : 'declarative';
    return {
      ...info,
      instanceId,
      sourceKind: info.sourceKind ?? (info.devMode ? 'dev' : info.builtin ? 'kernel' : 'installed'),
      runtimeState: runtime?.failed ? 'FAILED' : status?.state,
      missingServices: status?.missingServices,
      loadError: status?.error ?? info.loadError,
      ...(runId ? { runId } : {}),
      ...(runtimeSlots?.length ? { runtimeSlots } : {}),
      ...(routes?.length ? { routes } : {}),
      ...(providedContracts.length ? { providedContracts } : {}),
      runtimeMode,
    };
  }

  listInstalled(): InstalledPluginInfo[] {
    const out: InstalledPluginInfo[] = [];
    const emitted = new Set<string>();
    for (const [id, rec] of this.plugins) {
      out.push(this.toInstalledInfo(rec.info.instanceId ?? id, rec));
      emitted.add(rec.info.instanceId ?? id);
    }
    for (const [instanceId, rec] of this.instances) {
      if (!emitted.has(instanceId)) {
        out.push(this.toInstalledInfo(instanceId, rec));
      }
    }
    return out;
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

  isInstanceEnabled(instanceId: string): boolean {
    const rec = this.instances.get(instanceId) ?? this.plugins.get(instanceId);
    return Boolean(rec?.info.enabled && this.host.status(instanceId)?.state === 'ACTIVE' && !rec.runtime?.failed);
  }

  isPluginEnabled(id: string): boolean {
    return this.isInstanceEnabled(id);
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
      const record = this.instances.get(id) ?? this.plugins.get(id);
      if (!record) throw new Error(`Plugin not found: ${id}`);
      if (this.safeComposition && (enabled || record.info.builtin)) {
        throw new PluginApiError('E_NOT_SUPPORTED', '安全模式只允许停用第三方插件');
      }
      if (this.compositionError) throw new PluginApiError('E_INVALID_INPUT', '请先在「查看完整组合」中恢复组合配置');
      const pluginId = record.info.id;
      let candidate: LoadedPluginRecord = { ...record, info: { ...record.info, enabled }, runtime: undefined };
      if (enabled && !record.info.builtin) {
        if (!record.packageRoot) throw new Error('请先修复或回退损坏的插件');
        const pack = readPluginPackage(record.packageRoot);
        if (record.packageRoot !== record.info.devSourceDir && record.digest !== pack.digest) {
          throw new Error('插件文件已变更，请重新预览并安装');
        }
        const occupied = new Map(this.plugins);
        occupied.delete(pluginId);
        this.validateManifest(pack.manifest, occupied);
        candidate = await this.prepare(pack, record.packageRoot, record.info.sourcePath!, true, Boolean(record.info.canRollback));
        if (record.info.devMode) {
          candidate.info.devMode = true;
          candidate.info.devSourceDir = record.info.devSourceDir;
          candidate.info.devTrustedLocal = record.info.devTrustedLocal;
        }
      }
      try {
        this.composition.setEnabled(id, enabled, this.installedNames());
      } catch (error) {
        if (candidate.runtime !== record.runtime) candidate.runtime?.retire();
        throw error;
      }
      if (enabled) this.isolated?.clearCrashHistory(id);
      const nextPlugins = new Map(this.plugins);
      if (id === pluginId) nextPlugins.set(pluginId, candidate);
      await this.activate(nextPlugins);
      if (!enabled) await this.isolated?.awaitPendingDisposals();
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
      if (this.safeComposition) throw new PluginApiError('E_NOT_SUPPORTED', '请正常启动后安装插件');
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
      // Candidate-ready-first upgrade: commit saved revision pointer ONLY after candidate is ready!
      const status = this.host.status(id);
      const awaitingProvidePermission = (candidate.info.provides ?? []).some(
        (service) => isBuiltinPublicService(service) && !this.permissions?.isGranted(candidate.info, `service:provide:${service}`, GLOBAL_WORKSPACE_SCOPE),
      );
      const provideConflict = Boolean(status?.error && (status.error.includes('E_CONFLICT') || status.error.includes('已经')));
      if (enabled && candidate.info.main && status?.state === 'FAILED' && !awaitingProvidePermission && !provideConflict) {
        const failMessage = status.error ?? '隔离插件激活失败';
        await this.isolated?.awaitPendingDisposals();
        if (!pointer && !previous) {
          try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup */ }
        }
        this.removeRevision(root, revision);
        const restored = new Map(this.plugins);
        if (old) restored.set(id, old);
        else restored.delete(id);
        await this.activate(restored);
        throw new Error(failMessage);
      }
      writeRevisionPointer(root, { current: revision, previous, currentDigest: candidate.digest, previousDigest,
        currentTrusted: trusted, previousTrusted: pointer?.currentTrusted });
      if (pointer?.previous) this.removeRevision(root, pointer.previous);
      return this.listInstalled();
    });
  }

  rollbackPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const dev = this.devWatcher.get(id);
      if (dev) {
        if (!dev.previous || !dev.current) throw new Error('没有可回退的开发版本');
        await this.activateDevRevision({ ...dev, current: dev.previous, previous: dev.current });
        return this.listInstalled();
      }
      const previousRecords = new Map(this.plugins);
      const current = previousRecords.get(id);
      const root = current?.info.sourcePath;
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
      const occupied = new Map(previousRecords);
      occupied.delete(id);
      this.validateManifest(pack.manifest, occupied);
      const currentPackage = current?.runtime && current.packageRoot ? readPluginPackage(current.packageRoot) : undefined;
      if (currentPackage && currentPackage.digest !== current?.digest) {
        throw new Error('当前版本文件已变更，请在安全模式中回退');
      }
      const candidate = await this.prepare(pack, directory, root, this.desiredEnabled(pack.manifest.id, false), true);
      this.isolated?.clearCrashHistory(id);
      try {
        await this.activate(new Map(previousRecords).set(id, candidate));
        const status = this.host.status(id);
        if (candidate.info.enabled && status?.state !== 'ACTIVE') {
          throw new Error(status?.error || '回退版本未就绪，请检查授权或服务依赖');
        }
        writeRevisionPointer(root, { current: pointer.previous, previous: pointer.current,
          currentDigest: pack.digest, previousDigest: pointer.currentDigest,
          currentTrusted: pointer.previousTrusted, previousTrusted: pointer.currentTrusted });
      } catch (error) {
        candidate.runtime?.retire();
        if (currentPackage && current?.packageRoot) {
          const restored = await this.prepare(currentPackage, current.packageRoot, root, current.info.enabled, true);
          previousRecords.set(id, restored);
        }
        await this.activate(previousRecords);
        await this.isolated?.awaitPendingDisposals();
        throw error;
      }
      await this.isolated?.awaitPendingDisposals();
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

  previewDevPlugin(dirPath: string): { dirPath: string; id: string; name: string; hasBackend: boolean } {
    const resolved = fs.realpathSync(dirPath);
    const { manifest } = readPluginPackage(resolved);
    this.validateManifest(manifest);
    return { dirPath: resolved, id: manifest.id, name: manifest.name, hasBackend: Boolean(manifest.main) };
  }

  private devRevisionRoot(id: string): string {
    const root = path.join(this.pluginsDir, `.dev-${id}`);
    this.checkPluginRoot(root);
    return root;
  }

  private async prepareDevRevision(
    link: DevPluginLink, enabled: boolean, occupied: ReadonlyMap<string, LoadedPluginRecord>,
  ): Promise<LoadedPluginRecord> {
    const directory = link.current
      ? revisionDirectory(this.devRevisionRoot(link.id), link.current.revision)
      : link.dirPath;
    const pack = readPluginPackage(directory);
    if (pack.manifest.id !== link.id || (link.current && pack.digest !== link.current.digest)) {
      throw new PluginApiError('E_CONFLICT', '开发插件的 ID 或保存版本摘要不匹配');
    }
    if (link.trustedLocal && (!pack.manifest.main || !link.current)) {
      throw new PluginApiError('E_NOT_SUPPORTED', '可信本地运行须使用带 main 的代码插件');
    }
    this.validateManifest(pack.manifest, new Map(occupied));
    const record = await this.prepare(pack, directory, link.dirPath, enabled, Boolean(link.previous));
    Object.assign(record.info, { devMode: true, devSourceDir: link.dirPath, devTrustedLocal: link.trustedLocal });
    return record;
  }

  private async activateDevRevision(link: DevPluginLink): Promise<void> {
    const previous = new Map(this.plugins);
    const existing = previous.get(link.id);
    const enabled = this.desiredEnabled(link.id, false);
    const candidate = await this.prepareDevRevision(link, enabled, previous);
    this.isolated?.clearCrashHistory(link.id);
    try {
      await this.activate(new Map(previous).set(link.id, candidate));
      await this.isolated?.awaitPendingDisposals();
      const status = this.host.status(link.id);
      const awaitingPermission = candidate.info.provides?.some(
        (service) => isBuiltinPublicService(service) &&
          !this.permissions?.isGranted(candidate.info, `service:provide:${service}`, GLOBAL_WORKSPACE_SCOPE),
      );
      const waitingForSetup = !existing?.digest && (awaitingPermission || status?.state === 'PENDING');
      if (enabled && status?.state !== 'ACTIVE' && !waitingForSetup) {
        throw new Error(status?.error || '候选版本未就绪，请检查授权或服务依赖');
      }
      this.devWatcher.set(link);
    } catch (error) {
      candidate.runtime?.retire();
      if (existing?.runtime && !existing.runtime.reusable && existing.packageRoot) {
        const saved = readPluginPackage(existing.packageRoot);
        const restored = await this.prepare(saved, existing.packageRoot, existing.info.sourcePath!,
          existing.info.enabled, Boolean(existing.info.canRollback));
        previous.set(link.id, { ...restored, info: existing.info });
      }
      await this.activate(previous);
      await this.isolated?.awaitPendingDisposals();
      throw error;
    }
  }

  private async stageDevRevision(link: DevPluginLink, pack: PluginPackage): Promise<void> {
    const root = this.devRevisionRoot(link.id);
    const revision = writeRevision(root, pack.files);
    try {
      await this.activateDevRevision({
        ...link,
        previous: link.current,
        current: { revision, digest: pack.digest },
      });
    } catch (error) {
      this.removeRevision(root, revision);
      throw error;
    }
    if (link.previous) this.removeRevision(root, link.previous.revision);
  }

  linkDevPlugin(dirPath: string, trustedId?: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      if (this.safeComposition) throw new PluginApiError('E_NOT_SUPPORTED', '请正常启动后关联开发插件');
      const resolvedDir = fs.realpathSync(dirPath);
      const pack = readPluginPackage(resolvedDir);
      const id = pack.manifest.id;
      if (trustedId && (trustedId !== id || resolvedDir !== dirPath)) {
        throw new PluginApiError('E_CONFLICT', '开发目录或插件 ID 已变更，请重新确认信任');
      }
      if (trustedId && !this.isolated) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用代码插件进程');
      this.validateManifest(pack.manifest);
      const existing = this.devWatcher.get(id);
      const sameSource = existing?.dirPath === resolvedDir ? existing : undefined;
      const trustedLocal = Boolean(trustedId || sameSource?.trustedLocal);
      const link: DevPluginLink = { ...sameSource, id, dirPath: resolvedDir, linkedAt: Date.now(), trustedLocal };
      if (sameSource?.current?.digest === pack.digest && sameSource.trustedLocal === trustedLocal) {
        await this.activateDevRevision(link);
      } else {
        await this.stageDevRevision(link, pack);
      }
      if (!sameSource && existing) this.removeDevRevisions(existing);
      this.appendHostLog(id, 'info', `已关联${trustedLocal ? '可信本地' : ''}开发目录: ${resolvedDir}`);
      return this.listInstalled();
    });
  }

  reloadDevPlugin(id: string, force = true): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      if (this.safeComposition) throw new PluginApiError('E_NOT_SUPPORTED', '请正常启动后重载开发插件');
      const link = this.devWatcher.get(id);
      if (!link) throw new PluginApiError('E_INVALID_INPUT', `插件 ${id} 未处于开发模式`);
      try {
        if (!this.desiredEnabled(id, false)) return this.listInstalled();
        if (fs.realpathSync(link.dirPath) !== link.dirPath) {
          throw new PluginApiError('E_CONFLICT', '开发目录已指向其他位置，请重新关联');
        }
        const pack = readPluginPackage(link.dirPath);
        if (pack.manifest.id !== id) {
          throw new PluginApiError('E_CONFLICT', `开发目录清单 ID (${pack.manifest.id}) 与已关联 ID (${id}) 不一致`);
        }
        if (link.current?.digest === pack.digest) {
          if (!force) return this.listInstalled();
          this.restartGeneration.set(id, (this.restartGeneration.get(id) ?? 0) + 1);
          await this.activateDevRevision(link);
        } else {
          await this.stageDevRevision(link, pack);
        }
        this.appendHostLog(id, 'info', `开发模式热重载完成 (v${pack.manifest.version}, digest ${pack.digest.slice(0, 8)})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendHostLog(id, 'error', `开发模式热重载失败: ${message}`);
        const existing = this.plugins.get(id);
        if (existing) existing.info.loadError = message;
        throw error;
      }
      return this.listInstalled();
    });
  }

  revokeDevTrust(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const link = this.devWatcher.get(id);
      if (!link?.trustedLocal) throw new PluginApiError('E_INVALID_INPUT', '插件未获得可信本地授权');
      this.devWatcher.set({ ...link, trustedLocal: false });
      const next = new Map(this.plugins);
      const record = next.get(id);
      if (record) {
        this.isolated?.clearCrashHistory(id);
        next.set(id, { ...record, info: { ...record.info, devTrustedLocal: false } });
        await this.activate(next);
        await this.isolated?.awaitPendingDisposals();
      }
      this.appendHostLog(id, 'info', '已撤销可信本地授权');
      return this.listInstalled();
    });
  }

  private removeDevRevisions(link: DevPluginLink): void {
    for (const saved of [link.current, link.previous]) {
      if (saved) this.removeRevision(this.devRevisionRoot(link.id), saved.revision);
    }
  }

  unlinkDevPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const link = this.devWatcher.get(id);
      const existed = this.devWatcher.unlink(id);
      if (!existed && !this.plugins.get(id)?.info.devMode) {
        throw new PluginApiError('E_INVALID_INPUT', `插件 ${id} 未处于开发模式`);
      }
      this.isolated?.clearCrashHistory(id);
      const next = new Map(this.plugins);
      next.delete(id);
      await this.activate(next);
      await this.isolated?.awaitPendingDisposals();
      if (link) this.removeDevRevisions(link);
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
    const plugins = req.linkDevMode && req.template !== 'browser-workspace'
      ? await this.linkDevPlugin(writtenDir) : this.listInstalled();
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
