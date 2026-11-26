import { createHash, randomBytes } from 'node:crypto';
import { PEER_CONTRACTS, PluginApiError } from '@harnessmate/plugin-api';
import type { InstalledPluginInfo, PluginAction, PluginPermission, PluginProgram, Session, SetPluginPermissionRequest } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { PluginMcpConnection } from '../harnesses/types.js';
import { PluginPermissionService } from '../plugin-host/permissions/permissions.js';
import type { PluginManager } from './plugin-manager.js';
import { pluginTextLimit, runPluginProgram } from './plugin-program.js';

export type ToolDescriptor =
  | {
      kind: 'program';
      name: string;
      description: string;
      readOnly: boolean;
      inputSchema: Record<string, unknown>;
      permission: PluginPermission;
      program: PluginProgram;
    }
  | {
      kind: 'isolated';
      name: string;
      description: string;
      readOnly: boolean;
      inputSchema: Record<string, unknown>;
      pluginId: string;
      packageDigest: string;
      runId: string;
      toolName: string;
      permission: PluginPermission;
    };

export interface PluginToolLease {
  readonly sessionId: string;
  readonly harnessId: string;
  readonly connection: PluginMcpConnection;
  readonly tools: ToolDescriptor[];
  discovered?: boolean;
  release(): void;
}

function makeMcpToolName(pluginId: string, toolId: string): string {
  const prefix = createHash('sha256').update(pluginId).digest('hex').slice(0, 12);
  // Keep the identifier within 64 characters after Claude adds the MCP server prefix.
  const suffix = toolId.length <= 16 ? toolId
    : `${toolId.slice(0, 7)}_${createHash('sha256').update(toolId).digest('hex').slice(0, 8)}`;
  return `hm_${prefix}_${suffix}`;
}

