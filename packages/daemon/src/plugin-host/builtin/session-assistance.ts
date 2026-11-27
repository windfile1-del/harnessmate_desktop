import type { SessionRecordDto } from '@harnessmate/plugin-api';
import {
  TRIAGE_INBOX_PLUGIN_ID,
  type PermissionMode,
  type ReasoningEffort,
  type Session,
  type SessionStatus,
  type SessionTaskState,
  type SessionTriageState,
  type TriageSnoozeExpired,
  type UpdateTaskStateRequest,
} from '@harnessmate/protocol';
import type { DaemonEventBus } from '../../core/event-bus.js';
import type { SessionChangeFeedService } from '../../core/session-change-feed.js';
import { findSessionWithProvider } from '../../core/session-peer-router.js';
import { startTaskLedgerProjection } from '../../core/task-ledger-projection.js';
import { TaskLedgerService } from '../../core/task-ledger-service.js';
import { TriageInboxService } from '../../core/triage-inbox-service.js';
import { lookupOptionalGitStatus } from '../../core/w1-service-helpers.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type { HostPlugin } from '../runtime/lifecycle.js';

export const LEDGER = 'session.ledger.v1';
export const SUMMARY = 'session.summary.v1';
export const INBOX = 'session.inbox.v1';
export const SNOOZE = 'session.snooze.v1';
export const NOTIFICATIONS = 'session.notifications.v1';
export interface SessionNotificationIntent {
  kind: 'approval' | 'snooze';
  sessionId: string;
  identity: string;
  summary?: string;
}

export interface SessionAssistanceDependencies {
  store: HarnessMateStore;
  plugins(): PluginManager;
  changes: SessionChangeFeedService;
  events: DaemonEventBus;
  readLedger(session: Session): Promise<SessionTaskState | null>;
  ledgerUpdated(state: SessionTaskState): void;
  inboxUpdated(state: SessionTriageState, event?: TriageSnoozeExpired): void;
  report(error: unknown): void;
}

