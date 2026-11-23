import fs from 'node:fs';
import path from 'node:path';
import {
  PluginApiError,
  pluginEventContracts,
  type PluginEventName,
  type PluginEventV4,
  type PublicApprovalAnnotationInput,
  type PublicComposerSuggestion,
  type PublicFsEntry,
  type PublicFsStat,
  type PublicNetInit,
  type PublicNetResponse,
  type PublicSession,
  type PublicSessionCapabilities,
  type PublicTaskLedger,
  type PublicTaskLedgerAppend,
} from '@harnessmate/plugin-api';
import { PluginNativeCommandSchema, type InstalledPluginInfo, type Session, type SessionTaskState } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { TaskLedgerService } from '../../core/task-ledger-service.js';
import type { PluginPermissionService } from '../permissions/permissions.js';
import type { PluginHost } from '../runtime/lifecycle.js';
import { toPluginEvent } from '../runtime/map-event.js';

const MAX_FS_BYTES = 2 * 1024 * 1024;
const MAX_NET_BYTES = 2 * 1024 * 1024;
const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_LOGS_PER_PLUGIN = 200;

export interface PluginLogEntry {
  timestamp: number;
  pluginId: string;
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

export interface PluginRouterDeps {
  store: HarnessMateStore;
  host: PluginHost;
  permissions: PluginPermissionService;
  getPluginInfo: (pluginId: string) => InstalledPluginInfo | undefined;
  isCurrentRun: (pluginId: string, runId: string) => boolean;
  onSubscriptionChange?: (pluginId: string, runId: string, event: string, subscribed: boolean) => void;
  onComposerSuggest?: (pluginId: string, sessionId: string, suggestion: PublicComposerSuggestion) => void;
  onNotify?: (pluginId: string, input: { title: string; body?: string; level?: 'info' | 'warn' | 'error' }) => void;
  onClipboardWrite?: (pluginId: string, text: string) => void;
  runNativeCommand?: (sessionId: string, command: string, args?: string) => Promise<{ output?: string; notice?: string }>;
  onDynamicUnregister?: (pluginId: string, runId: string, kind: 'service' | 'command' | 'tool' | 'section' | 'slot', name: string) => void;
}

function toPublicSession(session: Session): PublicSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    harnessId: session.harnessId,
    harnessKind: session.harnessKind,
    title: session.title,
    status: session.status,
    model: session.model,
    permissionMode: session.permissionMode,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toPublicLedger(state: SessionTaskState): PublicTaskLedger {
  return {
    sessionId: state.sessionId,
    objective: state.objective,
    steps: state.steps.map(({ id, title, status }) => ({ id, title, status })),
    decisions: [...state.decisions],
    touchedFiles: [...state.touchedFiles],
    blockers: [...state.blockers],
    pinnedFacts: [...state.pinnedFacts],
    version: state.version,
    updatedAt: state.updatedAt,
  };
}

function resolveWorkspacePath(rootPath: string, relativePath: string, mustExist: boolean): { fullPath: string; rel: string } {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new PluginApiError('E_INVALID_INPUT', '无效的文件路径');
  }
  const realRoot = fs.realpathSync(rootPath);
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = path.resolve(realRoot, cleaned);
  const relFromRoot = path.relative(realRoot, candidate);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止访问工作区之外的路径');
  }
  if (relFromRoot === '.git' || relFromRoot.startsWith(`.git${path.sep}`)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止直接访问 .git 目录');
  }
  if (fs.existsSync(candidate)) {
    const realTarget = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PluginApiError('E_PERMISSION_DENIED', '禁止通过符号链接逃逸工作区');
    }
    return { fullPath: realTarget, rel: realRel.replace(/\\/g, '/') };
  }
  if (mustExist) {
    throw new PluginApiError('E_INVALID_INPUT', `路径不存在: ${cleaned}`);
  }
  // Check nearest existing parent directory for symlink escape
  let parent = path.dirname(candidate);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (fs.existsSync(parent)) {
    const realParent = fs.realpathSync(parent);
    const parentRel = path.relative(realRoot, realParent);
    if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
      throw new PluginApiError('E_PERMISSION_DENIED', '禁止写入工作区之外的路径');
    }
  }
  return { fullPath: candidate, rel: relFromRoot.replace(/\\/g, '/') };
}

