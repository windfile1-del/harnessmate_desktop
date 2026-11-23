import {
  PluginApiError,
  isBuiltinPublicService,
  isReservedServiceName,
  type PluginManifest,
} from '@harnessmate/plugin-api';
import type { InstalledPluginInfo, PluginPermission, SetPluginPermissionRequest } from '@harnessmate/protocol';
import type { HarnessMateStore, StoredPluginPermission } from '../../db/sqlite.js';

export const GLOBAL_WORKSPACE_SCOPE = '__global__';

export interface PermissionMeta {
  description: string;
  risk: 'low' | 'medium' | 'high';
  scope: 'workspace' | 'global';
}

const STATIC_PERMISSION_META: Record<string, PermissionMeta> = {
  'events:turn': { description: '订阅轮次生命周期公共事件', risk: 'low', scope: 'workspace' },
  'events:message': { description: '订阅用户与助手消息公共事件', risk: 'medium', scope: 'workspace' },
  'events:tool': { description: '订阅工具调用完成公共事件', risk: 'medium', scope: 'workspace' },
  'events:approval': { description: '订阅审批请求公共事件', risk: 'medium', scope: 'workspace' },
  'session:read': { description: '读取会话列表、元数据、历史与任务账本', risk: 'medium', scope: 'workspace' },
  'session:command': { description: '运行白名单原生 Harness 命令', risk: 'medium', scope: 'workspace' },
  'session:send': { description: '准备一轮待用户确认发送的对话', risk: 'medium', scope: 'workspace' },
  'composer:suggest': { description: '向输入区提议文本或附加块', risk: 'low', scope: 'workspace' },
  'handoff:section': { description: '向交接快照追加用户侧上下文段落', risk: 'low', scope: 'workspace' },
  'approvals:annotate': { description: '为审批项添加风险标注（不能替用户审批）', risk: 'low', scope: 'workspace' },
  'storage:plugin': { description: '读写插件私有持久化存储', risk: 'low', scope: 'global' },
  'storage:workspace': { description: '读写按工作区隔离的插件存储', risk: 'low', scope: 'workspace' },
  'fs:workspace:read': { description: '读取工作区内的文件与目录', risk: 'medium', scope: 'workspace' },
  'fs:workspace:write': { description: '写入工作区内的文件', risk: 'high', scope: 'workspace' },
  notify: { description: '发送桌面通知', risk: 'low', scope: 'global' },
  'clipboard:write': { description: '写入系统剪贴板', risk: 'low', scope: 'global' },
  'browser:preview': { description: '在独立 Chromium 中显示和操作 HTTP(S) 页面，包括本机开发页面', risk: 'medium', scope: 'global' },
  'tools:model': { description: '通过官方 MCP 通道向模型注册会话级工具', risk: 'medium', scope: 'workspace' },
};

export function describePermission(capability: string): PermissionMeta {
  if (STATIC_PERMISSION_META[capability]) return STATIC_PERMISSION_META[capability]!;
  if (capability.startsWith('net:')) {
    const host = capability.slice(4);
    return { description: `访问外部域名 ${host}`, risk: 'medium', scope: 'workspace' };
  }
  if (capability.startsWith('service:provide:')) {
    const service = capability.slice('service:provide:'.length);
    const label = isBuiltinPublicService(service)
      ? `作为公共服务 ${service} 的提供方（可替换内置提供方）`
      : `提供第三方服务 ${service}`;
    return { description: label, risk: 'medium', scope: 'global' };
  }
  if (capability.startsWith('action:')) {
    return { description: `执行声明式动作 /${capability.slice(7)}`, risk: 'medium', scope: 'workspace' };
  }
  if (capability.startsWith('tool:')) {
    return { description: `向模型暴露声明式工具 ${capability.slice(5)}`, risk: 'medium', scope: 'workspace' };
  }
  return { description: capability, risk: 'medium', scope: 'workspace' };
}

export function isGlobalCapability(capability: string): boolean {
  return describePermission(capability).scope === 'global';
}

