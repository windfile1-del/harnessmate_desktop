export const provides = ['session.runtime.v1'];

class PluginApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'PluginApiError';
  }
}

function peerOk(value) {
  return { ok: true, value };
}

function peerErr(code, message) {
  return { ok: false, error: { code, message } };
}

function simpleHash(input) {
  const json = JSON.stringify(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export async function apply(ctx) {
    const runtimeInstanceId = ctx.instanceId || ctx.pluginId;
    const runtimeRunId = ctx.runId;
    let active = true;
    let acceptingTurns = true;
    let generationCounter = 0;

    const liveHandles = new Map(); // sessionId::harnessId -> { handle, unsubscribe, generation, dataInstanceId, disposed, lastConfirmed }
    const activeTurnMeta = new Map(); // sessionId -> { turnId, runId, requestId, requestHash, dataInstanceId, harnessId, harnessKind, model, turnGeneration, startedAt, settled }
    const startingSessions = new Set();
    const pendingRecoveries = new Map();
    const settledTurnIds = new Set();
    const deltaBuffers = new Map(); // sessionId -> { turnId, harnessId, text, timer }
    const commitQueues = new Map();

    const handleKey = (sessionId, harnessId) => `${sessionId}::${harnessId}`;

    const enqueueCommit = (sessionId, fn) => {
      const prev = commitQueues.get(sessionId) || Promise.resolve();
      const next = prev.then(fn, fn);
      const marker = next.then(() => undefined, () => undefined);
      commitQueues.set(sessionId, marker);
      void marker.finally(() => {
        if (commitQueues.get(sessionId) === marker) commitQueues.delete(sessionId);
      });
      return next;
    };

    const callData = async (method, args, opts) => {
      const res = await ctx.services.call('session.data.v1', method, args, opts);
      if (res && typeof res === 'object' && 'ok' in res) {
        if (!res.ok) {
          throw new PluginApiError(
            res.error?.code === 'plugin_disabled' ? 'E_PLUGIN_DISABLED' : 'E_SERVICE_UNAVAILABLE',
            res.error?.message || `session.data.v1.${method} failed`,
          );
        }
        return res.value;
      }
      return res;
    };

    const publishRuntimeChannel = (payload) => {
      if (!active || typeof ctx.services?.publish !== 'function') return;
      ctx.services.publish('session.runtime.v1', payload);
    };

    const flushDeltas = async (sessionId) => {
      const buf = deltaBuffers.get(sessionId);
      if (!buf) return;
      if (buf.timer) clearTimeout(buf.timer);
      deltaBuffers.delete(sessionId);
      if (!buf.text) return;
      await enqueueCommit(sessionId, async () => {
        if (!active) return;
        await callData('commitBatch', [{
          sessionId,
          events: [{
            type: 'message.assistant.delta',
            turnId: buf.turnId,
            payload: { text: buf.text, harnessId: buf.harnessId },
          }],
        }], { explicitInstanceId: buf.dataInstanceId });
      });
    };

    const disposeHandleEntry = async (entry) => {
      if (!entry || entry.disposed) return;
      entry.disposed = true;
      if (liveHandles.get(entry.key) === entry) liveHandles.delete(entry.key);
      try { entry.unsubscribe(); } catch {}
      await entry.handle.dispose().catch(() => {});
    };

    const openOrReuseHandle = async (session, dataInstanceId, harnessId) => {
      const key = handleKey(session.id, harnessId);
      const existing = liveHandles.get(key);
      if (existing && !existing.disposed && existing.dataInstanceId === dataInstanceId) {
        return existing;
      }
      if (existing) await disposeHandleEntry(existing);

      const handle = await ctx.harnesses.openSession(harnessId, {
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
        nativeSessionId: session.nativeSessionId,
      });
      generationCounter += 1;
      const entry = {
        key,
        sessionId: session.id,
        harnessId,
        harnessKind: session.harnessKind,
        dataInstanceId,
        generation: generationCounter,
        handle,
        disposed: false,
        lastConfirmed: null,
        unsubscribe: () => {},
      };

      entry.unsubscribe = handle.onEvent((ev) => {
        if (!active || entry.disposed || liveHandles.get(key) !== entry) return;
        const evTurnId = typeof ev?.turnId === 'string' ? ev.turnId : undefined;
        const meta = activeTurnMeta.get(session.id);
        if (evTurnId && settledTurnIds.has(evTurnId)) return;
        if (meta && evTurnId && meta.turnId !== evTurnId) return;
        if (!meta && (
          ev.type === 'message.assistant.delta' ||
          ev.type === 'message.delta' ||
          ev.type === 'message.assistant.completed' ||
          ev.type === 'message.completed' ||
          ev.type === 'turn.completed' ||
          ev.type === 'turn.failed' ||
          ev.type === 'turn.cancelled'
        )) {
          return;
        }

        if (ev.type === 'message.assistant.delta' || ev.type === 'message.delta') {
          const turnId = meta?.turnId ?? evTurnId;
          let buf = deltaBuffers.get(session.id);
          if (buf && buf.turnId !== turnId) {
            void flushDeltas(session.id);
            buf = undefined;
          }
          if (!buf) {
            buf = {
              turnId,
              harnessId,
              dataInstanceId,
              text: '',
              timer: setTimeout(() => { void flushDeltas(session.id); }, 40),
            };
            deltaBuffers.set(session.id, buf);
          }
          buf.text += String(ev.text || '');
          return;
        }

        if (ev.type === 'model.confirmed') {
          entry.lastConfirmed = { ...(entry.lastConfirmed || {}), model: ev.actualModel, actualModel: ev.actualModel };
        } else if (ev.type === 'config.confirmed') {
          entry.lastConfirmed = {
            model: ev.model ?? null,
            thoughtLevel: ev.thoughtLevel ?? null,
            modeId: ev.modeId ?? null,
            permissionEnforcement: ev.permissionEnforcement ?? 'native',
          };
        }

        if (
          ev.type === 'turn.started' ||
          ev.type === 'message.assistant.completed' ||
          ev.type === 'message.completed' ||
          ev.type === 'turn.completed' ||
          ev.type === 'turn.failed' ||
          ev.type === 'turn.cancelled'
        ) {
          void flushDeltas(session.id);
        }

        void enqueueCommit(session.id, async () => {
          if (!active || entry.disposed || liveHandles.get(key) !== entry) return;
          const activeNow = activeTurnMeta.get(session.id);
          if (activeNow && evTurnId && activeNow.turnId !== evTurnId) return;
          const now = Date.now();

          if (ev.type === 'model.confirmed') {
            entry.lastConfirmed = { ...(entry.lastConfirmed || {}), model: ev.actualModel, actualModel: ev.actualModel };
            await callData('commitBatch', [{
              sessionId: session.id,
              sessionPatch: { actualModel: ev.actualModel },
            }], { explicitInstanceId: dataInstanceId });
            return;
          }

          if (ev.type === 'config.confirmed') {
            entry.lastConfirmed = {
              model: ev.model ?? null,
              thoughtLevel: ev.thoughtLevel ?? null,
              modeId: ev.modeId ?? null,
              permissionEnforcement: ev.permissionEnforcement ?? 'native',
            };
            await callData('commitBatch', [{
              sessionId: session.id,
              events: [{
                type: 'session.config_confirmed',
                turnId: activeNow?.turnId ?? null,
                payload: {
                  harnessId,
                  model: ev.model ?? null,
                  thoughtLevel: ev.thoughtLevel ?? null,
                  modeId: ev.modeId ?? null,
                  permissionEnforcement: ev.permissionEnforcement ?? 'native',
                },
              }],
            }], { explicitInstanceId: dataInstanceId });
            return;
          }

          if (ev.type === 'turn.started') {
            await callData('commitBatch', [{
              sessionId: session.id,
              events: [{
                type: 'turn.started',
                turnId: ev.turnId,
                payload: { harnessId, harnessKind: session.harnessKind, model: session.model },
              }],
            }], { explicitInstanceId: dataInstanceId });
            return;
          }

          if (ev.type === 'message.assistant.completed' || ev.type === 'message.completed') {
            const msgId = ev.messageId || `${ev.turnId}:assistant`;
            await callData('commitBatch', [{
              sessionId: session.id,
              events: [{
                type: 'message.assistant.completed',
                turnId: ev.turnId,
                payload: { text: ev.text, messageId: msgId, harnessId },
              }],
              turnItems: [{
                itemId: `msg:${msgId}`,
                schemaVersion: 2,
                turnId: ev.turnId,
                instanceId: harnessId,
                driverId: session.harnessKind,
                blockType: 'assistant_text',
                status: 'completed',
                title: 'Assistant',
                textBody: String(ev.text || ''),
                payload: { messageId: msgId },
                outputOmitted: false,
                omittedBytes: 0,
                createdAt: now,
                updatedAt: now,
              }],
            }], { explicitInstanceId: dataInstanceId });
            return;
          }

          if (ev.type === 'turn_block.ext') {
            await callData('commitBatch', [{
              sessionId: session.id,
              turnItems: [{
                itemId: ev.itemId,
                schemaVersion: 2,
                turnId: ev.turnId,
                seq: session.lastSeq || 0,
                instanceId: harnessId,
                driverId: session.harnessKind,
                blockType: ev.blockType,
                status: ev.status ?? 'completed',
                title: ev.title,
                textBody: ev.fallbackSummary ?? '',
                payload: ev.payload ?? {},
                outputOmitted: false,
                omittedBytes: 0,
                createdAt: now,
                updatedAt: now,
              }],
            }], { explicitInstanceId: dataInstanceId });
            return;
          }

          if (ev.type === 'turn.completed' || ev.type === 'turn.cancelled' || ev.type === 'turn.failed') {
            if (activeNow?.settled || settledTurnIds.has(ev.turnId)) return;
            if (activeNow) activeNow.settled = true;
            settledTurnIds.add(ev.turnId);
            activeTurnMeta.delete(session.id);

            const runStatus = ev.type === 'turn.completed' ? 'completed' : ev.type === 'turn.cancelled' ? 'cancelled' : 'failed';
            const sessStatus = ev.type === 'turn.failed' ? 'error' : 'idle';
            const out = await callData('commitBatch', [{
              sessionId: session.id,
              sessionPatch: { status: sessStatus },
              ...(activeNow ? { runFinish: { runId: activeNow.runId, status: runStatus, endedAt: now } } : {}),
              settleRunningItemsStatus: ev.type === 'turn.completed' ? 'completed' : 'interrupted',
              events: [
                {
                  type: ev.type,
                  turnId: ev.turnId,
                  payload: {
                    harnessId,
                    harnessKind: session.harnessKind,
                    ...(ev.type === 'turn.completed' ? { stopReason: ev.stopReason ?? 'end_turn' } : {}),
                    ...(ev.type === 'turn.failed' ? { message: ev.message, code: ev.code ?? null } : {}),
                  },
                },
                { type: 'session.status', payload: { status: sessStatus } },
              ],
              ...(activeNow?.requestId && activeNow.requestHash ? {
                turnReceipt: {
                  sessionId: session.id,
                  requestId: activeNow.requestId,
                  requestHash: activeNow.requestHash,
                  turnId: activeNow.turnId,
                  runId: activeNow.runId,
                  status: runStatus,
                  runtimeInstanceId,
                  runtimeRunId,
                  createdAt: activeNow.startedAt,
                  updatedAt: now,
                },
              } : {}),
            }], { explicitInstanceId: dataInstanceId });
            publishRuntimeChannel({ kind: 'turn_settled', sessionId: session.id, turnId: ev.turnId, lastSeq: out.latestSeq });
          }
        });
      });

      liveHandles.set(key, entry);
      return entry;
    };

    const runtimeService = {
      async getRuntimeInfo() {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        return peerOk({
          runtimeInstanceId,
          runtimeRunId,
          acceptingTurns,
          activeTurnCount: activeTurnMeta.size,
          liveHandleCount: liveHandles.size,
          pendingRecoveryCount: pendingRecoveries.size,
        });
      },

      async sendTurn(req) {
        if (!active || !acceptingTurns) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用或正在排空`);
        if (startingSessions.has(req.sessionId)) return peerErr('conflict', '会话正在启动轮次');
        startingSessions.add(req.sessionId);
        try {
          const dataResolution = await ctx.services.resolve('session.data.v1', {
            explicitInstanceId: req.dataInstanceId,
            sessionId: req.sessionId,
            allowSingleCandidate: true,
          });
          if (dataResolution.status !== 'ready' || !dataResolution.instanceId) {
            return peerErr('plugin_disabled', `会话数据服务不可用 (${dataResolution.status})`);
          }
          const dataInstanceId = dataResolution.instanceId;
          const sessOut = await callData('getSession', [{ sessionId: req.sessionId }], { explicitInstanceId: dataInstanceId });
          const session = sessOut.session;
          if (!session) return peerErr('not_found', `会话不存在: ${req.sessionId}`);

          const harnessId = req.harnessId || session.harnessId;
          const requestHash = req.requestId
            ? simpleHash({ sessionId: req.sessionId, text: req.text, harnessId, model: req.model ?? null })
            : undefined;

          if (req.requestId && requestHash) {
            const rcOut = await callData('getTurnReceipt', [{ sessionId: req.sessionId, requestId: req.requestId }], {
              explicitInstanceId: dataInstanceId,
            });
            const existing = rcOut.receipt;
            if (existing) {
              if (existing.requestHash !== requestHash) {
                return peerErr('conflict', `requestId ${req.requestId} 参数冲突`);
              }
              return peerOk({
                sessionId: req.sessionId,
                turnId: existing.turnId,
                runId: existing.runId,
                requestId: existing.requestId,
                disposition: 'reused',
                status: existing.status,
                runtimeInstanceId: existing.runtimeInstanceId,
                runtimeRunId: existing.runtimeRunId,
                dataInstanceId,
                harnessId,
                turnGeneration: 0,
              });
            }
          }

          if (session.status === 'running' || session.status === 'awaiting_approval') {
            return peerErr('conflict', '会话当前正在运行或等待审批');
          }
          if (session.status === 'archived') {
            return peerErr('conflict', '会话已归档');
          }

          const turnId = `turn_lite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const runId = `run_lite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          generationCounter += 1;
          const turnGeneration = generationCounter;
          const now = Date.now();
          const meta = {
            turnId,
            runId,
            requestId: req.requestId,
            requestHash,
            dataInstanceId,
            harnessId,
            harnessKind: session.harnessKind,
            model: req.model !== undefined ? req.model : session.model,
            turnGeneration,
            startedAt: now,
            settled: false,
          };
          activeTurnMeta.set(session.id, meta);

          await enqueueCommit(session.id, async () =>
            callData('commitBatch', [{
              sessionId: session.id,
              sessionPatch: { status: 'running' },
              runStart: {
                runId,
                sessionId: session.id,
                turnId,
                instanceId: harnessId,
                driverId: session.harnessKind,
                model: meta.model,
                status: 'running',
                startedAt: now,
              },
              events: [
                {
                  type: 'message.user',
                  turnId,
                  createdAt: now,
                  payload: { text: req.text, harnessId, harnessKind: session.harnessKind, model: meta.model },
                },
                { type: 'session.status', createdAt: now, payload: { status: 'running' } },
              ],
              turnItems: [{
                itemId: `${turnId}:user`,
                schemaVersion: 2,
                turnId,
                instanceId: harnessId,
                driverId: session.harnessKind,
                blockType: 'user_message',
                status: 'completed',
                title: 'User',
                textBody: req.text,
                payload: {},
                outputOmitted: false,
                omittedBytes: 0,
                createdAt: now,
                updatedAt: now,
              }],
              ...(req.requestId && requestHash ? {
                turnReceipt: {
                  sessionId: session.id,
                  requestId: req.requestId,
                  requestHash,
                  turnId,
                  runId,
                  status: 'running',
                  runtimeInstanceId,
                  runtimeRunId,
                  createdAt: now,
                  updatedAt: now,
                },
              } : {}),
            }], { explicitInstanceId: dataInstanceId }),
          );

          let dispatchStarted = false;
          try {
            const entry = await openOrReuseHandle(session, dataInstanceId, harnessId);
            dispatchStarted = true;
            await entry.handle.sendTurn({
              turnId,
              text: req.text,
              model: meta.model,
              reasoningEffort: session.reasoningEffort,
              permissionMode: session.permissionMode,
            });
            const pendingCommit = commitQueues.get(session.id);
            if (pendingCommit) await pendingCommit.catch(() => {});
            return peerOk({
              sessionId: session.id,
              turnId,
              runId,
              ...(req.requestId ? { requestId: req.requestId } : {}),
              disposition: 'started',
              status: meta.settled ? 'completed' : 'running',
              runtimeInstanceId,
              runtimeRunId,
              dataInstanceId,
              harnessId,
              turnGeneration,
            });
          } catch (err) {
            await flushDeltas(session.id);
            meta.settled = true;
            settledTurnIds.add(turnId);
            activeTurnMeta.delete(session.id);
            const message = err instanceof Error ? err.message : String(err);
            const receiptStatus = dispatchStarted ? 'unknown' : 'failed';
            if (dispatchStarted) {
              pendingRecoveries.set(session.id, {
                sessionId: session.id,
                turnId,
                runId,
                dataInstanceId,
                reason: message,
                recordedAt: Date.now(),
              });
            }
            await enqueueCommit(session.id, async () => {
              await callData('commitBatch', [{
                sessionId: session.id,
                sessionPatch: { status: 'error' },
                runFinish: { runId, status: 'failed', failureClass: receiptStatus === 'unknown' ? 'unknown_outcome' : 'dispatch_error', endedAt: Date.now() },
                settleRunningItemsStatus: 'interrupted',
                events: [
                  { type: 'turn.failed', turnId, payload: { message, code: receiptStatus === 'unknown' ? 'unknown_outcome' : 'dispatch_error' } },
                  { type: 'session.status', payload: { status: 'error' } },
                ],
                ...(req.requestId && requestHash ? {
                  turnReceipt: {
                    sessionId: session.id,
                    requestId: req.requestId,
                    requestHash,
                    turnId,
                    runId,
                    status: receiptStatus,
                    runtimeInstanceId,
                    runtimeRunId,
                    createdAt: now,
                    updatedAt: Date.now(),
                  },
                } : {}),
              }], { explicitInstanceId: dataInstanceId }).catch(() => {});
            });
            return peerErr('conflict', message);
          }
        } finally {
          startingSessions.delete(req.sessionId);
        }
      },

      async getTurnStatus(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        const meta = activeTurnMeta.get(req.sessionId);
        let receipt = null;
        if (req.requestId) {
          const r = await callData('getTurnReceipt', [{ sessionId: req.sessionId, requestId: req.requestId }], { sessionId: req.sessionId }).catch(() => null);
          receipt = r?.receipt ?? null;
        }
        return peerOk({
          active: meta ? {
            sessionId: req.sessionId,
            turnId: meta.turnId,
            runId: meta.runId,
            ...(meta.requestId ? { requestId: meta.requestId } : {}),
            runtimeInstanceId,
            runtimeRunId,
            dataInstanceId: meta.dataInstanceId,
            harnessId: meta.harnessId,
            harnessKind: meta.harnessKind,
            model: meta.model,
            actualModel: null,
            turnGeneration: meta.turnGeneration,
            startedAt: meta.startedAt,
          } : null,
          receipt,
          pendingRecovery: pendingRecoveries.get(req.sessionId) ?? null,
        });
      },

      async interrupt(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        await flushDeltas(req.sessionId);
        const meta = activeTurnMeta.get(req.sessionId);
        const entry = meta ? liveHandles.get(handleKey(req.sessionId, meta.harnessId)) : [...liveHandles.values()].find((e) => e.sessionId === req.sessionId && !e.disposed);
        if (entry) await entry.handle.interrupt().catch(() => {});
        if (meta && !meta.settled) {
          meta.settled = true;
          settledTurnIds.add(meta.turnId);
          activeTurnMeta.delete(req.sessionId);
          const now = Date.now();
          await enqueueCommit(req.sessionId, async () => {
            await callData('commitBatch', [{
              sessionId: req.sessionId,
              sessionPatch: { status: 'idle' },
              runFinish: { runId: meta.runId, status: 'cancelled', endedAt: now },
              settleRunningItemsStatus: 'interrupted',
              events: [
                { type: 'turn.cancelled', turnId: meta.turnId, payload: { harnessId: meta.harnessId, reason: req.reason ?? 'user_interrupt' } },
                { type: 'session.status', payload: { status: 'idle' } },
              ],
              ...(meta.requestId && meta.requestHash ? {
                turnReceipt: {
                  sessionId: req.sessionId,
                  requestId: meta.requestId,
                  requestHash: meta.requestHash,
                  turnId: meta.turnId,
                  runId: meta.runId,
                  status: 'cancelled',
                  runtimeInstanceId,
                  runtimeRunId,
                  createdAt: meta.startedAt,
                  updatedAt: now,
                },
              } : {}),
            }], { explicitInstanceId: meta.dataInstanceId }).catch(() => {});
          });
        }
        return peerOk({ interrupted: Boolean(entry || meta) });
      },

      async applyConfig(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        const out = await callData('updateSession', [{ sessionId: req.sessionId, patch: req.patch }], { sessionId: req.sessionId });
        const updated = out.session;
        if (!updated) return peerErr('not_found', `会话不存在: ${req.sessionId}`);
        const entry = liveHandles.get(handleKey(req.sessionId, updated.harnessId));
        let status = 'pending_next_session';
        let confirmed = {
          model: updated.model,
          actualModel: null,
          reasoningEffort: updated.reasoningEffort,
          permissionMode: updated.permissionMode,
        };
        let note;
        if (entry && !entry.disposed && updated.status === 'idle') {
          entry.lastConfirmed = null;
          try {
            await entry.handle.updateConfig({
              model: updated.model,
              reasoningEffort: updated.reasoningEffort,
              permissionMode: updated.permissionMode,
            });
            const pendingCommit = commitQueues.get(req.sessionId);
            if (pendingCommit) await pendingCommit.catch(() => {});
            status = 'applied';
            if (entry.lastConfirmed) {
              confirmed = {
                model: entry.lastConfirmed.model ?? updated.model,
                actualModel: entry.lastConfirmed.actualModel ?? entry.lastConfirmed.model ?? null,
                reasoningEffort: entry.lastConfirmed.thoughtLevel ?? updated.reasoningEffort,
                permissionMode: updated.permissionMode,
                permissionEnforcement: entry.lastConfirmed.permissionEnforcement ?? null,
              };
            }
          } catch (err) {
            const errCode = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : undefined;
            note = err instanceof Error ? err.message : String(err);
            if (errCode === 'E_NOT_SUPPORTED') {
              status = 'unsupported';
            } else if (errCode === 'E_PENDING_NEXT_SESSION') {
              await disposeHandleEntry(entry);
              status = 'pending_next_session';
            } else {
              status = 'rejected';
            }
          }
        }
        return peerOk({
          sessionId: req.sessionId,
          harnessId: updated.harnessId,
          requested: req.patch,
          confirmed,
          status,
          ...(note ? { note } : {}),
        });
      },

      async closeSession(req) {
        const targets = [...liveHandles.values()].filter((e) => e.sessionId === req.sessionId);
        await flushDeltas(req.sessionId);
        await Promise.all(targets.map((e) => disposeHandleEntry(e)));
        return peerOk({ closedHandles: targets.length });
      },

      async closeHarnessSessions(req) {
        const targets = [...liveHandles.values()].filter((e) => e.harnessId === req.harnessId);
        await Promise.all(targets.map((e) => disposeHandleEntry(e)));
        return peerOk({ closedHandles: targets.length });
      },

      async listActiveTurns() {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        return peerOk({
          turns: [...activeTurnMeta.entries()].map(([sessionId, meta]) => ({
            sessionId,
            turnId: meta.turnId,
            runId: meta.runId,
            ...(meta.requestId ? { requestId: meta.requestId } : {}),
            runtimeInstanceId,
            runtimeRunId,
            dataInstanceId: meta.dataInstanceId,
            harnessId: meta.harnessId,
            harnessKind: meta.harnessKind,
            model: meta.model,
            actualModel: null,
            turnGeneration: meta.turnGeneration,
            startedAt: meta.startedAt,
          })),
        });
      },

      async listPendingRecoveries() {
        return peerOk({ recoveries: [...pendingRecoveries.values()] });
      },

      async recoverStaleRuns(req = {}) {
        if (!active) return peerErr('plugin_disabled', `插件 ${runtimeInstanceId} 已停用`);
        let recoveredCount = 0;
        const providers = req.dataInstanceId
          ? [{ instanceId: req.dataInstanceId }]
          : (await ctx.services.list('session.data.v1')) || [];
        for (const p of providers) {
          if (!p?.instanceId) continue;
          const out = await callData('recoverCrashState', [], { explicitInstanceId: p.instanceId }).catch(() => null);
          if (out) recoveredCount += (out.recoveredRuns || 0) + (out.recoveredItems || 0);
        }
        return peerOk({ recoveredCount });
      },

      async drainAndStop() {
        acceptingTurns = false;
        const activeIds = [...activeTurnMeta.keys()];
        for (const sid of activeIds) await flushDeltas(sid);
        const handles = [...liveHandles.values()];
        await Promise.all(handles.map((e) => disposeHandleEntry(e)));
        activeTurnMeta.clear();
        return peerOk({ drainedTurns: activeIds.length, closedHandles: handles.length });
      },
    };

    void runtimeService.recoverStaleRuns().catch(() => {});

    ctx.provide('session.runtime.v1', runtimeService, {
      version: '1.0.0',
      metadata: { role: 'session-runtime', engine: 'lite-sdk' },
    });

    ctx.effect(() => () => {
      active = false;
      acceptingTurns = false;
      for (const buf of deltaBuffers.values()) {
        if (buf.timer) clearTimeout(buf.timer);
      }
      deltaBuffers.clear();
      for (const e of liveHandles.values()) {
        e.disposed = true;
        try { e.unsubscribe(); } catch {}
        void e.handle.dispose().catch(() => {});
      }
      liveHandles.clear();
      activeTurnMeta.clear();
    });
}
