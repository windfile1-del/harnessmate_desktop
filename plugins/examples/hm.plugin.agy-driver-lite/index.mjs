export function apply(ctx, config = {}) {
  const instanceId = ctx.instanceId || 'hm.plugin.agy-driver-lite';
  const runId = ctx.runId || `run_${instanceId}`;
  const label =
    typeof config.label === 'string' && config.label.trim()
      ? config.label.trim()
      : `External AGY Lite (${instanceId})`;
  const homeDir =
    typeof config.homeDir === 'string' && config.homeDir.trim()
      ? config.homeDir.trim()
      : `/virtual-agy-home/${instanceId}`;
  const binaryPath =
    typeof config.binaryPath === 'string' && config.binaryPath.trim()
      ? config.binaryPath.trim()
      : `/virtual-bin/${instanceId}/agy-lite`;
  const accountLabel =
    typeof config.accountLabel === 'string' && config.accountLabel.trim()
      ? config.accountLabel.trim()
      : `${instanceId}@agy-lite.local`;
  const profileInstanceId =
    typeof config.profileInstanceId === 'string' && config.profileInstanceId.trim()
      ? config.profileInstanceId.trim()
      : `lite-${instanceId}`;
  const harnessId =
    typeof config.harnessId === 'string' && config.harnessId.trim()
      ? config.harnessId.trim()
      : `${instanceId}:agy`;
  const generation = `gen_${instanceId}_${runId}`;
  const models =
    Array.isArray(config.models) && config.models.length > 0
      ? config.models
      : [
          {
            id: 'agy-lite-flash',
            displayName: 'AGY Lite Flash',
            isDefault: true,
            defaultEffort: 'medium',
            supportedEfforts: ['low', 'medium', 'high'],
          },
          {
            id: 'agy-lite-pro',
            displayName: 'AGY Lite Pro',
            defaultEffort: 'high',
            supportedEfforts: ['medium', 'high'],
          },
        ];

  const supportedCommands = [
    { command: 'mode', description: '切换 AGY Lite 运行模式', argumentHint: '<normal|plan|fast>', supported: true, source: 'driver' },
    { command: 'model', description: '切换模型', argumentHint: '<modelId>', supported: true, source: 'driver' },
    { command: 'status', description: '查看 AGY Lite 原生状态', supported: true, source: 'driver' },
    { command: 'swarm', description: '启动轻量 Swarm 回放', argumentHint: '[objective]', supported: true, source: 'driver' },
    { command: 'goal', description: '设置或查看目标', argumentHint: '[objective]', supported: true, source: 'driver' },
  ];

  const declaredCapabilities = [
    {
      id: 'agy.lite.mode',
      snapshotRevision: 1,
      surfaces: ['desktop', 'cli'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'available',
      actions: [
        { key: 'set_mode', lane: 'config', gate: 'available', label: 'Switch Mode' },
      ],
      evidenceRefs: ['sdk:agy-driver-lite'],
      verifiedLevel: 3,
    },
    {
      id: 'agy.lite.swarm',
      snapshotRevision: 1,
      surfaces: ['desktop'],
      advertised: true,
      launch: 'available',
      observe: 'available',
      control: 'available',
      localRead: 'available',
      actions: [
        { key: 'launch', lane: 'live_workflow', gate: 'available', label: 'Launch Lite Swarm' },
        { key: 'cancel', lane: 'live_workflow', gate: 'available', label: 'Cancel Lite Swarm' },
      ],
      evidenceRefs: ['sdk:agy-driver-lite'],
      verifiedLevel: 3,
    },
  ];

  let disposed = false;
  let sessionSeq = 0;
  const activeTimers = new Set();
  const runtimeBySession = new Map();
  const receiptCache = new Map();
  const workbenchStateBySession = new Map();
  let accountState = {
    instanceId: profileInstanceId,
    loggedIn: true,
    email: accountLabel,
    displayName: label,
    planTier: 'sdk-lite',
    updatedAt: Date.now(),
  };

  function ensureRuntimeState(sessionId) {
    let state = runtimeBySession.get(sessionId);
    if (!state) {
      const runtimeId = `rt_lite_${instanceId}_${sessionId}`;
      state = {
        sessionId,
        binding: {
          runtimeId,
          sessionId,
          instanceId: profileInstanceId,
          generation,
        },
        asOfSeq: 1,
        capabilitiesRevision: 1,
        status: 'connected',
        mode: 'normal',
        model: models[0].id,
        activities: [],
        work: [],
        agents: [
          {
            id: `agent_lite_main_${sessionId}`,
            role: { kind: 'known', value: 'coordinator', evidence: makeEvidence() },
            label: { kind: 'known', value: `${label} Main`, evidence: makeEvidence() },
            foreground: { kind: 'known', value: 'idle', evidence: makeEvidence() },
            launchWorkIds: [],
            lineage: 'confirmed',
            revision: 1,
          },
        ],
        relations: [],
        workflows: [],
        receipts: {},
        events: [],
        timelineByScope: new Map(),
        workflowResources: new Map(),
        activeInterrupt: null,
      };
      runtimeBySession.set(sessionId, state);
    }
    return state;
  }

  function makeEvidence() {
    return {
      sourceKind: 'replay',
      freshness: 'fresh',
      observedAt: Date.now(),
      wireVariant: 'agy-driver-lite-v1',
    };
  }

  function appendNativeEvent(state, type, payload) {
    state.asOfSeq += 1;
    const event = {
      schemaVersion: 1,
      runtimeId: state.binding.runtimeId,
      generation: state.binding.generation,
      seq: state.asOfSeq,
      timestamp: Date.now(),
      type,
      payload,
    };
    state.events.push(event);
    if (state.events.length > 200) {
      state.events = state.events.slice(-200);
    }
    if (ctx.services && typeof ctx.services.publish === 'function') {
      try {
        ctx.services.publish('agy.runtime.v1', {
          sessionId: state.sessionId,
          providerInstanceId: instanceId,
          runtimeId: state.binding.runtimeId,
          generation: state.binding.generation,
          seq: event.seq,
          nativeEvent: event,
        });
      } catch {
        // Ignore publish failure during teardown
      }
    }
    return event;
  }

  function buildProjection(state) {
    return {
      schemaVersion: 1,
      binding: state.binding,
      asOfSeq: state.asOfSeq,
      capabilitiesRevision: state.capabilitiesRevision,
      status: state.status,
      leaseReasons: [],
      activities: state.activities,
      work: state.work,
      agents: state.agents,
      relations: state.relations,
      workflows: state.workflows,
      requestIds: Object.keys(state.receipts),
      receipts: state.receipts,
    };
  }

  ctx.harnesses.registerDriver({
    driverId: 'agy',
    ...(typeof config.harnessId === 'string' && config.harnessId.trim()
      ? { harnessId: config.harnessId.trim() }
      : {}),
    displayName: label,
    description: `Pure-SDK AGY Lite peer driver (${instanceId}, home=${homeDir})`,
    protocolLabel: 'agy-sdk-lite (v1)',
    capabilities: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['plan', 'manual', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: true,
    },
    capabilitiesV2: {
      streaming: true,
      interactiveApproval: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      permissionModes: ['plan', 'manual', 'auto'],
      sessionResume: true,
      sessionFork: false,
      imageInput: false,
      subagents: true,
      transport: 'custom',
      historyInjectionMode: 'native_items',
      supportsNativeRollback: false,
      supportsActiveSteering: false,
      supportsUsageLimits: false,
      supportsDynamicOptions: true,
      nativeCommands: supportedCommands.map((c) => c.command),
      optionDescriptors: [],
    },
    presentation: {
      shortLabel: 'AGY Lite',
      accentColor: 'var(--accent-blue)',
      softBg: 'var(--accent-blue-soft)',
      tagline: `${label} · Pure-SDK AGY Peer`,
    },
    supportedCommands,
    probePassive: async () => ({
      binaryPath,
      version: '1.0.0-agy-lite',
      health: 'ready',
      models,
      defaultModelId: models[0].id,
      accountSummary: accountLabel,
    }),
    probe: async () => ({
      binaryPath,
      version: '1.0.0-agy-lite',
      health: 'ready',
      models,
      defaultModelId: models[0].id,
      accountSummary: accountLabel,
    }),
    createSession: async (sessionConfig) => {
      sessionSeq += 1;
      const hmSessionId = sessionConfig.sessionId || `hm_lite_${sessionSeq}`;
      const state = ensureRuntimeState(hmSessionId);
      let nativeSessionId =
        sessionConfig.nativeSessionId || `agy_lite_sess_${instanceId}_${sessionSeq}`;
      let activeTurnId = null;
      let activeTimer = null;
      let sessionDisposed = false;
      const listeners = new Set();

      const emit = (ev) => {
        if (disposed || sessionDisposed) return;
        for (const fn of [...listeners]) {
          try {
            fn(ev);
          } catch {
            // isolate listeners
          }
        }
      };

      const cancelActiveTurn = (reason = 'cancelled_by_user') => {
        if (!activeTurnId) return false;
        const turnId = activeTurnId;
        activeTurnId = null;
        if (activeTimer) {
          clearTimeout(activeTimer);
          activeTimers.delete(activeTimer);
          activeTimer = null;
        }
        const act = state.activities.find((a) => a.turnId === turnId);
        if (act) {
          act.state = 'cancelled';
          act.summary = reason;
          act.updatedAt = Date.now();
          appendNativeEvent(state, 'native.activity.changed', { activity: { ...act } });
        }
        emit({ type: 'turn.completed', turnId, stopReason: 'cancelled' });
        return true;
      };

      state.activeInterrupt = cancelActiveTurn;

      return {
        get nativeSessionId() {
          return nativeSessionId;
        },
        pluginMcpAvailable: false,
        sendTurn: async (input) => {
          const turnId = input.turnId;
          activeTurnId = turnId;
          const text = String(input.text || '').trim();
          const actId = `act_${turnId}`;
          const activity = {
            id: actId,
            turnId,
            origin: 'user_turn',
            state: 'running',
            summary: text.slice(0, 80) || 'AGY Lite Turn',
            evidence: makeEvidence(),
            updatedAt: Date.now(),
          };
          state.activities = [...state.activities.filter((a) => a.id !== actId), activity];
          appendNativeEvent(state, 'native.activity.changed', { activity: { ...activity } });
          emit({ type: 'session.ready', nativeSessionId });
          emit({ type: 'turn.started', turnId });

          const isSlow = text.includes('[slow]') || text.includes('--slow');
          const delayMs = isSlow ? 1500 : 15;

          const finish = async () => {
            if (activeTurnId !== turnId || disposed || sessionDisposed) return;
            activeTurnId = null;
            if (activeTimer) {
              activeTimers.delete(activeTimer);
              activeTimer = null;
            }
            const reply = `[AGY Lite:${instanceId}] (${state.mode}/${state.model}) ${text}`;
            activity.state = 'finished';
            activity.summary = reply;
            activity.updatedAt = Date.now();
            appendNativeEvent(state, 'native.activity.changed', { activity: { ...activity } });
            state.timelineByScope.set(`activity:${actId}`, [
              {
                entryId: `ent_${turnId}_1`,
                seq: state.asOfSeq,
                timestamp: Date.now(),
                actorKind: 'agent',
                actorId: state.agents[0].id,
                kind: 'message',
                text: reply,
              },
            ]);
            try {
              const history = (await ctx.storage.plugin.get('turns')) || [];
              history.push({ turnId, sessionId: hmSessionId, instanceId, runId, nativeSessionId, text });
              await ctx.storage.plugin.set('turns', history.slice(-50));
            } catch {
              // ignore storage errors
            }
            emit({ type: 'message.assistant.delta', turnId, delta: reply });
            emit({ type: 'message.assistant.completed', turnId, text: reply });
            emit({ type: 'turn.completed', turnId, stopReason: 'end_turn' });
          };

          if (isSlow) {
            activeTimer = setTimeout(() => {
              void finish();
            }, delayMs);
            activeTimers.add(activeTimer);
          } else {
            await finish();
          }
        },
        interrupt: async () => {
          cancelActiveTurn('interrupted');
        },
        resolveApproval: async () => {},
        runNativeCommand: async (command, argsText = '') => {
          const cmd = String(command || '').replace(/^\//, '').toLowerCase();
          if (cmd === 'mode') {
            const nextMode = argsText.trim() || 'normal';
            state.mode = nextMode;
            appendNativeEvent(state, 'native.runtime.changed', { status: 'connected' });
            return { handled: true, output: `[AGY Lite:${instanceId}] mode=${nextMode}`, updatedMode: nextMode };
          }
          if (cmd === 'model') {
            const nextModel = argsText.trim() || models[0].id;
            state.model = nextModel;
            return { handled: true, output: `[AGY Lite:${instanceId}] model=${nextModel}`, updatedModel: nextModel };
          }
          if (cmd === 'swarm') {
            const wfId = `wf_swarm_${Date.now().toString(36)}`;
            const wf = {
              id: wfId,
              originActivityId: state.activities.at(-1)?.id || 'act_root',
              state: { kind: 'known', value: 'running', evidence: makeEvidence() },
              detail: {
                kind: 'swarm',
                coordinatorId: state.agents[0].id,
                workerIds: [],
                board: { kind: 'known', value: 'available', evidence: makeEvidence() },
                objective: argsText.trim() || 'Lite Swarm Replay',
              },
              revision: 1,
            };
            state.workflows.push(wf);
            state.workflowResources.set(`${wfId}:board`, [
              { id: 'msg_1', sender: 'coordinator', body: `Swarm started: ${wf.detail.objective}` },
            ]);
            appendNativeEvent(state, 'native.workflow.changed', { workflow: wf });
            return { handled: true, output: `[AGY Lite:${instanceId}] launched swarm ${wfId}` };
          }
          if (cmd === 'status') {
            return {
              handled: true,
              output: JSON.stringify({
                providerInstanceId: instanceId,
                harnessId,
                mode: state.mode,
                model: state.model,
                asOfSeq: state.asOfSeq,
                workflows: state.workflows.length,
              }),
            };
          }
          return { handled: false, output: `Unsupported AGY Lite command: /${cmd}` };
        },
        dispose: async () => {
          sessionDisposed = true;
          cancelActiveTurn('disposed');
          listeners.clear();
        },
        onEvent: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    },
  });

  // Publish agy.runtime.v1
  ctx.provide(
    'agy.runtime.v1',
    {
      async getProviderIdentity(req = {}) {
        return {
          pluginId: 'hm.plugin.agy-driver-lite',
          pluginInstanceId: instanceId,
          driverProviderInstanceId: instanceId,
          runId,
          harnessId,
          profileInstanceId,
          runtimeId: req.sessionId ? ensureRuntimeState(req.sessionId).binding.runtimeId : null,
          generation,
          provenancePolicy: 'permissive',
          declaredWorkflows: ['reactive', 'swarm'],
        };
      },
      async getSnapshot(req) {
        const state = ensureRuntimeState(req.sessionId);
        return {
          schemaVersion: 1,
          projection: buildProjection(state),
          capabilitiesRevision: state.capabilitiesRevision,
        };
      },
      async getCapabilities(req) {
        const state = ensureRuntimeState(req.sessionId);
        return {
          schemaVersion: 1,
          binding: state.binding,
          capabilitiesRevision: state.capabilitiesRevision,
          descriptors: declaredCapabilities,
        };
      },
      async getEvents(req) {
        const state = ensureRuntimeState(req.sessionId);
        const afterSeq = typeof req.afterSeq === 'number' ? req.afterSeq : 0;
        const limit = typeof req.limit === 'number' ? req.limit : 200;
        const events = state.events.filter((e) => e.seq > afterSeq).slice(0, limit);
        return {
          schemaVersion: 1,
          binding: state.binding,
          events,
          nextSeq: events.length ? events[events.length - 1].seq : afterSeq,
          hasMore: state.events.filter((e) => e.seq > afterSeq).length > limit,
        };
      },
      async getTimeline(req) {
        const state = ensureRuntimeState(req.sessionId);
        const key = `${req.scopeKind}:${req.scopeId}`;
        return {
          schemaVersion: 1,
          scopeKind: req.scopeKind,
          scopeId: req.scopeId,
          revision: state.asOfSeq,
          items: state.timelineByScope.get(key) || [],
          nextPageToken: null,
          hasMore: false,
        };
      },
      async getWorkflowResource(req) {
        const state = ensureRuntimeState(req.sessionId);
        const key = `${req.workflowId}:${req.resource}`;
        return {
          schemaVersion: 1,
          workflowId: req.workflowId,
          resource: req.resource,
          revision: state.asOfSeq,
          items: state.workflowResources.get(key) || [],
          nextPageToken: null,
          hasMore: false,
        };
      },
      async submitCommand(req) {
        const state = ensureRuntimeState(req.sessionId);
        if (req.bindingGeneration && req.bindingGeneration !== state.binding.generation) {
          return {
            __nativeError: {
              statusCode: 409,
              code: 'STALE_BINDING',
              message: `Expected generation ${state.binding.generation}, got ${req.bindingGeneration}`,
            },
          };
        }
        const cacheKey = `${req.sessionId}:${req.idempotencyKey}`;
        if (receiptCache.has(cacheKey)) {
          return receiptCache.get(cacheKey);
        }
        let output = `[AGY Lite:${instanceId}] executed ${req.capabilityId}/${req.actionKey}`;
        if (req.capabilityId === 'agy.lite.mode' && req.actionKey === 'set_mode') {
          state.mode = String(req.args?.mode || 'normal');
          output = `[AGY Lite:${instanceId}] mode=${state.mode}`;
          appendNativeEvent(state, 'native.runtime.changed', { status: 'connected' });
        } else if (req.capabilityId === 'agy.lite.swarm' && req.actionKey === 'launch') {
          const wfId = `wf_swarm_${Date.now().toString(36)}`;
          const wf = {
            id: wfId,
            originActivityId: state.activities.at(-1)?.id || 'act_root',
            state: { kind: 'known', value: 'running', evidence: makeEvidence() },
            detail: {
              kind: 'swarm',
              coordinatorId: state.agents[0].id,
              workerIds: [],
              board: { kind: 'known', value: 'available', evidence: makeEvidence() },
              objective: String(req.args?.objective || 'SDK Command Swarm'),
            },
            revision: 1,
          };
          state.workflows.push(wf);
          state.workflowResources.set(`${wfId}:board`, [
            { id: 'msg_cmd_1', sender: 'coordinator', body: wf.detail.objective },
          ]);
          appendNativeEvent(state, 'native.workflow.changed', { workflow: wf });
          output = `[AGY Lite:${instanceId}] launched ${wfId}`;
        }
        const response = {
          schemaVersion: 1,
          status: 'completed',
          receiptId: `rcpt_${Date.now().toString(36)}`,
          output,
        };
        receiptCache.set(cacheKey, response);
        return response;
      },
      async dispatchControl(req) {
        const state = ensureRuntimeState(req.sessionId);
        if (req.generation && req.generation !== state.binding.generation) {
          return {
            __nativeError: {
              statusCode: 409,
              code: 'STALE_BINDING',
              message: `Stale generation ${req.generation}`,
            },
          };
        }
        if (req.action === 'cancel' || req.action === 'interrupt') {
          if (req.target?.type === 'workflow') {
            const wf = state.workflows.find((w) => w.id === req.target.id);
            if (wf) {
              if (typeof req.expectedRevision === 'number' && wf.revision !== req.expectedRevision) {
                return {
                  __nativeError: {
                    statusCode: 409,
                    code: 'REVISION_CONFLICT',
                    message: `Expected revision ${wf.revision}, got ${req.expectedRevision}`,
                  },
                };
              }
              wf.state = { kind: 'known', value: 'cancelled', evidence: makeEvidence() };
              wf.revision += 1;
              appendNativeEvent(state, 'native.workflow.changed', { workflow: { ...wf } });
            }
          } else if (typeof state.activeInterrupt === 'function') {
            state.activeInterrupt('control_cancel');
          }
          return {
            schemaVersion: 1,
            receiptId: `ctrl_${Date.now().toString(36)}`,
            state: 'applied',
          };
        }
        return {
          schemaVersion: 1,
          receiptId: `ctrl_${Date.now().toString(36)}`,
          state: 'noop',
          reasonCode: `unsupported_control_${req.action}`,
        };
      },
      async getPendingRequests(req) {
        const state = ensureRuntimeState(req.sessionId);
        return {
          schemaVersion: 1,
          binding: state.binding,
          requests: [],
        };
      },
      async resolveRequest(req) {
        return {
          schemaVersion: 1,
          approvalId: req.approvalId,
          receiptId: `req_rcpt_${Date.now().toString(36)}`,
          receiptState: 'response_written',
        };
      },
      async verifyDispatchProvenance() {
        return {
          allowed: true,
          reasonCode: 'external_peer_policy',
          policyMode: 'permissive',
        };
      },
      async decideTurnSettlement(req) {
        return {
          kind: 'settle',
          terminalStatus: req.adapterOutcome === 'cancelled' ? 'cancelled' : req.adapterOutcome === 'failed' ? 'failed' : 'completed',
          reasonIds: [],
          binding: req.sessionId ? ensureRuntimeState(req.sessionId).binding : null,
        };
      },
    },
    { version: '1.0.0', metadata: { harnessId, label, homeDir } },
  );

  // Publish agy.accounts.v1
  ctx.provide(
    'agy.accounts.v1',
    {
      async listAccounts() {
        return {
          providerInstanceId: instanceId,
          accounts: [
            {
              profileInstanceId,
              harnessId,
              label,
              homeDir,
              binaryPath,
              authState: accountState,
            },
          ],
        };
      },
      async getAccountState() {
        return accountState;
      },
      async startLogin(req = {}) {
        accountState = {
          ...accountState,
          loggedIn: true,
          email: req.email || accountLabel,
          updatedAt: Date.now(),
        };
        await ctx.storage.plugin.set('accountState', accountState);
        if (ctx.services && typeof ctx.services.publish === 'function') {
          ctx.services.publish('agy.accounts.v1', {
            providerInstanceId: instanceId,
            state: accountState,
          });
        }
        return { ok: true, state: accountState };
      },
      async logout() {
        accountState = {
          ...accountState,
          loggedIn: false,
          email: null,
          updatedAt: Date.now(),
        };
        await ctx.storage.plugin.set('accountState', accountState);
        if (ctx.services && typeof ctx.services.publish === 'function') {
          ctx.services.publish('agy.accounts.v1', {
            providerInstanceId: instanceId,
            state: accountState,
          });
        }
        return { ok: true, state: accountState };
      },
    },
    { version: '1.0.0', metadata: { harnessId, label, profileInstanceId } },
  );

  // Publish agy.workbench.v1
  ctx.provide(
    'agy.workbench.v1',
    {
      async readWorkbenchState(req = {}) {
        const sid = typeof req.sessionId === 'string' ? req.sessionId : '__default__';
        const stored =
          workbenchStateBySession.get(sid) ||
          (await ctx.storage.plugin.get(`wb:${sid}`)) || { surface: 'runtime', mode: 'normal' };
        return { ok: true, value: { sessionId: sid, state: stored } };
      },
      async writeWorkbenchState(req = {}) {
        const sid = typeof req.sessionId === 'string' ? req.sessionId : '__default__';
        const prev = workbenchStateBySession.get(sid) || { surface: 'runtime' };
        const next = { ...prev, ...(req.patch || {}) };
        workbenchStateBySession.set(sid, next);
        await ctx.storage.plugin.set(`wb:${sid}`, next);
        if (ctx.services && typeof ctx.services.publish === 'function') {
          ctx.services.publish('agy.workbench.v1', {
            sessionId: sid,
            state: next,
            sourceId: req.sourceId || instanceId,
          });
        }
        return { ok: true, value: { sessionId: sid, state: next } };
      },
      async listSurfaces() {
        return {
          surfaces: [
            { id: 'runtime', label: 'AGY Lite Runtime' },
            { id: 'swarm', label: 'AGY Lite Swarm' },
          ],
        };
      },
    },
    { version: '1.0.0', metadata: { label, embeddedSlot: 'agy-lite-workbench' } },
  );

  ctx.effect(() => {
    return () => {
      disposed = true;
      for (const timer of activeTimers) {
        clearTimeout(timer);
      }
      activeTimers.clear();
      runtimeBySession.clear();
      receiptCache.clear();
      workbenchStateBySession.clear();
    };
  });
}