export function declaredCapabilities(manifest: PluginManifest): string[] {
  const result = new Set<string>();
  for (const permission of manifest.permissions ?? []) result.add(permission);
  for (const service of manifest.provides ?? []) {
    if (isBuiltinPublicService(service)) result.add(`service:provide:${service}`);
  }
  if (manifest.apiVersion === 3 || manifest.apiVersion === 4) {
    for (const action of manifest.contributes.actions ?? []) result.add(`action:${action.command}`);
    for (const program of manifest.contributes.programs ?? []) {
      if (program.exposeToModel) result.add(`tool:${program.id}`);
    }
  }
  return [...result].sort();
}

export function describePluginCapabilities(plugin: InstalledPluginInfo): PluginPermission[] {
  if (!plugin.packageDigest || plugin.builtin) return [];
  const base = { pluginId: plugin.id, pluginName: plugin.name, digest: plugin.packageDigest, granted: false };
  const items = new Map<string, PluginPermission>();

  if (plugin.apiVersion === 3 || plugin.apiVersion === 4) {
    for (const action of plugin.contributes.actions ?? []) {
      const capability = `action:${action.command}`;
      items.set(capability, {
        ...base,
        capability,
        risk: 'medium',
        scope: 'workspace',
        description: action.kind === 'harness'
          ? `${action.description} · /${action.nativeCommand}${action.args ? ` ${action.args}` : ''}`
          : action.description,
      });
    }
    for (const program of (plugin.contributes.programs ?? []).filter(({ exposeToModel }) => exposeToModel)) {
      const capability = `tool:${program.id}`;
      items.set(capability, {
        ...base,
        capability,
        risk: 'medium',
        scope: 'workspace',
        description: program.description,
      });
    }
  }

  for (const capability of declaredCapabilities(plugin)) {
    if (items.has(capability)) continue;
    const meta = describePermission(capability);
    items.set(capability, {
      ...base,
      capability,
      description: meta.description,
      risk: meta.risk,
      scope: meta.scope,
    });
  }

  return [...items.values()];
}

function isSubset(current: readonly string[], approved: readonly string[]): boolean {
  if (approved.length === 0) return false;
  const approvedSet = new Set(approved);
  return current.every((item) => approvedSet.has(item));
}

function matchesLegacyMigration(
  grant: StoredPluginPermission,
  capability: string,
  currentDeclared: readonly string[],
): boolean {
  if (!grant.coverFuture) return false;
  // Section 18: V3 `tool:*` migrates to `tools:model`; V3 `action:*` migrates to `session:command`
  const migratedSet = new Set(grant.declaredPermissions);
  if (grant.capability.startsWith('tool:')) migratedSet.add('tools:model');
  if (grant.capability.startsWith('action:')) migratedSet.add('session:command');
  const equivalent =
    (capability === 'tools:model' && grant.capability.startsWith('tool:')) ||
    (capability === 'session:command' && grant.capability.startsWith('action:'));
  if (!equivalent) return false;
  return currentDeclared.every((item) => migratedSet.has(item));
}

export class PluginPermissionService {
  constructor(private readonly store: HarnessMateStore) {}

  private matchGrant(
    grants: readonly StoredPluginPermission[],
    plugin: InstalledPluginInfo,
    capability: string,
    currentDeclared: readonly string[],
  ): StoredPluginPermission | undefined {
    const exact = grants.find(
      (grant) => grant.pluginId === plugin.id && grant.capability === capability && grant.digest === plugin.packageDigest,
    );
    if (exact) return exact;

    const covered = grants.find(
      (grant) =>
        grant.pluginId === plugin.id &&
        grant.capability === capability &&
        grant.coverFuture &&
        isSubset(currentDeclared, grant.declaredPermissions),
    );
    if (covered) return covered;

    return grants.find(
      (grant) => grant.pluginId === plugin.id && matchesLegacyMigration(grant, capability, currentDeclared),
    );
  }