export class IsolatedPluginRpcRouter {
  private readonly logs = new Map<string, PluginLogEntry[]>();
  private readonly pendingSuggestions = new Map<string, Array<{ pluginId: string; suggestion: PublicComposerSuggestion; createdAt: number }>>();
  private readonly preparedTurns = new Map<string, Array<{ pluginId: string; text: string; parts?: Array<{ label: string; text: string }>; createdAt: number }>>();
  readonly notifications: Array<{ pluginId: string; title: string; body?: string; level: string; timestamp: number }> = [];
  readonly clipboardWrites: Array<{ pluginId: string; text: string; timestamp: number }> = [];

  constructor(private readonly deps: PluginRouterDeps) {}

  getLogs(pluginId: string): PluginLogEntry[] {
    return [...(this.logs.get(pluginId) ?? [])];
  }

  getAllLogs(): PluginLogEntry[] {
    return [...this.logs.values()].flat().sort((a, b) => a.timestamp - b.timestamp);
  }

  clearLogs(pluginId?: string): void {
    if (pluginId) this.logs.delete(pluginId);
    else this.logs.clear();
  }

  getComposerSuggestions(sessionId: string) {
    return [...(this.pendingSuggestions.get(sessionId) ?? [])];
  }

  getPreparedTurns(sessionId: string) {
    return [...(this.preparedTurns.get(sessionId) ?? [])];
  }

  private appendLog(entry: PluginLogEntry): void {
    const list = this.logs.get(entry.pluginId) ?? [];
    list.push(entry);
    if (list.length > MAX_LOGS_PER_PLUGIN) list.splice(0, list.length - MAX_LOGS_PER_PLUGIN);
    this.logs.set(entry.pluginId, list);
  }

  private getSessionOrThrow(sessionId: unknown): Session {
    if (typeof sessionId !== 'string' || !sessionId) throw new PluginApiError('E_INVALID_INPUT', '缺少 sessionId');
    const session = this.deps.store.getSession(sessionId);
    if (!session) throw new PluginApiError('E_INVALID_INPUT', `会话不存在: ${sessionId}`);
    return session;
  }

