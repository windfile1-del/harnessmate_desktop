import { createHash, randomBytes } from 'node:crypto';
import type { InstalledPluginInfo, PluginAction, PluginPermission, PluginProgram, Session, SetPluginPermissionRequest } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { PluginMcpConnection } from '../harnesses/types.js';
import type { PluginManager } from './plugin-manager.js';
import { runPluginProgram } from './plugin-program.js';

interface ToolDescriptor {
  name: string;
  permission: PluginPermission;
  program: PluginProgram;
}

export interface PluginToolLease {
  readonly sessionId: string;
  readonly harnessId: string;
  readonly connection: PluginMcpConnection;
  readonly tools: ToolDescriptor[];
  discovered?: boolean;
  release(): void;
}

export class PluginCapabilities {
  private readonly leases = new Map<string, PluginToolLease>();

  constructor(private readonly store: HarnessMateStore, private readonly plugins: PluginManager, private readonly getMcpUrl: () => string) {}

  private describe(plugin: InstalledPluginInfo): PluginPermission[] {
    if (!plugin.packageDigest || plugin.apiVersion !== 3) return [];
    const base = { pluginId: plugin.id, pluginName: plugin.name, digest: plugin.packageDigest, granted: false };
    return [
      ...(plugin.contributes.actions ?? []).map((action) => ({ ...base, capability: `action:${action.command}`,
        description: action.kind === 'harness' ? `${action.description} · /${action.nativeCommand}${action.args ? ` ${action.args}` : ''}` : action.description })),
      ...(plugin.contributes.programs ?? []).filter(({ exposeToModel }) => exposeToModel).map((program) => ({ ...base,
        capability: `tool:${program.id}`, description: program.description })),
    ];
  }

  listPermissions(workspaceId: string, pluginId?: string): PluginPermission[] {
    const grants = this.store.getPluginPermissions(workspaceId);
    return this.plugins.listInstalled().filter((plugin) => !pluginId || plugin.id === pluginId)
      .flatMap((plugin) => this.describe(plugin)).map((permission) => ({ ...permission,
        granted: grants.some((grant) => grant.pluginId === permission.pluginId && grant.digest === permission.digest && grant.capability === permission.capability),
      }));
  }

  setPermission(pluginId: string, request: SetPluginPermissionRequest): PluginPermission[] {
    if (!this.store.getWorkspace(request.workspaceId)) throw new Error('工作区不存在');
    const plugin = this.plugins.listInstalled().find(({ id }) => id === pluginId);
    if (!plugin || plugin.packageDigest !== request.digest) throw new Error('插件版本已变更，请刷新授权列表');
    if (!this.describe(plugin).some(({ capability }) => capability === request.capability)) throw new Error('插件未声明此权限');
    this.store.setPluginPermission(request.workspaceId, pluginId, request.digest, request.capability, request.granted);
    return this.listPermissions(request.workspaceId, pluginId);
  }

  listActions(session: Session) {
    const grants = this.store.getPluginPermissions(session.workspaceId);
    return this.plugins.listInstalled().filter((plugin) => plugin.enabled && plugin.packageDigest && plugin.apiVersion === 3)
      .flatMap((plugin) => (plugin.contributes.actions ?? []).map((action) => ({ plugin, action,
        granted: grants.some(({ pluginId, digest, capability }) => pluginId === plugin.id && digest === plugin.packageDigest && capability === `action:${action.command}`),
      })));
  }

  executeProgramAction(plugin: InstalledPluginInfo, action: Extract<PluginAction, { kind: 'program' }>, text: string): string {
    const program = plugin.contributes.programs?.find(({ id }) => id === action.program);
    if (!program) throw new Error('插件处理程序不存在');
    return runPluginProgram(program, text);
  }

  getTools(session: Session): ToolDescriptor[] {
    const approved = this.listPermissions(session.workspaceId).filter(({ granted, capability }) => granted && capability.startsWith('tool:'));
    return this.plugins.listInstalled().filter((plugin) => plugin.enabled).flatMap((plugin) => {
      const prefix = createHash('sha256').update(plugin.id).digest('hex').slice(0, 12);
      return (plugin.contributes.programs ?? []).flatMap((program) => {
        const permission = approved.find((item) => item.pluginId === plugin.id && item.capability === `tool:${program.id}`);
        if (!permission) return [];
        // Keep the identifier within 64 characters after Claude adds the MCP server prefix.
        const suffix = program.id.length <= 16 ? program.id
          : `${program.id.slice(0, 7)}_${createHash('sha256').update(program.id).digest('hex').slice(0, 8)}`;
        return [{ name: `hm_${prefix}_${suffix}`, permission, program }];
      });
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  openLease(session: Session, harnessId: string, tools: ToolDescriptor[]): PluginToolLease {
    const token = randomBytes(32).toString('base64url');
    const lease: PluginToolLease = { sessionId: session.id, harnessId, tools, connection: { url: this.getMcpUrl(), token },
      release: () => { this.leases.delete(token); } };
    this.leases.set(token, lease);
    return lease;
  }

  getLease(authorization: string | undefined): PluginToolLease | undefined {
    return authorization?.startsWith('Bearer ') ? this.leases.get(authorization.slice(7)) : undefined;
  }

  listLeaseTools(lease: PluginToolLease): ToolDescriptor[] {
    const session = this.store.getSession(lease.sessionId);
    if (!session || session.harnessId !== lease.harnessId || session.status === 'archived') return [];
    const current = this.getTools(session);
    return lease.tools.filter((tool) => current.some(({ permission }) => permission.pluginId === tool.permission.pluginId &&
      permission.capability === tool.permission.capability && permission.digest === tool.permission.digest));
  }

  invokeTool(lease: PluginToolLease, name: string, text: string): string {
    const session = this.store.getSession(lease.sessionId);
    if (session?.status !== 'running' && session?.status !== 'awaiting_approval') throw new Error('插件模型工具只在当前会话轮次中可用');
    const tool = this.listLeaseTools(lease).find((entry) => entry.name === name);
    if (!tool) throw new Error('插件工具未授权或版本已变更');
    return runPluginProgram(tool.program, text);
  }
}
