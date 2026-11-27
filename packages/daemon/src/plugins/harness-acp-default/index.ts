import {
  HARNESS_DRIVER_ACP_CONTRACT,
  HARNESS_DRIVER_CONTRACT,
  HARNESS_DRIVER_CONTRACT_VERSION,
  type DriverCommandCapability,
  type DriverRegistrationEntry,
  type HarnessDriverProviderServiceV1,
} from '@harnessmate/plugin-api';
import type { CustomAcpHarnessConfig } from '@harnessmate/protocol';
import type { DaemonPersistedConfig } from '../../config.js';
import { AcpAdapter } from '../../harnesses/acp-adapter.js';
import { sanitizeInstanceEnv, type HarnessRegistry } from '../../harnesses/registry.js';
import type { AdapterSessionHandle, HarnessAdapter } from '../../harnesses/types.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';

export const HARNESS_ACP_PLUGIN_ID = 'core.harness.acp';
export const HARNESS_ACP_DEFAULT_INSTANCE_ID = 'harness-acp';

export const ACP_SUPPORTED_COMMANDS: DriverCommandCapability[] = [
  { command: 'model', description: '查看列表或切换当前会话的模型', argumentHint: '[模型 ID | default]', supported: true, source: 'builtin' },
  { command: 'plan', description: '进入计划模式，或用 off 退出', argumentHint: '[任务 | off]', supported: true, source: 'builtin' },
  { command: 'usage', description: '查看底层 CLI 提供的用量或额度', supported: false, reason: '通用 ACP 协议不保证提供账户额度接口', source: 'builtin' },
  { command: 'compact', description: '压缩原生会话的模型上下文', supported: false, reason: '通用 ACP 协议不支持 /compact', source: 'builtin' },
  { command: 'goal', description: '查看或设置原生目标', supported: false, reason: '通用 ACP 协议不支持 /goal', source: 'builtin' },
  { command: 'plugin', description: '列出或安装底层 CLI 插件', supported: false, reason: '通用 ACP 协议不支持 /plugin', source: 'builtin' },
  { command: 'skills', description: '列出此工作区可调用的原生技能', supported: false, reason: '通用 ACP 协议不支持 /skills', source: 'builtin' },
  { command: 'skill', description: '调用指定技能', supported: false, reason: '通用 ACP 协议不支持 /skill', source: 'builtin' },
];

export interface AcpPluginFacade {
  registerCustomHarness(config: CustomAcpHarnessConfig): HarnessAdapter;
  unregisterCustomHarness(harnessId: string): boolean;
}