export class PluginCapabilities {
  private readonly leases = new Map<string, PluginToolLease>();
  readonly permissions: PluginPermissionService;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly plugins: PluginManager,
    private readonly getMcpUrl: () => string,
    permissions?: PluginPermissionService,
  ) {
    this.permissions = permissions ?? plugins.permissions ?? new PluginPermissionService(store);
  }

  listPermissions(workspaceId: string, pluginId?: string): PluginPermission[] {
    return this.plugins.listInstalled()
      .filter((plugin) => !pluginId || plugin.id === pluginId)
      .flatMap((plugin) => this.permissions.resolveForPlugin(plugin, workspaceId));
  }

  async setPermission(pluginId: string, request: SetPluginPermissionRequest): Promise<PluginPermission[]> {
    const plugin = this.plugins.listInstalled().find(({ id }) => id === pluginId);
    if (!plugin) throw new Error('插件不存在');
    const updated = this.permissions.setPermission(plugin, request);
    if (request.capability.startsWith('service:provide:')) {
      await this.plugins.reconcilePermissionsChange(pluginId);
    }
    return updated;
  }

  listActions(session: Session) {
    return this.plugins.listInstalled().filter((plugin) => this.plugins.isPluginEnabled(plugin.id) && plugin.packageDigest)
      .flatMap((plugin) => (plugin.contributes.actions ?? []).map((action) => ({
        plugin,
        action,
        granted: this.permissions.isGranted(plugin, `action:${action.command}`, session.workspaceId),
      })));
  }

  executeProgramAction(plugin: InstalledPluginInfo, action: Extract<PluginAction, { kind: 'program' }>, text: string): string {
    const program = plugin.contributes.programs?.find(({ id }) => id === action.program);
    if (!program) throw new Error('插件处理程序不存在');
    return runPluginProgram(program, text);
  }

  getTools(session: Session): ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];
    const approved = this.listPermissions(session.workspaceId);

    for (const plugin of this.plugins.listInstalled()) {
      if (!this.plugins.isPluginEnabled(plugin.id)) continue;
      for (const program of plugin.contributes.programs ?? []) {
        const permission = approved.find(
          (item) => item.granted && item.pluginId === plugin.id && item.capability === `tool:${program.id}`,
        );
        if (!permission) continue;
        descriptors.push({
          kind: 'program',
          name: makeMcpToolName(plugin.id, program.id),
          description: program.description,
          readOnly: true,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', maxLength: pluginTextLimit } },
            required: ['text'],
            additionalProperties: false,
          },
          permission,
          program,
        });
      }
    }

    for (const isolatedTool of this.plugins.isolated?.listTools(session.workspaceId) ?? []) {
      const permission = approved.find(
        (item) => item.granted && item.pluginId === isolatedTool.pluginId && item.capability === 'tools:model',
      );
      if (!permission) continue;
      descriptors.push({
        kind: 'isolated',
        name: makeMcpToolName(isolatedTool.pluginId, isolatedTool.name),
        description: isolatedTool.description,
        readOnly: Boolean(isolatedTool.readOnly),
        inputSchema: isolatedTool.inputSchema,
        pluginId: isolatedTool.pluginId,
        packageDigest: isolatedTool.packageDigest,
        runId: isolatedTool.runId,
        toolName: isolatedTool.name,
        permission,
      });
    }

    return descriptors.sort((a, b) => a.name.localeCompare(b.name));
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
    return lease.tools.filter((tool) => current.some((candidate) => {
      if (candidate.kind !== tool.kind) return false;
      if (candidate.permission.pluginId !== tool.permission.pluginId ||
          candidate.permission.capability !== tool.permission.capability ||
          candidate.permission.digest !== tool.permission.digest) return false;
      if (candidate.kind === 'isolated' && tool.kind === 'isolated') {
        return candidate.runId === tool.runId && candidate.toolName === tool.toolName;
      }
      return true;
    }));
  }

  async invokeTool(lease: PluginToolLease, name: string, args: Record<string, unknown>): Promise<string> {
    const session = this.store.getSession(lease.sessionId);
    if (session?.status !== 'running' && session?.status !== 'awaiting_approval') {
      throw new Error('插件模型工具只在当前会话轮次中可用');
    }
    const tool = this.listLeaseTools(lease).find((entry) => entry.name === name);
    if (!tool) throw new Error('插件工具未授权或版本已变更');

    // Enforce session-selected approval.policy.v1 plugin decision in kernel
    const policyBinding = this.plugins.resolveCapabilityBinding(PEER_CONTRACTS.approvalPolicy, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
    });
    if (policyBinding.instanceId && this.plugins.isolated) {
      const policyActive = this.plugins.isolated.getActive(policyBinding.instanceId);
      if (!policyActive?.process.alive) {
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', `审批策略实例 ${policyBinding.instanceId} 暂不可用`);
      }
      const decision = await this.plugins.isolated.invokeApprovalPolicy(policyBinding.instanceId, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        pluginId: tool.permission.pluginId,
        instanceId: tool.permission.pluginId,
        toolName: tool.kind === 'isolated' ? tool.toolName : tool.name,
        readOnly: tool.readOnly,
        args,
      });
      if (decision.decision !== 'allow') {
        throw new PluginApiError(
          'E_PERMISSION_DENIED',
          decision.reason || `审批策略 (${policyBinding.instanceId}) 拒绝执行工具 ${name}`,
        );
      }
    }

    if (tool.kind === 'program') {
      const text = typeof args.text === 'string' && args.text.length <= pluginTextLimit ? args.text : null;
      if (text === null) throw new Error('Invalid tool arguments');
      return runPluginProgram(tool.program, text);
    }
    if (!this.plugins.isolated) throw new Error('隔离插件运行时不可用');
    return await this.plugins.isolated.invokeTool(
      tool.pluginId,
      tool.runId,
      tool.toolName,
      args,
      { sessionId: session.id, workspaceId: session.workspaceId },
    );
  }
}