  resolveForPlugin(plugin: InstalledPluginInfo, workspaceId?: string): PluginPermission[] {
    const described = describePluginCapabilities(plugin);
    if (!described.length) return [];
    const currentDeclared = declaredCapabilities(plugin);
    const globalGrants = this.store.getGlobalPluginPermissions();
    const workspaceGrants = workspaceId && workspaceId !== GLOBAL_WORKSPACE_SCOPE
      ? this.store.getPluginPermissions(workspaceId)
      : [];

    return described.map((item) => {
      const pool = item.scope === 'global' || workspaceId === GLOBAL_WORKSPACE_SCOPE
        ? [...globalGrants, ...workspaceGrants]
        : workspaceGrants;
      const grant = this.matchGrant(pool, plugin, item.capability, currentDeclared);
      return {
        ...item,
        granted: Boolean(grant),
        coverFuture: grant?.coverFuture ?? false,
        ...(grant && grant.digest !== plugin.packageDigest ? { inheritedFromDigest: grant.digest } : {}),
      };
    });
  }

  isGranted(plugin: InstalledPluginInfo, capability: string, workspaceId?: string): boolean {
    if (plugin.builtin) return true;
    if (!plugin.packageDigest) return false;
    // Section 18: V1 entry + onEvent auto-granted events:turn
    if (plugin.entry && capability === 'events:turn') return true;
    if (capability.startsWith('service:provide:')) {
      const service = capability.slice('service:provide:'.length);
      if (isReservedServiceName(service)) return false;
    }

    const currentDeclared = declaredCapabilities(plugin);
    if (!currentDeclared.includes(capability)) {
      // Allow net:<host> check only when declared; also allow V3 implicit checks via exact capability
      return false;
    }

    const globalGrants = this.store.getGlobalPluginPermissions();
    if (isGlobalCapability(capability) || workspaceId === GLOBAL_WORKSPACE_SCOPE) {
      if (this.matchGrant(globalGrants, plugin, capability, currentDeclared)) return true;
      if (workspaceId && workspaceId !== GLOBAL_WORKSPACE_SCOPE) {
        return Boolean(this.matchGrant(this.store.getPluginPermissions(workspaceId), plugin, capability, currentDeclared));
      }
      return false;
    }

    if (!workspaceId) {
      return Boolean(this.matchGrant(globalGrants, plugin, capability, currentDeclared));
    }
    const workspaceGrants = this.store.getPluginPermissions(workspaceId);
    return Boolean(this.matchGrant(workspaceGrants, plugin, capability, currentDeclared));
  }

  assertGranted(plugin: InstalledPluginInfo, capability: string, workspaceId?: string): void {
    if (!this.isGranted(plugin, capability, workspaceId)) {
      throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得权限 ${capability}`);
    }
  }

  setPermission(plugin: InstalledPluginInfo, request: SetPluginPermissionRequest): PluginPermission[] {
    if (request.workspaceId !== GLOBAL_WORKSPACE_SCOPE && !this.store.getWorkspace(request.workspaceId)) {
      throw new PluginApiError('E_INVALID_INPUT', '工作区不存在');
    }
    if (!plugin.packageDigest || plugin.packageDigest !== request.digest) {
      throw new PluginApiError('E_CONFLICT', '插件版本已变更，请刷新授权列表');
    }
    const described = describePluginCapabilities(plugin);
    if (!described.some(({ capability }) => capability === request.capability)) {
      throw new PluginApiError('E_INVALID_INPUT', '插件未声明此权限');
    }
    const currentDeclared = declaredCapabilities(plugin);
    const opts = { coverFuture: Boolean(request.coverFuture), declaredPermissions: currentDeclared };
    if (isGlobalCapability(request.capability) || request.workspaceId === GLOBAL_WORKSPACE_SCOPE) {
      this.store.setGlobalPluginPermission(plugin.id, request.digest, request.capability, request.granted, opts);
      // Clean up any legacy workspace-scoped duplicate if revoking
      if (!request.granted && request.workspaceId !== GLOBAL_WORKSPACE_SCOPE) {
        this.store.setPluginPermission(request.workspaceId, plugin.id, request.digest, request.capability, false);
      }
    } else {
      this.store.setPluginPermission(request.workspaceId, plugin.id, request.digest, request.capability, request.granted, opts);
    }
    return this.resolveForPlugin(plugin, request.workspaceId);
  }
}