export function createAcpDriverPlugin(params: {
  registry: HarnessRegistry;
  config: DaemonPersistedConfig;
}): Omit<HostPlugin, 'id' | 'enabled' | 'revision'> {
  let runSeq = 0;

  return {
    provides: [HARNESS_DRIVER_CONTRACT, HARNESS_DRIVER_ACP_CONTRACT, 'harness.acp'],
    apply(ctx, settings) {
      ctx.host?.setRegistryBridge(params.registry);
      const providerInstanceId = ctx.instanceId ?? HARNESS_ACP_DEFAULT_INSTANCE_ID;
      const isPrimaryInstance =
        providerInstanceId === HARNESS_ACP_DEFAULT_INSTANCE_ID || providerInstanceId === HARNESS_ACP_PLUGIN_ID;
      const runId = `acp-run-${++runSeq}`;
      const activeHandles = new Set<AdapterSessionHandle>();
      const ownedCustomIds = new Set<string>();
      const trackedAdapters = new Map<string, HarnessAdapter>();

      const wrapAcpAdapter = (cfg: CustomAcpHarnessConfig): HarnessAdapter => {
        const base = new AcpAdapter({
          id: cfg.id,
          kind: 'acp',
          driverId: 'acp',
          displayName: cfg.displayName,
          description: cfg.description,
          command: cfg.command,
          args: cfg.args,
          env: sanitizeInstanceEnv(cfg.env),
          isCustom: true,
        });
        const wrapped: HarnessAdapter = {
          id: base.id,
          kind: base.kind,
          driverId: 'acp',
          providerPluginId: HARNESS_ACP_PLUGIN_ID,
          providerInstanceId,
          providerRunId: runId,
          continuationKey: base.continuationKey,
          displayName: base.displayName,
          description: base.description,
          protocolLabel: base.protocolLabel,
          capabilities: base.capabilities,
          capabilitiesV2: base.capabilitiesV2,
          presentation: base.presentation,
          supportedCommands: ACP_SUPPORTED_COMMANDS,
          isCustom: true,
          pluginMcpTransport: base.pluginMcpTransport,
          ...(base.probePassive ? { probePassive: () => base.probePassive!() } : {}),
          probe: () => base.probe(),
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
        return wrapped;
      };

      const registerCustomHarness = (cfg: CustomAcpHarnessConfig): HarnessAdapter => {
        const wrapped = wrapAcpAdapter(cfg);
        ownedCustomIds.add(cfg.id);
        trackedAdapters.set(cfg.id, wrapped);
        params.registry.registerProviderDriver({
          pluginId: HARNESS_ACP_PLUGIN_ID,
          providerInstanceId,
          providerRunId: runId,
          driverId: 'acp',
          harnessId: cfg.id,
          isDefault: false,
          adapter: wrapped,
          instanceConfig: {
            binaryPath: cfg.command,
            extraArgs: cfg.args,
            envWhitelist: cfg.env,
            displayName: cfg.displayName,
            description: cfg.description,
            continuationKey: wrapped.continuationKey,
            enabled: true,
          },
        });
        return wrapped;
      };

      const unregisterCustomHarness = (harnessId: string): boolean => {
        ownedCustomIds.delete(harnessId);
        trackedAdapters.delete(harnessId);
        return params.registry.unregisterProviderDriver(providerInstanceId, 'acp', harnessId) > 0;
      };

      if (isPrimaryInstance) {
        params.registry.setCustomAcpFactory((cfg) => wrapAcpAdapter(cfg));
        for (const harness of params.config.customAcpHarnesses) {
          if (!params.registry.isReserved(harness.id) && !params.registry.get(harness.id)) {
            registerCustomHarness(harness);
          }
        }
      }

      // Optional per-instance ACP config supplied via plugin composition settings
      const cfg = (settings ?? {}) as {
        harnessId?: string;
        displayName?: string;
        description?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      };
      if (cfg.command?.trim()) {
        const instanceHarnessId = cfg.harnessId?.trim() || providerInstanceId;
        registerCustomHarness({
          id: instanceHarnessId,
          displayName: cfg.displayName ?? instanceHarnessId,
          description: cfg.description ?? 'Configured Generic ACP CLI',
          command: cfg.command.trim(),
          args: Array.isArray(cfg.args) ? cfg.args : ['acp', '--stdio'],
          env: cfg.env,
        });
      }

      const toRegEntry = (adapter: HarnessAdapter): DriverRegistrationEntry => ({
        key: `${providerInstanceId}::acp::${adapter.id}`,
        pluginId: HARNESS_ACP_PLUGIN_ID,
        instanceId: providerInstanceId,
        driverId: 'acp',
        harnessId: adapter.id,
        runId,
        displayName: adapter.displayName,
        description: adapter.description,
        protocolLabel: adapter.protocolLabel,
        continuationKey: adapter.continuationKey,
        isCustom: true,
        capabilities: adapter.capabilities,
        capabilitiesV2: adapter.capabilitiesV2,
        presentation: adapter.presentation,
        supportedCommands: adapter.supportedCommands ?? ACP_SUPPORTED_COMMANDS,
      });

      const driverService: HarnessDriverProviderServiceV1 = {
        async getProviderInfo() {
          return {
            ok: true,
            value: {
              pluginId: HARNESS_ACP_PLUGIN_ID,
              instanceId: providerInstanceId,
              runId,
              driverIds: ['acp'],
              harnessIds: [...trackedAdapters.keys()],
            },
          };
        },
        async listHarnessInstances() {
          return {
            ok: true,
            value: {
              instances: [...trackedAdapters.values()].map(toRegEntry),
            },
          };
        },
        async probe(req) {
          const targets = [...trackedAdapters.values()].filter((a) => !req?.harnessId || a.id === req.harnessId);
          const probes = await Promise.all(targets.map(async (adapter) => {
            const info = await (!req?.forceRefresh && adapter.probePassive
              ? adapter.probePassive()
              : adapter.probe());
            return {
              harnessId: adapter.id,
              driverId: 'acp',
              providerPluginId: HARNESS_ACP_PLUGIN_ID,
              providerInstanceId,
              providerRunId: runId,
              binaryPath: info.binaryPath,
              version: info.version,
              health: info.health,
              healthMessage: info.healthMessage,
              models: info.models,
              defaultModelId: info.defaultModelId,
              accountSummary: info.accountSummary,
              supportedCommands: adapter.supportedCommands ?? ACP_SUPPORTED_COMMANDS,
            };
          }));
          return { ok: true, value: { probes } };
        },
        async listCommands() {
          return { ok: true, value: { commands: ACP_SUPPORTED_COMMANDS } };
        },
      };

      const legacyFacade: AcpPluginFacade = {
        registerCustomHarness,
        unregisterCustomHarness,
      };

      ctx.provide(HARNESS_DRIVER_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'acp' },
        runId,
      });
      ctx.provide(HARNESS_DRIVER_ACP_CONTRACT, driverService, {
        version: HARNESS_DRIVER_CONTRACT_VERSION,
        metadata: { driverId: 'acp' },
        runId,
      });
      ctx.provide('harness.acp', legacyFacade);

      ctx.effect(() => () => {
        if (isPrimaryInstance) {
          params.registry.setCustomAcpFactory(null);
        }
        for (const harnessId of [...ownedCustomIds]) {
          params.registry.unregisterProviderDriver(providerInstanceId, 'acp', harnessId);
        }
        ownedCustomIds.clear();
        trackedAdapters.clear();
        for (const handle of [...activeHandles]) {
          void handle.dispose().catch(() => {});
        }
        activeHandles.clear();
      });
    },
  };
}
