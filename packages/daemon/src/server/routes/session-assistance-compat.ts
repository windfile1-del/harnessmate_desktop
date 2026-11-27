import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MarkSessionViewedRequestSchema,
  UpdateSessionTriageRequestSchema,
  UpdateTaskStateRequestSchema,
  type SessionTaskState,
  type SessionTriageState,
  type TriageSnoozeExpired,
} from '@harnessmate/protocol';
import {
  findSessionWithProvider,
  listActiveSessionDataProviders,
} from '../../core/session-peer-router.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { INBOX, LEDGER, NOTIFICATIONS, SNOOZE, SUMMARY } from '../../plugin-host/builtin/session-assistance.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';

function explicitInstanceId(request: FastifyRequest): string | undefined {
  const query = request.query as { instanceId?: unknown };
  return typeof query.instanceId === 'string' ? query.instanceId : undefined;
}

export async function readSessionLedger(
  plugins: PluginManager, store: HarnessMateStore, sessionId: string,
): Promise<SessionTaskState | null> {
  const options = { sessionId, allowSingleCandidate: true };
  try {
    return (await plugins.invokeServiceSelection<SessionTaskState>(LEDGER, 'get', [sessionId], options)).value;
  } catch {
    return store.getTaskState(sessionId) ?? null;
  }
}

export function registerSessionAssistanceCompatRoutes(
  app: FastifyInstance, plugins: PluginManager, store: HarnessMateStore,
) {
  const sessionIdOf = (request: FastifyRequest) => (request.params as { id: string }).id;
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Session not found' });
  const inboxDisabled = (reply: FastifyReply) => reply.code(409).send({ error: '会话待办插件已停用' });
  const invoke = <T>(contract: string, method: string, args: unknown[], sessionId?: string, instanceId?: string) =>
    plugins.invokeServiceSelection<T>(contract, method, args, {
      sessionId, explicitInstanceId: instanceId, allowSingleCandidate: true,
    }).then(({ value }) => value);

  function ledgerRoute(contract: string, method: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionIdOf(request);
      const found = await findSessionWithProvider(plugins, id);
      if (!found && !store.getSession(id)) return notFound(reply);
      const args: unknown[] = [id];
      if (method === 'update') {
        const patch = UpdateTaskStateRequestSchema.safeParse(request.body);
        if (!patch.success) return reply.code(400).send({ error: patch.error.issues[0]?.message ?? 'Invalid task state' });
        args.push(patch.data);
      }
      try {
        return { taskState: await invoke(contract, method, args, id, explicitInstanceId(request)) };
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      }
    };
  }
  app.get('/api/v1/sessions/:id/task-state', ledgerRoute(LEDGER, 'get'));
  app.put('/api/v1/sessions/:id/task-state', ledgerRoute(LEDGER, 'update'));
  app.post('/api/v1/sessions/:id/task-state/summarize', ledgerRoute(SUMMARY, 'summarize'));

  const inboxSelection = (request: FastifyRequest, sessionId?: string) => plugins.resolveServiceSelection(INBOX, {
    sessionId, explicitInstanceId: explicitInstanceId(request), allowSingleCandidate: true,
  });
  async function listInbox(request: FastifyRequest, reply: FastifyReply, check: boolean) {
    const selection = inboxSelection(request);
    const instances = new Set<string>();
    if (selection.status === 'ready') instances.add(selection.instanceId);
    if (!explicitInstanceId(request)) {
      const allSessionIds = new Set<string>(store.listSessionIds());
      for (const dp of listActiveSessionDataProviders(plugins)) {
        try {
          const res = await dp.service.listSessions({ includeArchived: true });
          if (res.ok) {
            for (const s of res.value.sessions) allSessionIds.add(s.id);
          }
        } catch {
          // skip
        }
      }
      for (const id of allSessionIds) {
        const owner = inboxSelection(request, id);
        if (owner.status === 'ready') instances.add(owner.instanceId);
      }
    }
    if (instances.size === 0) return inboxDisabled(reply);
    const snooze = plugins.resolveServiceSelection(SNOOZE, { allowSingleCandidate: true });
    const expired = check && snooze.status === 'ready'
      ? await invoke<TriageSnoozeExpired[]>(SNOOZE, 'check', [])
      : [];
    const sessions = (await Promise.all([...instances].map((instanceId) =>
      invoke<SessionTriageState[]>(INBOX, 'list', [], undefined, instanceId)))).flat();
    const reminders = check && snooze.status === 'ready'
      ? await invoke<TriageSnoozeExpired[]>(SNOOZE, 'recent', [])
      : [];
    return check ? { expired, sessions, reminders } : { sessions };
  }
  app.get('/api/v1/triage/state', (request, reply) => listInbox(request, reply, false));
  app.post('/api/v1/triage/check-snoozes', (request, reply) => listInbox(request, reply, true));

  function inboxMutation(viewed: boolean) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const id = sessionIdOf(request);
      const selection = inboxSelection(request, id);
      if (selection.status !== 'ready') return inboxDisabled(reply);
      const patch = viewed
        ? MarkSessionViewedRequestSchema.safeParse(request.body ?? {})
        : UpdateSessionTriageRequestSchema.safeParse(request.body);
      if (!patch.success) return reply.code(400).send({ error: patch.error.issues[0]?.message });
      const session = await invoke<SessionTriageState | undefined>(
        INBOX, viewed ? 'markViewed' : 'update', [id, patch.data], id, selection.instanceId,
      );
      return session ? { session } : notFound(reply);
    };
  }
  app.patch('/api/v1/triage/sessions/:id', inboxMutation(false));
  app.post('/api/v1/triage/sessions/:id/viewed', inboxMutation(true));

  const notificationIntent = z.object({
    kind: z.enum(['approval', 'snooze']),
    sessionId: z.string().min(1).max(160),
    identity: z.string().min(1).max(240),
    summary: z.string().max(500).optional(),
  });
  app.post('/api/v1/desktop/session-notifications/plan', async (request, reply) => {
    const parsed = notificationIntent.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid notification intent' });
    const found = await findSessionWithProvider(plugins, parsed.data.sessionId);
    const session = found?.session ?? store.getSession(parsed.data.sessionId);
    if (!session) return { notice: null };
    const selection = plugins.resolveServiceSelection(NOTIFICATIONS, {
      sessionId: session.id, workspaceId: session.workspaceId, allowSingleCandidate: true,
    });
    if (selection.status !== 'ready') return { notice: null };
    return {
      notice: await invoke(NOTIFICATIONS, 'plan', [parsed.data], session.id, selection.instanceId),
    };
  });
}
