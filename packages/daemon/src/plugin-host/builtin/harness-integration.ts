import { PEER_CONTRACTS, type ResolveServiceSelectionOptions } from '@harnessmate/plugin-api';
import type { HarnessInfo, Session } from '@harnessmate/protocol';
import { FailoverCoordinator, classifyTerminalFailure } from '../../core/failover-service.js';
import { McpService } from '../../core/mcp-service.js';
import { UsageService } from '../../core/usage-service.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import type { PluginCapabilities, ToolDescriptor } from '../../plugins/plugin-capabilities.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type { HostPlugin } from '../runtime/lifecycle.js';

export const usageContract = PEER_CONTRACTS.harnessUsage;
export const modelCatalogContract = PEER_CONTRACTS.harnessModelCatalog;
export const failoverContract = PEER_CONTRACTS.sessionFailover;
export const mcpConfigContract = PEER_CONTRACTS.harnessMcpConfig;
export const modelToolsContract = PEER_CONTRACTS.sessionModelTools;
export const modelToolsPluginId = 'core.session-model-tools';

export interface ModelCatalog {
  listModels(input: { harnessInstanceId: string; sessionId?: string; refresh?: boolean }): Promise<
    Pick<HarnessInfo, 'models' | 'defaultModelId' | 'health' | 'healthMessage'> | null
  >;
}

export type UsageContract = Pick<UsageService, 'collectInstanceUsage' | 'invalidateCache' | 'getKnownBillingTier'> & {
  listAccounts: UsageService['collectAccountUsage'];
};

export type FailoverContract = Pick<FailoverCoordinator, 'getPolicy' | 'setPolicy' | 'recordFailure' | 'retryInput'> & {
  classify: typeof classifyTerminalFailure;
  recommend(input: { sessionId: string; failedInstanceId: string; failureClass: string }): ReturnType<FailoverCoordinator['recommendFailover']>;
};

export type McpConfigContract = {
  list: McpService['listAllServers'];
  add: McpService['addServer'];
  toggle: McpService['toggleServer'];
  remove: McpService['removeServer'];
};

export function selectedHarnessService<T>(
  plugins: PluginManager,
  contract: string,
  scope?: ResolveServiceSelectionOptions,
): T | undefined {
  const selection = plugins.resolveServiceSelection(contract, scope);
  if (selection.status !== 'ready') return undefined;
  return plugins.host.getServiceByInstance<T>(selection.instanceId, contract);
}

export function invalidateAccountUsage(plugins: PluginManager, instanceId: string): void {
  for (const provider of plugins.host.listServiceProviders(usageContract)) {
    plugins.host.getServiceByInstance<UsageContract>(provider.instanceId, usageContract)?.invalidateCache?.(instanceId);
  }
}

export function createHarnessIntegrationPlugins(
  store: HarnessMateStore,
  registry: HarnessRegistry,
  binaryOverrides: Record<string, string>,
  getCapabilities?: () => PluginCapabilities,
): Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>> {
  return new Map<string, Omit<HostPlugin, 'id' | 'enabled' | 'revision'>>([
    ['core.account-usage', {
      provides: ['usage', usageContract, modelCatalogContract],
      apply(ctx) {
        const usage = new UsageService(store, registry);
        ctx.provide('usage', usage);
        ctx.provide(usageContract, {
          listAccounts: usage.collectAccountUsage.bind(usage),
          collectInstanceUsage: usage.collectInstanceUsage.bind(usage),
          invalidateCache: usage.invalidateCache.bind(usage),
          getKnownBillingTier: usage.getKnownBillingTier.bind(usage),
        } satisfies UsageContract);
        ctx.provide(modelCatalogContract, {
          async listModels({ harnessInstanceId, refresh }) {
            const info = await registry.probeInstance(harnessInstanceId, refresh);
            if (!info) return null;
            const { models, defaultModelId, health, healthMessage } = info;
            return { models, defaultModelId, health, healthMessage };
          },
        } satisfies ModelCatalog);
        ctx.effect(() => () => usage.dispose());
      },
    }],
    ['core.auto-failover', {
      provides: ['failover', failoverContract],
      apply(ctx) {
        const coordinator = new FailoverCoordinator(store, registry, () => ctx.get<UsageService>('usage'), {
          storageId: ctx.instanceId,
        });
        ctx.provide('failover', coordinator);
        ctx.provide(failoverContract, {
          getPolicy: coordinator.getPolicy.bind(coordinator),
          setPolicy: coordinator.setPolicy.bind(coordinator),
          recommend: ({ sessionId, failedInstanceId, failureClass }: {
            sessionId: string; failedInstanceId: string; failureClass: string;
          }) => coordinator.recommendFailover(sessionId, failedInstanceId, failureClass),
          classify: classifyTerminalFailure,
          recordFailure: coordinator.recordFailure.bind(coordinator),
          retryInput: coordinator.retryInput.bind(coordinator),
        } satisfies FailoverContract);
      },
    }],
    ['core.mcp-hub', {
      provides: [mcpConfigContract],
      apply(ctx) {
        const config = new McpService(registry, binaryOverrides);
        ctx.provide(mcpConfigContract, {
          list: config.listAllServers.bind(config),
          add: config.addServer.bind(config),
          toggle: config.toggleServer.bind(config),
          remove: config.removeServer.bind(config),
        });
        ctx.effect(() => () => config.stop());
      },
    }],
    [modelToolsPluginId, {
      provides: [modelToolsContract],
      apply(ctx) {
        if (!getCapabilities || !ctx.instanceId) return;
        const capabilities = getCapabilities();
        const router = capabilities.createToolRouter(ctx.instanceId);
        ctx.provide(modelToolsContract, router);
        ctx.effect(() => () => router.stop());
      },
    }],
  ]);
}

export interface ModelToolRouter {
  readonly instanceId: string;
  readonly generation: string;
  list(session: Session): ToolDescriptor[];
  prepareLease(session: Session, harnessId: string, tools: ToolDescriptor[], isHarnessCurrent: () => boolean): ReturnType<PluginCapabilities['openLease']>;
  invoke: PluginCapabilities['invokeTool'];
  release(lease: ReturnType<PluginCapabilities['openLease']>): void;
}