  private getWorkspaceOrThrow(workspaceId: unknown) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new PluginApiError('E_INVALID_INPUT', '缺少 workspaceId');
    const workspace = this.deps.store.getWorkspace(workspaceId);
    if (!workspace) throw new PluginApiError('E_INVALID_INPUT', `工作区不存在: ${workspaceId}`);
    return workspace;
  }

  async handle(
    method: string,
    params: Record<string, unknown>,
    meta: { pluginId: string; runId: string },
  ): Promise<unknown> {
    if (!this.deps.isCurrentRun(meta.pluginId, meta.runId)) {
      throw new PluginApiError('E_STALE_RUN', '插件实例标识已过期');
    }
    const plugin = this.deps.getPluginInfo(meta.pluginId);
    if (!plugin) throw new PluginApiError('E_STALE_RUN', '插件未加载');

    switch (method) {
      case 'log': {
        const level = params.level === 'debug' || params.level === 'warn' || params.level === 'error' ? params.level : 'info';
        this.appendLog({
          timestamp: Date.now(),
          pluginId: meta.pluginId,
          runId: meta.runId,
          level,
          message: String(params.message ?? '').slice(0, 2000),
          meta: params.meta && typeof params.meta === 'object' ? params.meta as Record<string, unknown> : undefined,
        });
        return { ok: true };
      }

      case 'events.subscribe':
      case 'events.unsubscribe': {
        if (typeof params.event === 'string') {
          this.deps.onSubscriptionChange?.(meta.pluginId, meta.runId, params.event, method === 'events.subscribe');
        }
        return { ok: true };
      }

      case 'service.unprovide':
        if (typeof params.name === 'string') this.deps.onDynamicUnregister?.(meta.pluginId, meta.runId, 'service', params.name);
        return { ok: true };
      case 'commands.unregister':
        if (typeof params.command === 'string') this.deps.onDynamicUnregister?.(meta.pluginId, meta.runId, 'command', params.command);
        return { ok: true };
      case 'tools.unregister':
        if (typeof params.name === 'string') this.deps.onDynamicUnregister?.(meta.pluginId, meta.runId, 'tool', params.name);
        return { ok: true };
      case 'handoff.section.unregister':
        if (typeof params.id === 'string') this.deps.onDynamicUnregister?.(meta.pluginId, meta.runId, 'section', params.id);
        return { ok: true };
      case 'slots.unregister':
        if (typeof params.slot === 'string' && typeof params.id === 'string') {
          this.deps.onDynamicUnregister?.(meta.pluginId, meta.runId, 'slot', `${params.slot}:${params.id}`);
        }
        return { ok: true };

      case 'service.call': {
        const serviceName = String(params.service ?? '');
        const fnName = String(params.method ?? '');
        const args = Array.isArray(params.args) ? params.args : [];
        if (!serviceName || !fnName) throw new PluginApiError('E_INVALID_INPUT', '缺少服务名或方法名');
        if (serviceName === 'harness' || serviceName.startsWith('harness.') || serviceName === 'mcpHub' || serviceName === 'remote') {
          throw new PluginApiError('E_PERMISSION_DENIED', `隔离插件不能直接调用内部服务 ${serviceName}`);
        }
        const service = this.deps.host.get<Record<string, unknown>>(serviceName);
        if (!service) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${serviceName} 不可用`);
        if (serviceName === 'ledger') {
          return this.handleLedgerServiceCall(plugin, meta, fnName, args);
        }
        if (serviceName === 'git') {
          return this.handleGitServiceCall(plugin, fnName, args);
        }
        if (serviceName === 'handoff' || serviceName === 'usage' || serviceName === 'native-commands' || serviceName === 'failover') {
          throw new PluginApiError('E_PERMISSION_DENIED', `请使用对应的公共 ctx API 访问 ${serviceName}`);
        }
        // Third-party provided service: invoke across process boundary via proxy!
        const fn = service[fnName];
        if (typeof fn !== 'function') {
          throw new PluginApiError('E_SERVICE_UNAVAILABLE', `服务 ${serviceName}.${fnName} 不存在`);
        }
        return await fn(...args);
      }

      case 'events.query': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const requestedTypes = Array.isArray(params.types) ? (params.types as PluginEventName[]) : undefined;
        const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq) ? Math.max(0, Math.floor(params.afterSeq)) : 0;
        const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.min(200, Math.max(1, Math.floor(params.limit))) : 50;
        const raw = this.deps.store.getEventsAfter(session.id, afterSeq, limit * 4);
        const mapped: PluginEventV4[] = [];
        for (const ev of raw) {
          const dto = toPluginEvent(ev);
          if (!dto) continue;
          if (requestedTypes && !requestedTypes.includes(dto.type)) continue;
          const perm = pluginEventContracts[dto.type]?.permission;
          if (perm && !this.deps.permissions.isGranted(plugin, perm, session.workspaceId)) continue;
          mapped.push(dto);
          if (mapped.length >= limit) break;
        }
        return mapped;
      }

      case 'sessions.list': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        const harnessId = typeof params.harnessId === 'string' ? params.harnessId : undefined;
        if (workspaceId) {
          this.deps.permissions.assertGranted(plugin, 'session:read', workspaceId);
          return this.deps.store.listSessions({ workspaceId, harnessId }).map(toPublicSession);
        }
        const all = this.deps.store.listSessions({ harnessId });
        const allowed = all.filter((session) => this.deps.permissions.isGranted(plugin, 'session:read', session.workspaceId));
        if (allowed.length === 0 && all.length > 0) {
          throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得权限 session:read`);
        }
        return allowed.map(toPublicSession);
      }

      case 'sessions.get': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        return toPublicSession(session);
      }

      case 'sessions.capabilities': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const caps: PublicSessionCapabilities = {
          harnessId: session.harnessId,
          harnessKind: session.harnessKind,
          supportsAttachments: true,
          supportsNativeCommands: Boolean(this.deps.host.get('native-commands')),
          supportsModelTools: session.harnessKind === 'codex' || session.harnessKind === 'claude' || session.harnessKind === 'agy' || session.harnessKind === 'acp',
        };
        return caps;
      }

      case 'sessions.prepareTurn': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:send', session.workspaceId);
        const text = typeof params.text === 'string' ? params.text : '';
        if (!text.trim() || text.length > 100_000) throw new PluginApiError('E_INVALID_INPUT', '轮次内容无效');
        const parts = Array.isArray(params.parts)
          ? (params.parts as Array<{ label?: unknown; text?: unknown }>)
              .filter((p) => typeof p?.label === 'string' && typeof p?.text === 'string')
              .map((p) => ({ label: String(p.label).slice(0, 80), text: String(p.text).slice(0, 12_000) }))
          : undefined;
        const list = this.preparedTurns.get(session.id) ?? [];
        list.push({ pluginId: meta.pluginId, text, parts, createdAt: Date.now() });
        this.preparedTurns.set(session.id, list.slice(-10));
        return { accepted: true };
      }

      case 'sessions.runNative': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:command', session.workspaceId);
        const parsedCmd = PluginNativeCommandSchema.safeParse(params.command);
        if (!parsedCmd.success) throw new PluginApiError('E_INVALID_INPUT', '仅允许调用白名单原生命令');
        if (!this.deps.runNativeCommand) throw new PluginApiError('E_NOT_SUPPORTED', '当前宿主未启用原生命令桥接');
        const args = typeof params.args === 'string' ? params.args.slice(0, 2_000) : undefined;
        return await this.deps.runNativeCommand(session.id, parsedCmd.data, args);
      }

      case 'ledger.get': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const ledger = this.deps.host.get<TaskLedgerService | Record<string, (...args: unknown[]) => unknown>>('ledger');
        if (!ledger) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 服务不可用');
        if ((ledger as { __thirdParty?: boolean }).__thirdParty) {
          const getter = (ledger as Record<string, (...args: unknown[]) => unknown>).get;
          if (typeof getter !== 'function') throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方缺少 get 方法');
          return await getter(session.id);
        }
        if (typeof (ledger as TaskLedgerService).getOrCreate === 'function') {
          return toPublicLedger((ledger as TaskLedgerService).getOrCreate(session));
        }
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方缺少 get 方法');
      }

      case 'ledger.append': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'session:read', session.workspaceId);
        const entry = (params.entry ?? {}) as PublicTaskLedgerAppend;
        const ledger = this.deps.host.get<TaskLedgerService | Record<string, (...args: unknown[]) => unknown>>('ledger');
        if (!ledger) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 服务不可用');
        if ((ledger as { __thirdParty?: boolean }).__thirdParty) {
          const appender = (ledger as Record<string, (...args: unknown[]) => unknown>).append;
          if (typeof appender !== 'function') throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方不支持写入');
          return await appender(session.id, entry);
        }
        if (typeof (ledger as TaskLedgerService).getOrCreate === 'function' && typeof (ledger as TaskLedgerService).updateManual === 'function') {
          const current = (ledger as TaskLedgerService).getOrCreate(session);
          const updated = (ledger as TaskLedgerService).updateManual(session, {
            ...(entry.objective ? { objective: entry.objective } : {}),
            ...(entry.decision ? { decisions: [...current.decisions, entry.decision] } : {}),
            ...(entry.blocker ? { blockers: [...current.blockers, entry.blocker] } : {}),
            ...(entry.pinnedFact ? { pinnedFacts: [...current.pinnedFacts, entry.pinnedFact] } : {}),
            ...(entry.step ? {
              steps: [
                ...current.steps,
                { id: `step_${Date.now()}`, title: entry.step.title, status: entry.step.status ?? 'pending', updatedAt: Date.now() },
              ],
            } : {}),
          });
          return toPublicLedger(updated);
        }
        throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'ledger 提供方不支持写入');
      }

      case 'composer.suggest': {
        const session = this.getSessionOrThrow(params.sessionId);
        this.deps.permissions.assertGranted(plugin, 'composer:suggest', session.workspaceId);
        const suggestion = (params.suggestion ?? {}) as PublicComposerSuggestion;
        const list = this.pendingSuggestions.get(session.id) ?? [];
        list.push({ pluginId: meta.pluginId, suggestion, createdAt: Date.now() });
        this.pendingSuggestions.set(session.id, list.slice(-10));
        this.deps.onComposerSuggest?.(meta.pluginId, session.id, suggestion);
        return { ok: true };
      }

      case 'approvals.annotate': {
        const approvalId = typeof params.approvalId === 'string' ? params.approvalId : '';
        const approval = approvalId ? this.deps.store.getApproval(approvalId) : null;
        if (!approval) throw new PluginApiError('E_INVALID_INPUT', '审批项不存在');
        const session = this.deps.store.getSession(approval.sessionId);
        if (!session) throw new PluginApiError('E_INVALID_INPUT', '审批所属会话不存在');
        this.deps.permissions.assertGranted(plugin, 'approvals:annotate', session.workspaceId);
        const note = (params.note ?? {}) as PublicApprovalAnnotationInput;
        if (typeof note.label !== 'string' || !note.label.trim()) {
          throw new PluginApiError('E_INVALID_INPUT', '审批标注缺少 label');
        }
        const risk = note.risk === 'low' || note.risk === 'medium' || note.risk === 'high' ? note.risk : undefined;
        this.deps.store.addApprovalAnnotation(approval.id, {
          pluginId: meta.pluginId,
          risk,
          label: note.label.trim().slice(0, 120),
          detail: typeof note.detail === 'string' ? note.detail.slice(0, 500) : undefined,
        });
        return { ok: true };
      }

      case 'storage.plugin.get':
      case 'storage.plugin.set':
      case 'storage.plugin.delete':
      case 'storage.plugin.keys': {
        this.deps.permissions.assertGranted(plugin, 'storage:plugin');
        return this.handleStorage('plugin', meta.pluginId, method.slice('storage.plugin.'.length), params);
      }

      case 'storage.workspace.get':
      case 'storage.workspace.set':
      case 'storage.workspace.delete':
      case 'storage.workspace.keys': {
        const workspace = this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'storage:workspace', workspace.id);
        return this.handleStorage(`workspace:${workspace.id}`, meta.pluginId, method.slice('storage.workspace.'.length), params);
      }

      case 'fs.read': {
        const workspace = this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new PluginApiError('E_INVALID_INPUT', '目标不是普通文件');
        if (stat.size > MAX_FS_BYTES) throw new PluginApiError('E_LIMIT_EXCEEDED', '文件超过读取大小限制');
        return fs.readFileSync(fullPath, 'utf8');
      }

      case 'fs.list': {
        const workspace = this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath, rel } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) throw new PluginApiError('E_INVALID_INPUT', '目标不是目录');
        const entries: PublicFsEntry[] = [];
        for (const entry of fs.readdirSync(fullPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name === '.git') continue;
          const entryPath = path.join(fullPath, entry.name);
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          let sizeBytes = 0;
          try { sizeBytes = entry.isFile() ? fs.statSync(entryPath).size : 0; } catch { continue; }
          entries.push({ name: entry.name, relativePath: entryRel, isDirectory: entry.isDirectory(), sizeBytes });
          if (entries.length >= 500) break;
        }
        return entries;
      }

      case 'fs.stat': {
        const workspace = this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
        const { fullPath, rel } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), true);
        const stat = fs.statSync(fullPath);
        const result: PublicFsStat = {
          relativePath: rel,
          isDirectory: stat.isDirectory(),
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        return result;
      }

      case 'fs.write': {
        const workspace = this.getWorkspaceOrThrow(params.workspaceId);
        this.deps.permissions.assertGranted(plugin, 'fs:workspace:write', workspace.id);
        const content = typeof params.content === 'string' ? params.content : null;
        if (content === null) throw new PluginApiError('E_INVALID_INPUT', '写入内容必须为字符串');
        if (Buffer.byteLength(content, 'utf8') > MAX_FS_BYTES) {
          throw new PluginApiError('E_LIMIT_EXCEEDED', '写入文件超过大小限制');
        }
        const { fullPath } = resolveWorkspacePath(workspace.rootPath, String(params.relativePath ?? ''), false);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return { ok: true };
      }

      case 'net.fetch': {
        const rawUrl = typeof params.url === 'string' ? params.url : '';
        let parsedUrl: URL;
        try { parsedUrl = new URL(rawUrl); } catch {
          throw new PluginApiError('E_INVALID_INPUT', '无效的请求 URL');
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new PluginApiError('E_INVALID_INPUT', '仅支持 http/https 协议');
        }
        const host = parsedUrl.hostname.toLowerCase();
        const capability = `net:${host}`;
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        const granted = workspaceId
          ? this.deps.permissions.isGranted(plugin, capability, workspaceId)
          : this.deps.permissions.isGranted(plugin, capability) ||
            this.deps.store.listWorkspaces().some((ws) => this.deps.permissions.isGranted(plugin, capability, ws.id));
        if (!granted) {
          throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${plugin.id} 未获得网络权限 ${capability}`);
        }
        const init = (params.init ?? {}) as PublicNetInit;
        const controller = new AbortController();
        const timeout = Math.min(15_000, Math.max(500, init.timeoutMs ?? 10_000));
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(parsedUrl.toString(), {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
            signal: controller.signal,
          });
          const buf = Buffer.from(await response.arrayBuffer());
          if (buf.length > MAX_NET_BYTES) throw new PluginApiError('E_LIMIT_EXCEEDED', '响应体超过 2 MiB 限制');
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          const out: PublicNetResponse = {
            status: response.status,
            ok: response.ok,
            headers,
            body: buf.toString('utf8'),
          };
          return out;
        } finally {
          clearTimeout(timer);
        }
      }

      case 'notify.send': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        this.deps.permissions.assertGranted(plugin, 'notify', workspaceId);
        const title = String(params.title ?? '').trim().slice(0, 120);
        if (!title) throw new PluginApiError('E_INVALID_INPUT', '通知标题不能为空');
        const body = typeof params.body === 'string' ? params.body.slice(0, 500) : undefined;
        const level = params.level === 'warn' || params.level === 'error' ? params.level : 'info';
        this.notifications.push({ pluginId: meta.pluginId, title, body, level, timestamp: Date.now() });
        this.deps.onNotify?.(meta.pluginId, { title, body, level });
        return { ok: true };
      }

      case 'clipboard.writeText': {
        const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        this.deps.permissions.assertGranted(plugin, 'clipboard:write', workspaceId);
        const text = typeof params.text === 'string' ? params.text : '';
        if (text.length > 256 * 1024) throw new PluginApiError('E_LIMIT_EXCEEDED', '剪贴板内容超出大小限制');
        this.clipboardWrites.push({ pluginId: meta.pluginId, text, timestamp: Date.now() });
        this.deps.onClipboardWrite?.(meta.pluginId, text);
        return { ok: true };
      }

      default:
        throw new PluginApiError('E_NOT_SUPPORTED', `不支持的宿主 RPC 方法 ${method}`);
    }
  }

  private async handleLedgerServiceCall(
    plugin: InstalledPluginInfo,
    meta: { pluginId: string; runId: string },
    fnName: string,
    args: unknown[],
  ) {
    if (fnName === 'get') {
      return this.handle('ledger.get', { sessionId: args[0] }, meta);
    }
    if (fnName === 'append') {
      return this.handle('ledger.append', { sessionId: args[0], entry: args[1] }, meta);
    }
    const ledger = this.deps.host.get<Record<string, unknown>>('ledger');
    if (ledger && typeof ledger[fnName] === 'function' && (ledger as { __thirdParty?: boolean }).__thirdParty) {
      return await (ledger[fnName] as (...a: unknown[]) => unknown)(...args);
    }
    throw new PluginApiError('E_NOT_SUPPORTED', `ledger 不支持公共方法 ${fnName}`);
  }

  private async handleGitServiceCall(plugin: InstalledPluginInfo, fnName: string, args: unknown[]) {
    const workspaceId = typeof args[0] === 'string' ? args[0] : undefined;
    const workspace = this.getWorkspaceOrThrow(workspaceId);
    this.deps.permissions.assertGranted(plugin, 'fs:workspace:read', workspace.id);
    const git = this.deps.host.get<{ status?: (cwd: string) => unknown; inspect?: (cwd: string) => unknown }>('git');
    if (!git) throw new PluginApiError('E_SERVICE_UNAVAILABLE', 'git 服务不可用');
    if (fnName === 'status' && typeof git.status === 'function') return await git.status(workspace.rootPath);
    if (fnName === 'inspect' && typeof git.inspect === 'function') return await git.inspect(workspace.rootPath);
    throw new PluginApiError('E_NOT_SUPPORTED', `git 不支持公共方法 ${fnName}`);
  }

  private handleStorage(scope: string, pluginId: string, op: string, params: Record<string, unknown>) {
    if (op === 'keys') {
      return this.deps.store.listPluginStorageKeys(scope, pluginId);
    }
    const key = typeof params.key === 'string' && params.key.length > 0 && params.key.length <= 128 ? params.key : null;
    if (!key) throw new PluginApiError('E_INVALID_INPUT', '无效的存储键');
    if (op === 'get') return this.deps.store.getPluginStorageValue(scope, pluginId, key);
    if (op === 'delete') {
      this.deps.store.deletePluginStorageValue(scope, pluginId, key);
      return { ok: true };
    }
    if (op === 'set') {
      const encoded = JSON.stringify(params.value);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_STORAGE_BYTES) {
        throw new PluginApiError('E_LIMIT_EXCEEDED', '存储值超出 256 KiB 限制或不可序列化');
      }
      this.deps.store.setPluginStorageValue(scope, pluginId, key, params.value);
      return { ok: true };
    }
    throw new PluginApiError('E_NOT_SUPPORTED', `不支持的存储操作 ${op}`);
  }
}
