export function apply(ctx, config = {}) {
  const label = typeof config.label === 'string' && config.label.trim()
    ? config.label.trim()
    : `External Codex (${ctx.instanceId})`;
  const codexHome = typeof config.codexHome === 'string' && config.codexHome.trim()
    ? config.codexHome.trim()
    : `/virtual-home/${ctx.instanceId}`;
  const binaryPath = typeof config.binaryPath === 'string' && config.binaryPath.trim()
    ? config.binaryPath.trim()
    : `/virtual-bin/${ctx.instanceId}/codex`;
  const accountLabel = typeof config.accountLabel === 'string' && config.accountLabel.trim()
    ? config.accountLabel.trim()
    : `${ctx.instanceId}@example.local`;
  const rejectModels = new Set(Array.isArray(config.rejectModels) ? config.rejectModels : ['invalid-model']);
  const supportsGoal = config.supportsGoal !== false;
  const supportsCompact = config.supportsCompact !== false;
  const models = Array.isArray(config.models) && config.models.length > 0
    ? config.models
    : [
        {
          id: 'gpt-5.3-codex-lite',
          displayName: 'GPT-5.3 Codex Lite',
          isDefault: true,
          defaultEffort: 'medium',
          supportedEfforts: ['low', 'medium', 'high'],
        },
        {
          id: 'gpt-5.4-codex-lite',
          displayName: 'GPT-5.4 Codex Lite',
          defaultEffort: 'high',
          supportedEfforts: ['medium', 'high', 'xhigh'],
        },
      ];
  const skills = Array.isArray(config.skills) && config.skills.length > 0
    ? config.skills
    : [{ name: 'lite-review', path: '.agents/skills/lite-review/SKILL.md', description: 'Lite Codex review skill', enabled: true }];

  const supportedCommands = [
    { command: 'model', description: '查看或切换模型', argumentHint: '[模型 ID | default]', supported: true, source: 'driver' },
    { command: 'plan', description: '进入或退出计划模式', argumentHint: '[任务 | off]', supported: true, source: 'driver' },
    { command: 'usage', description: '查看账户配额', supported: true, source: 'driver' },
    {
      command: 'compact',
      description: '压缩原生上下文',
      supported: supportsCompact,
      ...(supportsCompact ? {} : { reason: '该外部 Codex 实例关闭了原生 compact 支持' }),
      source: 'driver',
    },
    {
      command: 'goal',
      description: '查看或设置原生目标',
      supported: supportsGoal,
      ...(supportsGoal ? {} : { reason: '该外部 Codex 实例未启用原生 goal 能力' }),
      source: 'driver',
    },
    { command: 'skills', description: '列出技能', supported: true, source: 'driver' },
    { command: 'skill', description: '调用技能', argumentHint: '<名称> [参数]', supported: true, source: 'driver' },
  ];

  let sessionSeq = 0;
  const activeTimers = new Set();

  ctx.harnesses.registerDriver({
    driverId: 'codex',
    ...(typeof config.harnessId === 'string' && config.harnessId.trim() ? { harnessId: config.harnessId.trim() } : {}),
    displayName: label,
    description: `Pure-SDK Codex driver (${ctx.instanceId}, home=${codexHome})`,
    protocolLabel: 'codex-sdk-lite (v1)',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      permissionModes: Array.isArray(config.permissionModes) && config.permissionModes.length > 0
        ? config.permissionModes
        : ['plan', 'manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: false,
    },
    capabilitiesV2: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      permissionModes: Array.isArray(config.permissionModes) && config.permissionModes.length > 0
        ? config.permissionModes
        : ['plan', 'manual', 'accept_edits', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: true,
      subagents: false,
      transport: 'custom',
      historyInjectionMode: 'native_items',
      supportsNativeRollback: false,
      supportsActiveSteering: false,
      supportsUsageLimits: true,
      supportsDynamicOptions: true,
      nativeCommands: supportedCommands.filter((c) => c.supported).map((c) => c.command),
      optionDescriptors: [],
    },
    presentation: {
      shortLabel: 'Codex Lite',
      accentColor: 'var(--accent-teal)',
      softBg: 'var(--accent-teal-soft)',
      tagline: `${label} · SDK Peer Driver`,
    },
    supportedCommands,
    probePassive: async () => ({
      binaryPath,
      version: '1.0.0-lite',
      health: 'ready',
      models,
      defaultModelId: models[0]?.id ?? 'gpt-5.3-codex-lite',
      accountSummary: accountLabel,
    }),
    probe: async () => ({
      binaryPath,
      version: '1.0.0-lite',
      health: 'ready',
      models,
      defaultModelId: models[0]?.id ?? 'gpt-5.3-codex-lite',
      accountSummary: accountLabel,
    }),
    readUsageLimits: async () => ({
      loggedIn: true,
      accountLabel,
      planType: 'lite-team',
      authMethod: 'sdk-token',
      billingTier: 'subscription',
      rateLimits: [{ label: '5h', usedPercent: 12, windowMinutes: 300 }],
    }),
    createSession: async (sessionConfig) => {
      sessionSeq += 1;
      let nativeSessionId = sessionConfig.nativeSessionId || `thr_lite_${ctx.instanceId}_${sessionSeq}`;
      let currentModel = sessionConfig.model || models[0]?.id || 'gpt-5.3-codex-lite';
      let currentEffort = sessionConfig.reasoningEffort || 'medium';
      let currentMode = sessionConfig.permissionMode || 'manual';
      let activeTurnId = null;
      let disposed = false;
      let currentGoal = '';
      const listeners = new Set();

      const emit = (ev) => {
        if (disposed) return;
        for (const fn of [...listeners]) {
          try {
            fn(ev);
          } catch {
            // listener isolation
          }
        }
      };

      const recordTurn = async (turnId, meta) => {
        try {
          const prev = (await ctx.storage.plugin.get('turns')) || [];
          prev.push({
            turnId,
            instanceId: ctx.instanceId,
            runId: ctx.runId,
            codexHome,
            binaryPath,
            nativeSessionId,
            ...meta,
          });
          await ctx.storage.plugin.set('turns', prev.slice(-50));
        } catch {
          // ignore storage errors on dispose
        }
      };

      return {
        get nativeSessionId() {
          return nativeSessionId;
        },
        pluginMcpAvailable: false,
        sendTurn: async (input) => {
          activeTurnId = input.turnId;
          if (input.model && rejectModels.has(input.model)) {
            emit({ type: 'turn.started', turnId: input.turnId });
            emit({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'invalid_model',
              failureClass: 'provider_error',
              message: `模型 ${input.model} 被外部 Codex 驱动拒绝`,
            });
            activeTurnId = null;
            return { driverUsed: 'native_warm' };
          }

          if (input.model) currentModel = input.model;
          if (input.reasoningEffort) currentEffort = input.reasoningEffort;
          if (input.permissionMode) currentMode = input.permissionMode;

          emit({ type: 'native_session_ready', nativeSessionId });
          emit({
            type: 'config.confirmed',
            model: currentModel,
            thoughtLevel: currentEffort,
            modeId: currentMode,
            permissionEnforcement: 'native',
          });
          emit({ type: 'model.confirmed', actualModel: currentModel });
          emit({ type: 'turn.started', turnId: input.turnId });

          const injectedSuffix = input.contextSync?.deltaMarkdown
            ? ` | handoff:${input.contextSync.deltaMarkdown.length}`
            : '';
          const reply = `[${label}|home=${codexHome}|run=${ctx.runId}] ${input.text}${injectedSuffix}`;
          const half = Math.max(1, Math.floor(reply.length / 2));

          await recordTurn(input.turnId, { text: input.text, model: currentModel });

          const t1 = setTimeout(() => {
            activeTimers.delete(t1);
            if (disposed || activeTurnId !== input.turnId) return;
            emit({ type: 'message.assistant.delta', turnId: input.turnId, text: reply.slice(0, half) });
          }, 15);
          activeTimers.add(t1);

          const t2 = setTimeout(() => {
            activeTimers.delete(t2);
            if (disposed || activeTurnId !== input.turnId) return;
            emit({ type: 'message.assistant.delta', turnId: input.turnId, text: reply.slice(half) });
            emit({ type: 'message.assistant.completed', turnId: input.turnId, text: reply });
            emit({ type: 'turn.completed', turnId: input.turnId, stopReason: 'end_turn' });
            activeTurnId = null;
          }, 35);
          activeTimers.add(t2);

          return {
            driverUsed: input.contextSync ? 'codex_inject_items' : 'native_warm',
          };
        },
        injectContext: async (payload) => {
          emit({
            type: 'diagnostic.log',
            level: 'info',
            stream: 'protocol',
            message: `codex-lite injectContext items=${payload.portableItems?.length ?? 0}`,
          });
          return 'codex_inject_items';
        },
        listSkills: async () => skills,
        runNativeCommand: async (command, args) => {
          if (command === 'goal') {
            if (!supportsGoal) {
              return {
                command: 'goal',
                status: 'unsupported',
                output: '该外部 Codex 驱动实例未启用原生 goal 能力',
                reason: 'supportsGoal=false',
              };
            }
            const trimmed = String(args || '').trim();
            if (!trimmed || trimmed === 'status') {
              return {
                command: 'goal',
                status: 'executed',
                output: currentGoal ? `当前目标：${currentGoal}` : '当前未设置目标',
                confirmed: { goal: currentGoal || null },
              };
            }
            if (trimmed === 'clear' || trimmed === 'pause') {
              currentGoal = '';
              return {
                command: 'goal',
                status: 'executed',
                output: trimmed === 'clear' ? '已清除目标' : '已暂停目标',
                confirmed: { goal: null },
              };
            }
            currentGoal = trimmed;
            return {
              command: 'goal',
              status: 'executed',
              output: `已更新目标：${currentGoal}`,
              confirmed: { goal: currentGoal },
            };
          }
          return {
            command,
            status: 'unsupported',
            output: `外部 Codex 驱动不支持原生命令 /${command}`,
            reason: 'command_not_implemented',
          };
        },
        interrupt: async () => {
          if (!activeTurnId) return;
          const turnId = activeTurnId;
          activeTurnId = null;
          emit({ type: 'turn.cancelled', turnId });
        },
        resolveApproval: async () => {},
        updateConfig: async (patch) => {
          const requested = { ...patch };
          if (patch.model !== undefined && patch.model !== null && rejectModels.has(patch.model)) {
            return {
              harnessId: ctx.instanceId,
              driverId: 'codex',
              providerInstanceId: ctx.instanceId,
              runId: ctx.runId,
              requested,
              confirmed: {
                model: currentModel,
                reasoningEffort: currentEffort,
                permissionMode: currentMode,
              },
              status: 'rejected',
              note: `模型 ${patch.model} 不在外部 Codex 驱动支持列表内`,
            };
          }
          if (patch.model !== undefined && patch.model !== null) currentModel = patch.model;
          if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== null) currentEffort = patch.reasoningEffort;
          if (patch.permissionMode !== undefined) currentMode = patch.permissionMode;
          emit({
            type: 'config.confirmed',
            model: currentModel,
            thoughtLevel: currentEffort,
            modeId: currentMode,
            permissionEnforcement: 'native',
          });
          return {
            harnessId: ctx.instanceId,
            driverId: 'codex',
            providerInstanceId: ctx.instanceId,
            runId: ctx.runId,
            requested,
            confirmed: {
              model: currentModel,
              reasoningEffort: currentEffort,
              permissionMode: currentMode,
            },
            status: 'applied',
          };
        },
        dispose: async () => {
          disposed = true;
          activeTurnId = null;
          listeners.clear();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
  });

  ctx.effect(() => () => {
    for (const timer of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
  });
}
