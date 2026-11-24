import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { DaemonPersistedConfig } from '../../config.js';
import { TRIAGE_INBOX_PLUGIN_ID, type Attachment, type SessionTaskState } from '@harnessmate/protocol';
import type { HandoffComposeEvent, PluginEventV4 } from '@harnessmate/plugin-api';
import { ApprovalCenterService } from '../../core/approval-center-service.js';
import { CheckpointService } from '../../core/checkpoint-service.js';
import {
  ContextCompressionService,
  type ContextCompressorProvider,
} from '../../core/context-compression-service.js';
import { ContextCompiler } from '../../core/context-compiler.js';
import { FailoverCoordinator } from '../../core/failover-service.js';
import { OrchestratorService } from '../../core/orchestrator-service.js';
import { SessionExplorerService } from '../../core/session-explorer-service.js';
import {
  commitWorktreeChangesIfDirty,
  computeBranchDiffStat,
  createGitWorktree,
  deleteLocalBranch,
  discardFile,
  dryRunMerge,
  executeTrustedSetupScript,
  getFileDiff,
  getGitStatusSummary,
  getGitVersion,
  gitCommit,
  gitCreatePr,
  gitPull,
  gitPush,
  initGitRepo,
  inspectGitRepo,
  inspectSetupScript,
  listGitWorktrees,
  mergeBranchExplicit,
  removeGitWorktree,
  setSetupScriptTrust,
  workspaceTruthDigest,
} from '../../core/git-service.js';
import { HarnessCommandTools, listHarnessCommands } from '../../core/harness-commands.js';
import { TaskLedgerService } from '../../core/task-ledger-service.js';
import { TerminalWorkspaceService } from '../../core/terminal-workspace-service.js';
import type { TriageInboxService } from '../../core/triage-inbox-service.js';
import type { DaemonEventBus } from '../../core/event-bus.js';
import { UsageService } from '../../core/usage-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { createAgyDriverFactory } from '../../harnesses/agy/agy-driver.js';
import { ClaudeStreamJsonAdapter } from '../../harnesses/claude-adapter.js';
import { CodexAppServerAdapter } from '../../harnesses/codex-adapter.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../runtime/lifecycle.js';
import type { PluginEvents } from '../runtime/events.js';

export const handoffRedactionMap = new WeakMap<object, { categories: string[]; redactedCount: number }>();

export const gitService = {
  status: getGitStatusSummary,
  inspect: inspectGitRepo,
  init: initGitRepo,
  version: getGitVersion,
  fileDiff: getFileDiff,
  discardFile,
  workspaceTruthDigest,
  worktree: createGitWorktree,
  createWorktree: createGitWorktree,
  listWorktrees: listGitWorktrees,
  removeWorktree: removeGitWorktree,
  dryRunMerge,
  commitWorktreeChangesIfDirty,
  computeBranchDiffStat,
  mergeBranchExplicit,
  deleteLocalBranch,
  inspectSetupScript,
  setSetupScriptTrust,
  executeTrustedSetupScript,
  commit: gitCommit,
  push: gitPush,
  pull: gitPull,
  createPr: gitCreatePr,
};
export type GitService = typeof gitService;
export type NativeCommandsService = { list: typeof listHarnessCommands; tools: HarnessCommandTools };
export interface FailoverService {
  retryInput(sessionId: string): { text: string; attachments?: Attachment[] } | undefined;
  getPolicy?: FailoverCoordinator['getPolicy'];
  setPolicy?: FailoverCoordinator['setPolicy'];
  recordFailure?: FailoverCoordinator['recordFailure'];
  recommendFailover?: FailoverCoordinator['recommendFailover'];
  recordAutoSwitch?: FailoverCoordinator['recordAutoSwitch'];
  checkQuotaResets?: FailoverCoordinator['checkQuotaResets'];
}
export const handoffConfigSchema = z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict();

