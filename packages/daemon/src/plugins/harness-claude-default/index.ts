import {
  HARNESS_DRIVER_CLAUDE_CONTRACT,
  HARNESS_DRIVER_CONTRACT,
  HARNESS_DRIVER_CONTRACT_VERSION,
  type DriverCommandCapability,
  type DriverRegistrationEntry,
  type HarnessDriverProviderServiceV1,
} from '@harnessmate/plugin-api';
import type { DaemonPersistedConfig } from '../../config.js';
import { ClaudeStreamJsonAdapter, type ClaudeModelGroupRule } from '../../harnesses/claude-adapter.js';
import { sanitizeInstanceEnv, type HarnessRegistry } from '../../harnesses/registry.js';
import type { AdapterSessionHandle, HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';

export const HARNESS_CLAUDE_PLUGIN_ID = 'core.harness.claude';
export const HARNESS_CLAUDE_DEFAULT_INSTANCE_ID = 'harness-claude';

export const CLAUDE_SUPPORTED_COMMANDS: DriverCommandCapability[] = [
  { command: 'model', description: '查看列表或切换当前会话的模型', argumentHint: '[模型 ID | default]', supported: true, source: 'builtin' },
  { command: 'plan', description: '进入计划模式，或用 off 退出', argumentHint: '[任务 | off]', supported: true, source: 'builtin' },
  { command: 'usage', description: '查看底层 CLI 提供的用量或额度', supported: true, source: 'builtin' },
  { command: 'compact', description: '压缩原生会话的模型上下文', argumentHint: '[摘要重点]', supported: true, source: 'builtin' },
  { command: 'goal', description: '查看或设置原生目标', argumentHint: '[目标 | status | pause | resume | clear]', supported: true, source: 'builtin' },
  { command: 'plugin', description: '列出或安装底层 CLI 插件', argumentHint: '[list | install ID | reload]', supported: true, source: 'builtin' },
  { command: 'skills', description: '列出此工作区可调用的原生技能', supported: true, source: 'builtin' },
  { command: 'skill', description: '调用指定技能', argumentHint: '<名称> [参数]', supported: true, source: 'builtin' },
];

function wrapClaudeLifecycle(
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
    driverId: base.driverId ?? 'claude',
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

export function createClaudeDriverPlugin(params: {
  registry: HarnessRegistry;
  config: DaemonPersistedConfig;
  overrides?: readonly HarnessAdapter[];
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  let runSeq = 0;

  return {
    provides: [HARNESS_DRIVER_CONTRACT, HARNESS_DRIVER_CLAUDE_CONTRACT, 'harness.claude'],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(params.registry);
      const providerInstanceId = ctx.instanceId ?? HARNESS_CLAUDE_DEFAULT_INSTANCE_ID;
      const isPrimaryInstance =
        providerInstanceId === HARNESS_CLAUDE_DEFAULT_INSTANCE_ID || providerInstanceId === HARNESS_CLAUDE_PLUGIN_ID;
      const runId = `claude-run-${++runSeq}`;
      const activeHandles = new Set<AdapterSessionHandle>();

      const cfg = (settings ?? {}) as {
        instances?: import('@harnessmate/protocol').HarnessInstanceConfig[];
        harnessId?: string;
        displayName?: string;
        description?: string;
        binaryPath?: string;
        configDir?: string;
        homeDir?: string;
        continuationKey?: string;
        apiBaseUrl?: string;
        authToken?: string;
        envWhitelist?: Record<string, string>;
        modelGroupRules?: ClaudeModelGroupRule[];
      };

      const registeredEntries: Array<{ harnessId: string; driverId: string; adapter: HarnessAdapter }> = [];
      const defaultHarnessId = cfg.harnessId?.trim() || (isPrimaryInstance ? 'claude' : providerInstanceId);
      const overrideAdapter = isPrimaryInstance
        ? params.overrides?.find((candidate) => candidate.id === 'claude')
        : undefined;

      const configDir = cfg.configDir ?? cfg.homeDir;
      const baseAdapter = overrideAdapter ?? new ClaudeStreamJsonAdapter(
        cfg.binaryPath ?? params.config.binaryOverrides.claude,
        {
          instanceId: defaultHarnessId,
          ...(cfg.displayName ? { displayName: cfg.displayName } : {}),
          ...(cfg.description ? { description: cfg.description } : {}),
          ...(configDir ? { configDir } : {}),
          ...(cfg.continuationKey ? { continuationKey: cfg.continuationKey } : {}),
          ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
          ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
          ...(cfg.envWhitelist ? { envWhitelist: cfg.envWhitelist } : {}),
          ...(cfg.modelGroupRules ? { modelGroupRules: cfg.modelGroupRules } : {}),
        },
      );

      const primaryWrapped = wrapClaudeLifecycle(
        baseAdapter,
        {
          pluginId: HARNESS_CLAUDE_PLUGIN_ID,
          instanceId: providerInstanceId,
          runId,
          supportedCommands: CLAUDE_SUPPORTED_COMMANDS,
        },
        activeHandles,
      );

      params.registry.registerProviderDriver({
        pluginId: HARNESS_CLAUDE_PLUGIN_ID,
        providerInstanceId,
        providerRunId: runId,
        driverId: 'claude',
        harnessId: primaryWrapped.id,
        isDefault: isPrimaryInstance,
        adapter: primaryWrapped,
        instanceConfig: {
          binaryPath: cfg.binaryPath ?? params.config.binaryOverrides.claude,
          homeDir: configDir,
          envWhitelist: cfg.envWhitelist,
          apiBaseUrl: cfg.apiBaseUrl,
          authToken: cfg.authToken,
          displayName: primaryWrapped.displayName,
          description: primaryWrapped.description,
          continuationKey: primaryWrapped.continuationKey,
          enabled: true,
        },
      });
      registeredEntries.push({ harnessId: primaryWrapped.id, driverId: 'claude', adapter: primaryWrapped });

      if (isPrimaryInstance) {
        for (const inst of cfg.instances ?? params.config.harnessInstances ?? []) {
          if (inst.driverId !== 'claude' || !inst.enabled) continue;
          if (inst.instanceId === primaryWrapped.id) continue;
          const adapter = wrapClaudeLifecycle(
            new ClaudeStreamJsonAdapter(inst.binaryPath ?? params.config.binaryOverrides.claude, {
              instanceId: inst.instanceId,
              displayName: inst.displayName,
              description: inst.description,
              configDir: inst.homeDir,
              continuationKey: inst.continuationKey,
              apiBaseUrl: inst.apiBaseUrl,
              authToken: inst.authToken,
              envWhitelist: inst.envWhitelist,
            }),
            {
              pluginId: HARNESS_CLAUDE_PLUGIN_ID,
              instanceId: providerInstanceId,
              runId,
              supportedCommands: CLAUDE_SUPPORTED_COMMANDS,
            },
            activeHandles,
          );
          params.registry.registerProviderDriver({
            pluginId: HARNESS_CLAUDE_PLUGIN_ID,
            providerInstanceId,
            providerRunId: runId,
            driverId: 'claude',
            harnessId: adapter.id,
            isDefault: false,
            adapter,
            instanceConfig: {
              ...inst,
              continuationKey: adapter.continuationKey ?? `${inst.driverId}:instance:${inst.instanceId}`,
              sanitizedEnv: sanitizeInstanceEnv(inst.envWhitelist),
            },
          });
          registeredEntries.push({ harnessId: adapter.id, driverId: 'claude', adapter });
        }
      }

      const toRegEntry = (item: { harnessId: string; driverId: string; adapter: HarnessAdapter }): DriverRegistrationEntry => ({
        key: `${providerInstanceId}::${item.driverId}::${item.harnessId}`,
        pluginId: HARNESS_CLAUDE_PLUGIN_ID,
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
              pluginId: HARNESS_CLAUDE_PLUGIN_ID,
              instanceId: providerInstanceId,
              runId,
              driverIds: ['claude'],
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
              providerPluginId: HARNESS_CLAUDE_PLUGIN_ID,
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
            return { ok: false, error: { code: 'not_supported', message: 'Claude 驱动未实现额度查询' } };
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
          return { ok: true, value: { commands: CLAUDE_SUPPORTED_COMMANDS } };
        },
      };

      ctx.provide(HARNESS_DRIVER_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'claude', harnessId: primaryWrapped.id },
        runId,
      });
      ctx.provide(HARNESS_DRIVER_CLAUDE_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'claude', harnessId: primaryWrapped.id },
        runId,
      });
      ctx.provide('harness.claude', primaryWrapped);

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
