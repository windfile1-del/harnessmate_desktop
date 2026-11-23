import { z } from 'zod';
import type { DaemonPersistedConfig } from '../../config.js';
import type { Attachment, SessionTaskState } from '@harnessmate/protocol';
import type { PluginEventV4 } from '@harnessmate/plugin-api';
import { ContextCompiler } from '../../core/context-compiler.js';
import { createGitWorktree, getGitStatusSummary, inspectGitRepo } from '../../core/git-service.js';
import { HarnessCommandTools, listHarnessCommands } from '../../core/harness-commands.js';
import { TaskLedgerService } from '../../core/task-ledger-service.js';
import { UsageService } from '../../core/usage-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { AcpAdapter } from '../../harnesses/acp-adapter.js';
import { ClaudeStreamJsonAdapter } from '../../harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../../harnesses/codex-adapter.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../runtime/lifecycle.js';
import type { PluginEvents } from '../runtime/events.js';

export const gitService = { status: getGitStatusSummary, inspect: inspectGitRepo, worktree: createGitWorktree };
export type GitService = typeof gitService;
export type NativeCommandsService = { list: typeof listHarnessCommands; tools: HarnessCommandTools };
export interface FailoverService {
  retryInput(sessionId: string): { text: string; attachments?: Attachment[] } | undefined;
}
export const handoffConfigSchema = z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict();

export function createBuiltinPlugins(store: HarnessMateStore, registry: HarnessRegistry, config: DaemonPersistedConfig,
  ledgerUpdated: (state: SessionTaskState) => void,
  events: () => PluginEvents,
  overrides: readonly HarnessAdapter[] = []) {
  const plugins = new Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>>();
  const adapterPlugin = (id: string, create: () => HarnessAdapter) => {
    const service = `harness.${id}`;
    plugins.set(`core.harness.${id}`, {
      provides: [service],
      apply(ctx) {
        const adapter = overrides.find((candidate) => candidate.id === id) ?? create();
        ctx.effect(() => {
          registry.register(adapter);
          return () => { if (registry.get(id) === adapter) registry.unregister(id); };
        });
        ctx.provide(service, adapter);
      },
    });
  };
  adapterPlugin('codex', () => new CodexAppServerAdapter(config.binaryOverrides.codex));
  adapterPlugin('claude', () => new ClaudeStreamJsonAdapter(config.binaryOverrides.claude));
  adapterPlugin('agy', () => new AcpAdapter({
    id: 'agy', kind: 'agy', displayName: 'Antigravity CLI',
    description: 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
    command: 'agy', args: ['acp', '--stdio'], binaryOverride: config.binaryOverrides.agy,
  }));
  plugins.set('core.harness.acp', {
    provides: ['harness.acp'],
    apply(ctx) {
      ctx.effect(() => {
        for (const harness of config.customAcpHarnesses) {
          if (!registry.isReserved(harness.id) && !registry.get(harness.id)) registry.registerCustomAcp(harness);
        }
        return () => {
          for (const harness of config.customAcpHarnesses) {
            if (!registry.isReserved(harness.id) && registry.get(harness.id)?.isCustom) registry.unregister(harness.id);
          }
        };
      });
      ctx.provide('harness.acp', {});
    },
  });
  plugins.set('core.git-inspector', {
    provides: ['git'],
    apply: (ctx) => { ctx.provide('git', gitService); },
  });
  plugins.set('core.task-ledger', {
    provides: ['ledger'],
    apply(ctx) {
      const ledger = new TaskLedgerService(store, (cwd) => ctx.get<GitService>('git')?.status(cwd));
      ctx.provide('ledger', ledger);
      ctx.on('session.created', ({ sessionId }) => {
        const session = sessionId && store.getSession(sessionId);
        if (session) ledger.syncSession(session);
      });
      const refresh = async ({ sessionId, turnId, data }: PluginEventV4<'turn.completed' | 'turn.failed'>) => {
        if (data.maintenance || !sessionId || !turnId) return;
        const session = store.getSession(sessionId);
        if (!session) return;
        const events = store.getEventsAfter(sessionId, Math.max(0, session.lastSeq - 250), 300);
        ledgerUpdated(await ledger.ingestTurnEvents(session, turnId, data.harnessId ?? session.harnessId, events));
      };
      ctx.on('turn.completed', refresh);
      ctx.on('turn.failed', refresh);
    },
  });
  plugins.set('core.context-bridge', {
    inject: ['ledger'],
    provides: ['handoff'],
    apply(ctx, settings) {
      const ledger = ctx.get<TaskLedgerService>('ledger')!;
      const options = handoffConfigSchema.parse(settings);
      ctx.provide('handoff', new ContextCompiler(store, ledger, options, (cwd) => ctx.get<GitService>('git')?.status(cwd), events()));
    },
  });
  plugins.set('core.account-usage', {
    provides: ['usage'],
    apply: (ctx) => { ctx.provide('usage', new UsageService(store, registry, config.binaryOverrides)); },
  });
  plugins.set('core.harness-commands', {
    provides: ['native-commands'],
    apply(ctx) {
      ctx.provide('native-commands', {
        list: listHarnessCommands, tools: new HarnessCommandTools(() => ctx.get<UsageService>('usage'), config.binaryOverrides),
      } satisfies NativeCommandsService);
    },
  });
  plugins.set('core.auto-failover', {
    inject: ['handoff'],
    provides: ['failover'],
    apply(ctx) {
      ctx.provide('failover', {
        retryInput(sessionId) {
          let current: { text: string; attachments?: Attachment[] } | undefined;
          let retry: typeof current;
          let lastUserTurnId: string | null = null;
          for (const event of store.iterateEvents(sessionId)) {
            if (event.type === 'message.user') {
              lastUserTurnId = event.turnId;
              const { text, attachments } = event.payload;
              current = typeof text === 'string' && text.trim()
                ? { text, attachments: Array.isArray(attachments) ? attachments as Attachment[] : undefined } : undefined;
            } else if (event.type === 'turn.completed') retry = undefined;
            else if (event.type === 'turn.failed' && event.turnId === lastUserTurnId) retry = current;
          }
          return retry;
        },
      } satisfies FailoverService);
    },
  });
  return plugins;
}
