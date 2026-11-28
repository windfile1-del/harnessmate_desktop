import {
  HARNESS_DRIVER_CODEX_CONTRACT,
  HARNESS_DRIVER_CONTRACT,
  HARNESS_DRIVER_CONTRACT_VERSION,
  type DriverCommandCapability,
  type DriverRegistrationEntry,
  type HarnessDriverProviderServiceV1,
} from '@harnessmate/plugin-api';
import type { DaemonPersistedConfig } from '../../config.js';
import { CodexAppServerAdapter, type CodexModelGroupRule } from '../../harnesses/codex-adapter.js';
import { sanitizeInstanceEnv, type HarnessRegistry } from '../../harnesses/registry.js';
import type { AdapterSessionHandle, HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';

export const HARNESS_CODEX_PLUGIN_ID = 'core.harness.codex';
export const HARNESS_CODEX_DEFAULT_INSTANCE_ID = 'harness-codex';

export const CODEX_SUPPORTED_COMMANDS: DriverCommandCapability[] = [
  { command: 'model', description: '查看列表或切换当前会话的模型', argumentHint: '[模型 ID | default]', supported: true, source: 'builtin' },
  { command: 'plan', description: '进入计划模式，或用 off 退出', argumentHint: '[任务 | off]', supported: true, source: 'builtin' },
  { command: 'usage', description: '查看底层 CLI 提供的用量或额度', supported: true, source: 'builtin' },
  { command: 'compact', description: '压缩原生会话的模型上下文', supported: true, source: 'builtin' },
  { command: 'goal', description: '查看或设置原生目标', argumentHint: '[目标 | status | pause | resume | clear]', supported: true, source: 'builtin' },
  { command: 'plugin', description: '列出或安装底层 CLI 插件', argumentHint: '[list | install ID]', supported: true, source: 'builtin' },
  { command: 'skills', description: '列出此工作区可调用的原生技能', supported: true, source: 'builtin' },
  { command: 'skill', description: '调用指定技能', argumentHint: '<名称> [参数]', supported: true, source: 'builtin' },
];

function wrapAdapterLifecycle(
  base: HarnessAdapter,
  identity: {
    pluginId: string;
    instanceId: string;
    runId: string;
    supportedCommands: DriverCommandCapability[];
  },
  activeHandles: Set<AdapterSessionHandle>,
): HarnessAdapter {
  return {
    id: base.id,
    kind: base.kind,
    driverId: base.driverId ?? 'codex',
    providerPluginId: identity.pluginId,
    providerInstanceId: identity.instanceId,
    providerRunId: identity.runId,
    continuationKey: base.continuationKey,
    displayName: base.displayName,
    description: base.description,
    protocolLabel: base.protocolLabel,
    capabilities: base.capabilities,
    capabilitiesV2: base.capabilitiesV2,
    presentation: base.presentation,
    supportedCommands: base.supportedCommands ?? identity.supportedCommands,
    isCustom: base.isCustom,
    pluginMcpTransport: base.pluginMcpTransport,
    ...(base.probePassive ? { probePassive: () => base.probePassive!() } : {}),
    probe: () => base.probe(),
    ...(base.readUsageLimits ? { readUsageLimits: () => base.readUsageLimits!() } : {}),
    createSession: async (sessionConfig) => {
      const handle = await base.createSession(sessionConfig);
      activeHandles.add(handle);
      const originalDispose = handle.dispose.bind(handle);
      handle.dispose = async () => {
        activeHandles.delete(handle);
        return originalDispose();
      };
      return handle;
    },
  };
}

export function createCodexDriverPlugin(params: {
  registry: HarnessRegistry;
  config: DaemonPersistedConfig;
  overrides?: readonly HarnessAdapter[];
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  let runSeq = 0;

  return {
    provides: [HARNESS_DRIVER_CONTRACT, HARNESS_DRIVER_CODEX_CONTRACT, 'harness.codex'],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(params.registry);
      const providerInstanceId = ctx.instanceId ?? HARNESS_CODEX_DEFAULT_INSTANCE_ID;
      const isPrimaryInstance =
        providerInstanceId === HARNESS_CODEX_DEFAULT_INSTANCE_ID || providerInstanceId === HARNESS_CODEX_PLUGIN_ID;
      const runId = `codex-run-${++runSeq}`;
      const activeHandles = new Set<AdapterSessionHandle>();

      const cfg = (settings ?? {}) as {
        instances?: import('@harnessmate/protocol').HarnessInstanceConfig[];
        harnessId?: string;
        displayName?: string;
        description?: string;
        binaryPath?: string;
        codexHome?: string;
        homeDir?: string;
        continuationKey?: string;
        extraArgs?: string[];
        envWhitelist?: Record<string, string>;
        defaultServiceTier?: 'default' | 'fast';
        modelGroupRules?: CodexModelGroupRule[];
      };

      const registeredEntries: Array<{ harnessId: string; driverId: string; adapter: HarnessAdapter }> = [];

      const defaultHarnessId = cfg.harnessId?.trim() || (isPrimaryInstance ? 'codex' : providerInstanceId);
      const overrideAdapter = isPrimaryInstance
        ? params.overrides?.find((candidate) => candidate.id === 'codex')
        : undefined;

      const primaryCodexHome = cfg.codexHome ?? cfg.homeDir;
      const baseAdapter = overrideAdapter ?? new CodexAppServerAdapter(
        cfg.binaryPath ?? params.config.binaryOverrides.codex,
        cfg.extraArgs ?? ['app-server', '--stdio'],
        {
          instanceId: defaultHarnessId,
          ...(cfg.displayName ? { displayName: cfg.displayName } : {}),
          ...(cfg.description ? { description: cfg.description } : {}),
          ...(primaryCodexHome ? { codexHome: primaryCodexHome } : {}),
          ...(cfg.continuationKey ? { continuationKey: cfg.continuationKey } : {}),
          ...(cfg.envWhitelist ? { envWhitelist: cfg.envWhitelist } : {}),
          ...(cfg.defaultServiceTier ? { defaultServiceTier: cfg.defaultServiceTier } : {}),
          ...(cfg.modelGroupRules ? { modelGroupRules: cfg.modelGroupRules } : {}),
        },
      );

      const primaryWrapped = wrapAdapterLifecycle(
        baseAdapter,
        {
          pluginId: HARNESS_CODEX_PLUGIN_ID,
          instanceId: providerInstanceId,
          runId,
          supportedCommands: CODEX_SUPPORTED_COMMANDS,
        },
        activeHandles,
      );

      params.registry.registerProviderDriver({
        pluginId: HARNESS_CODEX_PLUGIN_ID,
        providerInstanceId,
        providerRunId: runId,
        driverId: 'codex',
        harnessId: primaryWrapped.id,
        isDefault: isPrimaryInstance,
        adapter: primaryWrapped,
        instanceConfig: {
          binaryPath: cfg.binaryPath ?? params.config.binaryOverrides.codex,
          homeDir: primaryCodexHome,
          extraArgs: cfg.extraArgs,
          envWhitelist: cfg.envWhitelist,
          defaultServiceTier: cfg.defaultServiceTier,
          displayName: primaryWrapped.displayName,
          description: primaryWrapped.description,
          continuationKey: primaryWrapped.continuationKey,
          enabled: true,
        },
      });
      registeredEntries.push({ harnessId: primaryWrapped.id, driverId: 'codex', adapter: primaryWrapped });

      // Legacy configured multi-instance Codex entries from config.harnessInstances
      if (isPrimaryInstance) {
        for (const inst of cfg.instances ?? params.config.harnessInstances ?? []) {
          if (inst.driverId !== 'codex' || !inst.enabled) continue;
          if (inst.instanceId === primaryWrapped.id) continue;
          const adapter = wrapAdapterLifecycle(
            new CodexAppServerAdapter(
              inst.binaryPath ?? params.config.binaryOverrides.codex,
              inst.extraArgs ?? ['app-server', '--stdio'],
              {
                instanceId: inst.instanceId,
                displayName: inst.displayName,
                description: inst.description,
                codexHome: inst.homeDir,
                continuationKey: inst.continuationKey,
                envWhitelist: inst.envWhitelist,
                defaultServiceTier: inst.defaultServiceTier,
              },
            ),
            {
              pluginId: HARNESS_CODEX_PLUGIN_ID,
              instanceId: providerInstanceId,
              runId,
              supportedCommands: CODEX_SUPPORTED_COMMANDS,
            },
            activeHandles,
          );
          params.registry.registerProviderDriver({
            pluginId: HARNESS_CODEX_PLUGIN_ID,
            providerInstanceId,
            providerRunId: runId,
            driverId: 'codex',
            harnessId: adapter.id,
            isDefault: false,
            adapter,
            instanceConfig: {
              ...inst,
              continuationKey: adapter.continuationKey ?? `${inst.driverId}:instance:${inst.instanceId}`,
              sanitizedEnv: sanitizeInstanceEnv(inst.envWhitelist),
            },
          });
          registeredEntries.push({ harnessId: adapter.id, driverId: 'codex', adapter });
        }
      }

      const toRegEntry = (item: { harnessId: string; driverId: string; adapter: HarnessAdapter }): DriverRegistrationEntry => ({
        key: `${providerInstanceId}::${item.driverId}::${item.harnessId}`,
        pluginId: HARNESS_CODEX_PLUGIN_ID,
        instanceId: providerInstanceId,
        driverId: item.driverId,
        harnessId: item.harnessId,
        runId,
        displayName: item.adapter.displayName,
        description: item.adapter.description,
        protocolLabel: item.adapter.protocolLabel,
        continuationKey: item.adapter.continuationKey,
        isDefault: isPrimaryInstance && item.harnessId === primaryWrapped.id,
        capabilities: item.adapter.capabilities,
        capabilitiesV2: item.adapter.capabilitiesV2,
        presentation: item.adapter.presentation,
        supportedCommands: item.adapter.supportedCommands,
      });

      const driverService: HarnessDriverProviderServiceV1 = {
        async getProviderInfo() {
          return {
            ok: true,
            value: {
              pluginId: HARNESS_CODEX_PLUGIN_ID,
              instanceId: providerInstanceId,
              runId,
              driverIds: ['codex'],
              harnessIds: registeredEntries.map((r) => r.harnessId),
            },
          };
        },
        async listHarnessInstances() {
          return { ok: true, value: { instances: registeredEntries.map(toRegEntry) } };
        },
        async probe(req) {
          const targets = registeredEntries.filter((r) => !req?.harnessId || r.harnessId === req.harnessId);
          const probes = await Promise.all(targets.map(async (r) => {
            const info = await (!req?.forceRefresh && r.adapter.probePassive
              ? r.adapter.probePassive()
              : r.adapter.probe());
            return {
              harnessId: r.harnessId,
              driverId: r.driverId,
              providerPluginId: HARNESS_CODEX_PLUGIN_ID,
              providerInstanceId,
              providerRunId: runId,
              binaryPath: info.binaryPath,
              version: info.version,
              health: info.health,
              healthMessage: info.healthMessage,
              models: info.models,
              defaultModelId: info.defaultModelId,
              accountSummary: info.accountSummary,
              supportedCommands: r.adapter.supportedCommands,
            };
          }));
          return { ok: true, value: { probes } };
        },
        async readUsageLimits(req) {
          const target = registeredEntries.find((r) => !req?.harnessId || r.harnessId === req.harnessId);
          if (!target?.adapter.readUsageLimits) {
            return { ok: false, error: { code: 'not_supported', message: 'Codex 驱动未实现额度查询' } };
          }
          const usage = await target.adapter.readUsageLimits();
          return {
            ok: true,
            value: {
              harnessId: target.harnessId,
              driverId: target.driverId,
              providerInstanceId,
              loggedIn: usage.loggedIn,
              accountLabel: usage.accountLabel,
              planType: usage.planType,
              authMethod: usage.authMethod,
              billingTier: usage.billingTier,
              gatewayUrl: usage.gatewayUrl,
              rateLimits: usage.rateLimits,
              error: usage.error,
            },
          };
        },
        async listCommands() {
          return { ok: true, value: { commands: CODEX_SUPPORTED_COMMANDS } };
        },
      };

      ctx.provide(HARNESS_DRIVER_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'codex', harnessId: primaryWrapped.id },
        runId,
      });
      ctx.provide(HARNESS_DRIVER_CODEX_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'codex', harnessId: primaryWrapped.id },
        runId,
      });
      ctx.provide('harness.codex', primaryWrapped);

      ctx.effect(() => () => {
        for (const item of registeredEntries) {
          params.registry.unregisterProviderDriver(providerInstanceId, item.driverId, item.harnessId);
        }
        for (const handle of [...activeHandles]) {
          void handle.dispose().catch(() => {});
        }
        activeHandles.clear();
      });
    },
  };
}
