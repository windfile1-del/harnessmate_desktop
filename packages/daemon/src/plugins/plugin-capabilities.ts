import { activeRequestBrokers, getRequestBroker } from './requests-default/index.js';
import { createHash, randomBytes } from 'node:crypto';
import { PEER_CONTRACTS, PluginApiError } from '@harnessmate/plugin-api';
import type { InstalledPluginInfo, PluginAction, PluginPermission, PluginProgram, Session, SetPluginPermissionRequest } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';
import type { PluginMcpConnection } from '../harnesses/types.js';
import { PluginPermissionService } from '../plugin-host/permissions/permissions.js';
import type { ModelToolRouter } from '../plugin-host/builtin/harness-integration.js';
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
      instanceId: string;
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
  readonly ownerInstanceId?: string;
  readonly generation?: string;
  readonly isHarnessCurrent?: () => boolean;
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
  private readonly routerGenerations = new Map<string, string>();
  readonly permissions: PluginPermissionService;

  constructor(
    private readonly store: HarnessMateStore,
    private readonly plugins: PluginManager,
    private readonly getMcpUrl: () => string,
    permissions?: PluginPermissionService,
  ) {
    this.permissions = permissions ?? plugins.permissions ?? new PluginPermissionService(store);
  }

  createToolRouter(instanceId: string) {
    const generation = randomBytes(16).toString('hex');
    this.routerGenerations.set(instanceId, generation);
    return {
      instanceId,
      generation,
      list: this.getTools.bind(this),
      prepareLease: (session: Session, harnessId: string, tools: ToolDescriptor[], isHarnessCurrent: () => boolean) =>
        this.openLease(session, harnessId, tools, { instanceId, generation, isHarnessCurrent }),
      invoke: this.invokeTool.bind(this),
      release: (lease: PluginToolLease) => lease.release(),
      stop: () => {
        if (this.routerGenerations.get(instanceId) === generation) this.routerGenerations.delete(instanceId);
        for (const lease of this.leases.values()) {
          if (lease.ownerInstanceId === instanceId && lease.generation === generation) lease.release();
        }
      },
    };
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
        name: makeMcpToolName(isolatedTool.instanceId, isolatedTool.name),
        description: isolatedTool.description,
        readOnly: Boolean(isolatedTool.readOnly),
        inputSchema: isolatedTool.inputSchema,
        pluginId: isolatedTool.pluginId,
        instanceId: isolatedTool.instanceId,
        packageDigest: isolatedTool.packageDigest,
        runId: isolatedTool.runId,
        toolName: isolatedTool.name,
        permission,
      });
    }

    return descriptors.sort((a, b) => a.name.localeCompare(b.name));
  }

  openLease(session: Session, harnessId: string, tools: ToolDescriptor[], owner?: {
    instanceId: string; generation: string; isHarnessCurrent: () => boolean;
  }): PluginToolLease {
    if (owner && this.routerGenerations.get(owner.instanceId) !== owner.generation) {
      throw new PluginApiError('E_STALE_RUN', '会话工具实例已停止');
    }
    const token = randomBytes(32).toString('base64url');
    const lease: PluginToolLease = { sessionId: session.id, harnessId, tools, connection: { url: this.getMcpUrl(), token },
      ownerInstanceId: owner?.instanceId, generation: owner?.generation, isHarnessCurrent: owner?.isHarnessCurrent,
      release: () => {
        this.leases.delete(token);
        if (owner) for (const broker of activeRequestBrokers(this.plugins)) broker.cancelSession(session.id, 'model_tool_lease_released', owner.generation);
      } };
    this.leases.set(token, lease);
    return lease;
  }

  getLease(authorization: string | undefined): PluginToolLease | undefined {
    const lease = authorization?.startsWith('Bearer ') ? this.leases.get(authorization.slice(7)) : undefined;
    return lease && this.isLeaseActive(lease) ? lease : undefined;
  }

  isLeaseActive(lease: PluginToolLease): boolean {
    if (this.leases.get(lease.connection.token) !== lease) return false;
    if (lease.isHarnessCurrent && !lease.isHarnessCurrent()) return false;
    if (!lease.ownerInstanceId) return true;
    if (this.routerGenerations.get(lease.ownerInstanceId) !== lease.generation) return false;
    if (!this.plugins.resolveServiceSelection) return true;
    const selection = this.plugins.resolveServiceSelection(PEER_CONTRACTS.sessionModelTools, { sessionId: lease.sessionId });
    return selection.status === 'ready' && selection.instanceId === lease.ownerInstanceId;
  }

  listLeaseTools(lease: PluginToolLease): ToolDescriptor[] {
    if (!this.isLeaseActive(lease)) return [];
    const session = this.store.getSession(lease.sessionId);
    if (!session || session.harnessId !== lease.harnessId || session.status === 'archived') return [];
    const current = lease.ownerInstanceId
      ? this.getLeaseRouter(lease)?.list(session) ?? []
      : this.getTools(session);
    return lease.tools.filter((tool) => current.some((candidate) => {
      if (candidate.kind !== tool.kind) return false;
      if (candidate.permission.pluginId !== tool.permission.pluginId ||
          candidate.permission.capability !== tool.permission.capability ||
          candidate.permission.digest !== tool.permission.digest) return false;
      if (candidate.kind === 'isolated' && tool.kind === 'isolated') {
        return candidate.instanceId === tool.instanceId && candidate.runId === tool.runId && candidate.toolName === tool.toolName;
      }
      return true;
    }));
  }

  private getLeaseRouter(lease: PluginToolLease): ModelToolRouter | undefined {
    if (!lease.ownerInstanceId) return undefined;
    return this.plugins.host.getServiceByInstance<ModelToolRouter>(lease.ownerInstanceId, PEER_CONTRACTS.sessionModelTools);
  }

  async dispatchLeaseTool(lease: PluginToolLease, name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isLeaseActive(lease)) throw new PluginApiError('E_STALE_RUN', '会话工具租约已失效');
    if (!lease.ownerInstanceId) return this.invokeTool(lease, name, args);
    const router = this.getLeaseRouter(lease);
    if (!router || router.generation !== lease.generation) {
      throw new PluginApiError('E_STALE_RUN', '会话工具实例已换代');
    }
    return router.invoke(lease, name, args);
  }

  async invokeTool(lease: PluginToolLease, name: string, args: Record<string, unknown>): Promise<string> {
    const session = this.store.getSession(lease.sessionId);
    if (session?.status !== 'running' && session?.status !== 'awaiting_approval') {
      throw new Error('插件模型工具只在当前会话轮次中可用');
    }
    const tool = this.listLeaseTools(lease).find((entry) => entry.name === name);
    if (!tool) throw new Error('插件工具未授权或版本已变更');

    const broker = getRequestBroker(this.plugins, session.id);
    // Every tool request, including policy allow/deny, has the same persisted CAS fact.
    return await new Promise<string>((resolve, reject) => {
      const id = `appr_model_${randomBytes(8).toString('hex')}`;
      broker.register({ workspaceId: session.workspaceId,
        approval: { id, sessionId: session.id, nativeRequestId: id, kind: 'mcp_tool_approval', toolName: name,
          toolKind: tool.readOnly ? 'file_read' : 'mcp', summary: name, input: args,
          riskLevel: tool.readOnly ? 'low' : 'medium', supportedDecisions: ['allow_once','deny'],
          status: 'pending', createdAt: Date.now(), resolvedAt: null, decision: null, resolvedBy: null, comment: null },
        origin: { providerInstanceId: lease.ownerInstanceId ?? session.harnessId, driverGeneration: lease.generation ?? 'local',
          nativeRequestId: id, turnId: null, connectionId: 'model_tool' },
        deadlineAtMs: Date.now() + 120000, idempotencyKey: id }, {
        deliver: async input => {
          if (input.decision === 'deny') {
            reject(new PluginApiError('E_PERMISSION_DENIED', input.comment ?? '策略或用户拒绝工具请求'));
            return 'acknowledged';
          }
          if (!this.isLeaseActive(lease) || !this.listLeaseTools(lease).includes(tool)) {
            reject(new PluginApiError('E_STALE_RUN', '会话工具授权已变更')); return 'unavailable';
          }
          try {
            let result: string;
            if (tool.kind === 'program') {
              const text = typeof args.text === 'string' && args.text.length <= pluginTextLimit ? args.text : null;
              if (text === null) throw new Error('Invalid tool arguments');
              result = await runPluginProgram(tool.program, text);
            } else {
              if (!this.plugins.isolated) throw new Error('隔离插件运行时不可用');
              result = await this.plugins.isolated.invokeTool(tool.pluginId, tool.runId, tool.toolName, args,
                { sessionId: session.id, workspaceId: session.workspaceId }, tool.instanceId);
            }
            broker.recordExecution(id, 'succeeded'); resolve(result);
          } catch (error) { broker.recordExecution(id, 'failed'); reject(error); }
          return 'acknowledged'; // Authorization delivery and tool outcome are separate facts.
        },
        release: () => reject(new PluginApiError('E_STALE_RUN', '工具请求资源已释放')),
      });
    });
  }
}