export function registerSessionAssistance(
  definitions: Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>>,
  deps: SessionAssistanceDependencies,
) {
  const { store, plugins, changes, events, ledgerUpdated, inboxUpdated, report } = deps;
  const selected = (contract: string, session?: Session) => plugins().resolveServiceSelection(contract, {
    sessionId: session?.id,
    workspaceId: session?.workspaceId,
    allowSingleCandidate: true,
  });
  const owns = (contract: string, instanceId: string, session: Session) => {
    const resolution = selected(contract, session);
    return resolution.status === 'ready' && resolution.instanceId === instanceId;
  };
  const inboxes = new Map<string, TriageInboxService>();

  definitions.set('hm.plugin.message-studio', {
    provides: ['session.studio.v1'],
    apply(ctx) {
      ctx.provide('session.studio.v1', { available: () => true });
    },
  });

  definitions.set('core.task-ledger', {
    provides: ['ledger', LEDGER],
    apply(ctx) {
      const instanceId = ctx.instanceId ?? 'ledger';
      const dataId = instanceId === 'ledger' ? 'core.task-ledger' : `ledger-instance:${instanceId}`;
      const ledger = new TaskLedgerService(store, async (cwd, session) => {
        const result = await lookupOptionalGitStatus(plugins(), { cwd, workspaceId: session.workspaceId, sessionId: session.id });
        return result.status;
      }, dataId);
      ctx.provide('ledger', ledger);
      const resolveSession = async (id: string): Promise<Session | undefined> => {
        const local = store.getSession(id);
        if (local) return local;
        if (!plugins().hasLoadedRegistry()) return undefined;
        const found = await findSessionWithProvider(plugins(), id);
        if (!found) return undefined;
        const dto: SessionRecordDto = found.session;
        return {
          id: dto.id,
          workspaceId: dto.workspaceId,
          harnessId: dto.harnessId,
          harnessKind: dto.harnessKind,
          nativeSessionId: dto.nativeSessionId,
          parentSessionId: dto.parentSessionId ?? null,
          forkedFromTurnSeq: dto.forkedFromTurnSeq ?? null,
          forkMode: dto.forkMode === 'clean_fork' ? 'native' : dto.forkMode === 'with_context' ? 'portable' : null,
          importMode: dto.importMode ?? null,
          importSource: dto.importSource ?? null,
          participatingHarnesses: dto.participatingHarnesses ?? [dto.harnessId],
          contextSyncMode: dto.contextSyncMode ?? 'auto',
          cwd: dto.cwd,
          worktreeBranch: dto.worktreeBranch ?? null,
          title: dto.title,
          status: dto.status as SessionStatus,
          model: dto.model,
          actualModel: dto.actualModel ?? null,
          modelReroutedReason: dto.modelReroutedReason ?? null,
          reasoningEffort: (dto.reasoningEffort as ReasoningEffort | null) ?? null,
          permissionMode: dto.permissionMode as PermissionMode,
          lastSeq: dto.lastSeq,
          usage: dto.usage ?? null,
          pendingApprovalCount: dto.pendingApprovalCount,
          createdAt: dto.createdAt,
          updatedAt: dto.updatedAt,
        };
      };
      const requireSession = async (id: string) => {
        const session = await resolveSession(id);
        if (!session || !owns(LEDGER, instanceId, session)) throw new Error('Session ledger is unavailable');
        return session;
      };
      ctx.provide(LEDGER, {
        get: async (id: string) => ledger.getOrCreate(await requireSession(id)),
        update: async (id: string, patch: UpdateTaskStateRequest) => {
          const state = ledger.updateManual(await requireSession(id), patch);
          ledgerUpdated(state);
          return state;
        },
        summarize: async (id: string) => {
          const session = await requireSession(id);
          if (selected(SUMMARY, session).status !== 'ready') throw new Error('会话任务摘要已停用');
          const state = ledger.generateDeterministicDigest(session);
          ledgerUpdated(state);
          return state;
        },
      });
      ctx.effect(() => startTaskLedgerProjection({
        store, changes, events, instanceId: dataId, ledger, publish: ledgerUpdated, report,
        owns: (session) => owns(LEDGER, instanceId, session),
      }));
    },
  });
  definitions.set('hm.plugin.task-summary', {
    provides: [SUMMARY],
    apply(ctx) {
      ctx.provide(SUMMARY, {
        summarize: async (id: string) => (await plugins().invokeServiceSelection<SessionTaskState>(
          LEDGER, 'summarize', [id], { sessionId: id, allowSingleCandidate: true },
        )).value,
      });
    },
  });
  definitions.set(TRIAGE_INBOX_PLUGIN_ID, {
    provides: ['triage-inbox', INBOX],
    apply(ctx) {
      const instanceId = ctx.instanceId ?? TRIAGE_INBOX_PLUGIN_ID;
      const service = new TriageInboxService(store, inboxUpdated, instanceId,
        (session) => owns(INBOX, instanceId, session),
        (session) => selected(SNOOZE, session).status === 'ready',
      );
      ctx.provide('triage-inbox', service);
      ctx.provide(INBOX, {
        list: service.list.bind(service),
        update: service.update.bind(service),
        markViewed: service.markViewed.bind(service),
      });
      ctx.effect(() => {
        inboxes.set(instanceId, service);
        const stop = service.start(events, changes);
        return () => {
          stop();
          inboxes.delete(instanceId);
        };
      });
    },
  });
  definitions.set('hm.plugin.session-snooze', {
    provides: [SNOOZE],
    apply(ctx) {
      const instanceId = ctx.instanceId ?? 'hm.plugin.session-snooze';
      const check = () => {
        if (selected(SNOOZE).instanceId !== instanceId) return [];
        return [...inboxes.values()].flatMap((inbox) => inbox.checkExpiredSnoozes());
      };
      ctx.provide(SNOOZE, {
        check,
        recent: () => [...inboxes.values()].flatMap((inbox) => inbox.recentSnoozeReminders()),
      });
      ctx.effect(() => {
        const run = () => {
          try { check(); } catch (error) { report(error); }
        };
        const initial = setTimeout(run, 0);
        const timer = setInterval(run, 30_000);
        timer.unref();
        return () => {
          clearTimeout(initial);
          clearInterval(timer);
        };
      });
    },
  });
  definitions.set('hm.plugin.desktop-notifications', {
    provides: [NOTIFICATIONS],
    apply(ctx) {
      ctx.provide(NOTIFICATIONS, {
        plan: async (intent: SessionNotificationIntent) => {
          const session = store.getSession(intent.sessionId)
            ?? (plugins().hasLoadedRegistry() ? (await findSessionWithProvider(plugins(), intent.sessionId))?.session : undefined);
          if (!session) return null;
          return {
            id: [intent.kind, session.id, intent.identity].join(':'),
            title: intent.kind === 'approval' ? 'HarnessMate 需要审批' : 'HarnessMate 延后提醒',
            body: [session.title, intent.summary].filter(Boolean).join(': '),
          };
        },
      });
    },
  });
}