export function createBuiltinPlugins(store: HarnessMateStore, registry: HarnessRegistry, config: DaemonPersistedConfig,
  ledgerUpdated: (state: SessionTaskState) => void,
  events: () => PluginEvents,
  overrides: readonly HarnessAdapter[] = [],
  collectIsolatedSections?: (event: HandoffComposeEvent) => Promise<Array<{ id: string; source: string; order: number; text: string }>>,
  terminalWorkspace?: TerminalWorkspaceService,
  triage?: { service: TriageInboxService; bus: DaemonEventBus },
  agyProfilesDir?: string) {
  const resolvedAgyProfilesDir =
    agyProfilesDir ?? path.join(os.homedir(), '.harnessmate-desktop', 'agy-profiles');
  const plugins = new Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>>();
  const adapterPlugin = (id: string, create: () => HarnessAdapter) => {
    const service = `harness.${id}`;
    plugins.set(`core.harness.${id}`, {
      provides: [service],
      apply(ctx) {
        ctx.host?.setRegistryBridge(registry);
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
  plugins.set('core.harness.agy', {
    provides: ['harness.agy'],
    apply(ctx) {
      ctx.host?.setRegistryBridge(registry);
      const profiles = config.agyProfiles ?? [];
      const driverFactory = createAgyDriverFactory({
        profilesRootDir: resolvedAgyProfilesDir,
        binaryOverride: config.binaryOverrides.agy,
        getProfileConfig: (instanceId) => profiles.find((p) => p.instanceId === instanceId),
      });
      registry.registerDriver('agy', driverFactory);

      const registered: Array<{ id: string; adapter: HarnessAdapter }> = [];
      const overrideAgy = overrides.find((candidate) => candidate.id === 'agy');
      const primaryProfile = profiles.find((p) => p.instanceId === 'agy');
      let primaryAdapter: HarnessAdapter;
      if (overrideAgy) {
        registry.register(overrideAgy);
        primaryAdapter = overrideAgy;
      } else {
        primaryAdapter = registry.registerInstance({
          instanceId: 'agy',
          driverId: 'agy',
          displayName: primaryProfile?.displayName ?? 'Antigravity CLI',
          description:
            primaryProfile?.description ?? 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
          binaryPath: primaryProfile?.binaryPath ?? config.binaryOverrides.agy,
          homeDir: primaryProfile?.geminiDir,
          enabled: primaryProfile?.enabled ?? true,
        });
      }
      registered.push({ id: 'agy', adapter: primaryAdapter });

      for (const profile of profiles) {
        if (profile.instanceId === 'agy' || !profile.enabled) continue;
        const adapter = registry.registerInstance({
          instanceId: profile.instanceId,
          driverId: 'agy',
          displayName: profile.displayName,
          description: profile.description,
          binaryPath: profile.binaryPath ?? config.binaryOverrides.agy,
          homeDir: profile.geminiDir,
          enabled: profile.enabled,
        });
        registered.push({ id: profile.instanceId, adapter });
      }

      for (const instance of config.harnessInstances ?? []) {
        if (instance.driverId !== 'agy' || !instance.enabled) continue;
        if (registered.some((r) => r.id === instance.instanceId)) continue;
        const adapter = registry.registerInstance(instance);
        registered.push({ id: instance.instanceId, adapter });
      }

      ctx.effect(() => () => {
        for (const { id, adapter } of registered) {
          if (registry.get(id) === adapter) registry.unregister(id);
        }
        registry.unregisterDriver('agy');
      });
      ctx.provide('harness.agy', primaryAdapter);
    },
  });
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
    provides: ['git', 'checkpoints'],
    apply: (ctx) => {
      ctx.provide('git', gitService);
      ctx.provide('checkpoints', new CheckpointService(store));
    },
  });
  plugins.set('core.task-ledger', {
    provides: ['ledger'],
    apply(ctx) {
      let disposed = false;
      ctx.effect(() => () => {
        disposed = true;
      });
      const ledger = new TaskLedgerService(store, (cwd) => ctx.get<GitService>('git')?.status(cwd));
      ctx.provide('ledger', ledger);
      ctx.on('session.created', ({ sessionId }) => {
        if (disposed || !store.isOpen()) return;
        const session = sessionId && store.getSession(sessionId);
        if (session) ledger.syncSession(session);
      });
      const refresh = async ({ sessionId, turnId, data }: PluginEventV4<'turn.completed' | 'turn.failed'>) => {
        if (disposed || !store.isOpen()) return;
        if (data.maintenance || !sessionId || !turnId) return;
        const session = store.getSession(sessionId);
        if (!session || disposed || !store.isOpen()) return;
        const events = store.getEventsAfter(sessionId, Math.max(0, session.lastSeq - 250), 300);
        const updated = await ledger.ingestTurnEvents(session, turnId, data.harnessId ?? session.harnessId, events);
        if (disposed || !store.isOpen()) return;
        ledgerUpdated(updated);
      };
      ctx.on('turn.completed', refresh);
      ctx.on('turn.failed', refresh);
    },
  });
  plugins.set('core.context-bridge', {
    inject: ['ledger'],
    provides: ['handoff'],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(registry);
      const ledger = ctx.get<TaskLedgerService>('ledger')!;
      const options = handoffConfigSchema.parse(settings);
      const compiler = new ContextCompiler(
        store,
        ledger,
        options,
        (cwd) => ctx.get<GitService>('git')?.status(cwd),
        events(),
        collectIsolatedSections,
        undefined,
        () => ctx.get<ContextCompressorProvider>('compressor'),
      );
      const baseCompile = compiler.compile.bind(compiler);
      compiler.compile = async (compileOpts) => {
        const packet = await baseCompile(compileOpts);
        const redactor = ctx.host?.getHandoffRedactor();
        if (!redactor || !packet.syncNeeded) {
          return packet;
        }
        const targetDriverId = compileOpts.targetHarnessKind || compileOpts.targetHarnessId;
        const deltaRes = await redactor({
          text: packet.deltaMarkdown,
          targetDriverId,
          sessionId: compileOpts.session.id,
          workspaceId: compileOpts.session.workspaceId,
          targetInstanceId: compileOpts.targetHarnessId,
        });
        const allCategories = new Set<string>(deltaRes.categories);
        let totalRedacted = deltaRes.redactedCount;
        const redactText = async (inputText: string): Promise<string> => {
          if (!inputText) return inputText;
          const r = await redactor({
            text: inputText,
            targetDriverId,
            sessionId: compileOpts.session.id,
            workspaceId: compileOpts.session.workspaceId,
            targetInstanceId: compileOpts.targetHarnessId,
          });
          for (const cat of r.categories) allCategories.add(cat);
          totalRedacted = Math.max(totalRedacted, r.redactedCount);
          return r.text;
        };
        const redactedPortableItems = await Promise.all(
          packet.portableItems.map(async (item) => ({
            ...item,
            content: await Promise.all(
              item.content.map(async (part) => ({
                ...part,
                text: await redactText(part.text),
              })),
            ),
          })),
        );
        const redactedCompiledMarkdown = packet.preview.compiledMarkdown === packet.deltaMarkdown
          ? deltaRes.text
          : await redactText(packet.preview.compiledMarkdown);
        const redactedLedgerMarkdown = packet.preview.ledgerMarkdown
          ? await redactText(packet.preview.ledgerMarkdown)
          : packet.preview.ledgerMarkdown;
        const redactedObjective = packet.objective
          ? await redactText(packet.objective)
          : packet.objective;
        const updated = {
          ...packet,
          deltaMarkdown: deltaRes.text,
          objective: redactedObjective,
          portableItems: redactedPortableItems,
          preview: {
            ...packet.preview,
            compiledMarkdown: redactedCompiledMarkdown,
            ledgerMarkdown: redactedLedgerMarkdown,
            estimatedTokens: Math.max(1, Math.ceil(redactedCompiledMarkdown.length / 4)),
          },
        };
        if (allCategories.size > 0 || totalRedacted > 0) {
          handoffRedactionMap.set(updated, {
            categories: [...allCategories],
            redactedCount: totalRedacted,
          });
        }
        return updated;
      };
      ctx.provide('handoff', compiler);
    },
  });
  plugins.set('core.account-usage', {
    provides: ['usage'],
    apply: (ctx) => {
      ctx.provide('usage', new UsageService(store, registry));
    },
  });
  plugins.set('core.harness-commands', {
    provides: ['native-commands'],
    apply(ctx) {
      ctx.provide('native-commands', {
        list: listHarnessCommands,
        tools: new HarnessCommandTools(() => ctx.get<UsageService>('usage'), config.binaryOverrides, registry),
      } satisfies NativeCommandsService);
    },
  });
  plugins.set('core.auto-failover', {
    inject: ['handoff'],
    provides: ['failover'],
    apply(ctx) {
      const coordinator = new FailoverCoordinator(
        store,
        registry,
        () => ctx.get<UsageService>('usage'),
      );
      ctx.provide('failover', coordinator);
    },
  });
  plugins.set('hm.plugin.session-explorer', {
    provides: ['session-search'],
    apply(ctx) {
      const explorer = new SessionExplorerService(store, registry);
      ctx.provide('session-search', explorer);
      ctx.on('turn.completed', ({ sessionId, turnId }) => {
        if (sessionId && turnId) {
          explorer.indexSessionTurn(sessionId, turnId);
        }
      });
      // Non-blocking low-priority background FTS5 backfill
      const timer = setTimeout(() => {
        void explorer.rebuildBacklogIndex(20).catch(() => {});
      }, 250);
      timer.unref?.();
      ctx.effect(() => () => {
        clearTimeout(timer);
        explorer.dispose();
      });
    },
  });
  plugins.set('hm.plugin.approval-center', {
    provides: ['approval-center'],
    apply(ctx) {
      const approvalCenter = new ApprovalCenterService(store);
      ctx.provide('approval-center', approvalCenter);
    },
  });
  plugins.set('hm.plugin.multi-harness-orchestrator', {
    inject: ['git'],
    provides: ['orchestrator'],
    apply(ctx, settings) {
      const cfg = settings as { maxDepth?: number; maxConcurrent?: number; defaultTimeoutMs?: number };
      const orchestrator = new OrchestratorService(store, registry, {
        maxDepth: typeof cfg.maxDepth === 'number' ? cfg.maxDepth : undefined,
        maxConcurrent: typeof cfg.maxConcurrent === 'number' ? cfg.maxConcurrent : undefined,
        defaultTimeoutMs: typeof cfg.defaultTimeoutMs === 'number' ? cfg.defaultTimeoutMs : undefined,
      });
      orchestrator.recoverOrphanedRuns();
      ctx.provide('orchestrator', orchestrator);
      ctx.effect(() => () => {
        void orchestrator.onPluginDisabled().catch(() => {});
      });
    },
  });
  plugins.set('hm.plugin.context-compression', {
    provides: ['compressor'],
    apply(ctx) {
      const compressor = new ContextCompressionService(store, registry);
      compressor.setPluginActive(true);
      ctx.provide('compressor', compressor);
      ctx.on('turn.completed', ({ sessionId, data }) => {
        if (!data.maintenance && sessionId) {
          compressor.scheduleIdleRollup(sessionId);
        }
      });
      ctx.effect(() => () => {
        compressor.onPluginDisabled();
      });
    },
  });
  plugins.set('hm.plugin.terminal-workspace', {
    provides: ['terminal-workspace'],
    apply(ctx) {
      const svc = terminalWorkspace ?? new TerminalWorkspaceService(store);
      svc.attachGitService(() => ctx.get<GitService>('git'));
      svc.setPluginActive(true);
      ctx.provide('terminal-workspace', svc);
      ctx.effect(() => () => {
        void svc.onPluginDisabled().catch(() => {});
      });
    },
  });
  if (triage) plugins.set(TRIAGE_INBOX_PLUGIN_ID, {
    provides: ['triage-inbox'],
    apply(ctx) {
      ctx.provide('triage-inbox', triage.service);
      ctx.effect(() => triage.service.start(triage.bus));
    },
  });
  return plugins;
}
