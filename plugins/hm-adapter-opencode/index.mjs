import {
  OPENCODE_CAPABILITIES,
  OPENCODE_CAPABILITIES_V2,
  OPENCODE_DEFAULT_AGENTS,
  OPENCODE_DEFAULT_MODELS,
  OPENCODE_DRIVER_ID,
  OPENCODE_PRESENTATION,
  buildOpenCodeOptionDescriptors,
  composeInlinePrompt,
  createOpenCodeSseStreamParser,
  normalizeOpenCodeConfig,
  sanitizeOpenCodeError,
  validateImageJobPayload,
  validateServerInfoResponse,
} from './lib/protocol.mjs';
import { OpenCodeServerOwner } from './lib/server-owner.mjs';

export const name = 'hm.adapter.opencode';
export const requires = ['harness.driver.v2', 'runtime.spawnCli', 'ui.slots.v5'];

export async function apply(ctx, initialConfig) {
  const stored = await ctx.storage.plugin.get('config').catch(() => null);
  let currentConfig = normalizeOpenCodeConfig({
    ...(initialConfig && typeof initialConfig === 'object' ? initialConfig : {}),
    ...(stored && typeof stored === 'object' ? stored : {}),
  });

  const activeSessionHandles = new Set();
  const owner = new OpenCodeServerOwner(
    ctx,
    () => currentConfig,
    (reason) => {
      for (const h of [...activeSessionHandles]) {
        h.handleServerCrash(reason);
      }
    },
  );

  ctx.effect(() => () => {
    for (const h of [...activeSessionHandles]) {
      void h.dispose().catch(() => {});
    }
    activeSessionHandles.clear();
    if (currentConfig.mode === 'managed_local') {
      void owner.forget().catch(() => {});
    }
  });

  if (typeof ctx.onConfigUpdated === 'function') {
    ctx.onConfigUpdated(async (nextCfg) => {
      const prevMode = currentConfig.mode;
      const prevUrl = currentConfig.serverUrl;
      const prevSecretRef = currentConfig.serverPasswordSecretRef;
      currentConfig = normalizeOpenCodeConfig({ ...currentConfig, ...(nextCfg || {}) });
      if (
        prevMode !== currentConfig.mode ||
        prevUrl !== currentConfig.serverUrl ||
        prevSecretRef !== currentConfig.serverPasswordSecretRef
      ) {
        await owner.forget();
      }
    });
  }

  function mergeCapabilitiesWithAgents(agents) {
    return {
      ...OPENCODE_CAPABILITIES_V2,
      optionDescriptors: buildOpenCodeOptionDescriptors(agents || OPENCODE_DEFAULT_AGENTS),
    };
  }

  async function probePassiveOrActive(allowCachedManaged) {
    if (currentConfig.mode === 'managed_local') {
      if (allowCachedManaged && owner.managed?.baseUrl) {
        return {
          binaryPath: currentConfig.binaryPath,
          version: owner.managed.serverInfo?.version ?? '2.0.0',
          health: 'ready',
          accountSummary: `OpenCode Local (${owner.managed.baseUrl})`,
          models: owner.managed.serverInfo?.models ?? OPENCODE_DEFAULT_MODELS,
          defaultModelId: (owner.managed.serverInfo?.models?.[0]?.id) ?? 'opencode/default',
          capabilitiesV2: mergeCapabilitiesWithAgents(owner.managed.serverInfo?.agents),
          presentation: OPENCODE_PRESENTATION,
        };
      }
      // Strictly passive local check: ONLY verify binary via `--version`; NEVER launch `opencode serve` or create sessions.
      try {
        const proc = await ctx.runtime.spawnCli({
          command: currentConfig.binaryPath || 'opencode',
          args: ['--version'],
          timeoutMs: 4_000,
        });
        let output = '';
        proc.onStdout((c) => { output += c; });
        proc.onStderr((c) => { output += c; });
        const exit = await proc.wait();
        const verLine = output.trim().split(/\r?\n/)[0] || '';
        if (exit.code !== 0) {
          return {
            binaryPath: currentConfig.binaryPath,
            version: null,
            health: 'unavailable',
            healthMessage: verLine || `opencode --version exited with code ${exit.code}`,
            models: OPENCODE_DEFAULT_MODELS,
            defaultModelId: 'opencode/default',
            capabilitiesV2: OPENCODE_CAPABILITIES_V2,
            presentation: OPENCODE_PRESENTATION,
          };
        }
        return {
          binaryPath: currentConfig.binaryPath,
          version: verLine || '2.0.0',
          health: 'ready',
          accountSummary: 'OpenCode Local (Managed)',
          models: OPENCODE_DEFAULT_MODELS,
          defaultModelId: 'opencode/default',
          capabilitiesV2: OPENCODE_CAPABILITIES_V2,
          presentation: OPENCODE_PRESENTATION,
        };
      } catch (err) {
        return {
          binaryPath: null,
          version: null,
          health: 'unavailable',
          healthMessage: sanitizeOpenCodeError(err, owner.getSecretsForRedaction()),
          models: OPENCODE_DEFAULT_MODELS,
          defaultModelId: 'opencode/default',
          capabilitiesV2: OPENCODE_CAPABILITIES_V2,
          presentation: OPENCODE_PRESENTATION,
        };
      }
    }

    // External server mode: read-only 5s GET `/server/info` (never creates a session!)
    if (!currentConfig.serverUrl) {
      return {
        binaryPath: null,
        version: null,
        health: 'unavailable',
        healthMessage: 'OpenCode serverUrl is not configured.',
        models: OPENCODE_DEFAULT_MODELS,
        defaultModelId: 'opencode/default',
        capabilitiesV2: OPENCODE_CAPABILITIES_V2,
        presentation: OPENCODE_PRESENTATION,
      };
    }

    const password = await owner.resolveExternalPassword(currentConfig);
    const secrets = password ? [password] : [];
    const connection = {
      mode: 'external_server',
      baseUrl: currentConfig.serverUrl,
      password,
    };

    try {
      const res = await owner.fetchJson(connection, '/server/info', { method: 'GET' }, Math.min(5_000, currentConfig.connectTimeoutMs));
      const info = validateServerInfoResponse(res.status, res.headers, res.body);
      let models = info.models && info.models.length > 0 ? info.models : OPENCODE_DEFAULT_MODELS;
      let agents = info.agents && info.agents.length > 0 ? info.agents : OPENCODE_DEFAULT_AGENTS;

      // Optional dynamic models/agents lookup (graceful degradation if 404)
      try {
        const modelsRes = await owner.fetchJson(connection, '/models', { method: 'GET' }, 3_000);
        if (modelsRes.ok) {
          const parsed = JSON.parse(modelsRes.body);
          if (Array.isArray(parsed?.models) && parsed.models.length > 0) models = parsed.models;
        }
      } catch { /* ignore optional endpoint failure */ }
      try {
        const agentsRes = await owner.fetchJson(connection, '/agents', { method: 'GET' }, 3_000);
        if (agentsRes.ok) {
          const parsed = JSON.parse(agentsRes.body);
          if (Array.isArray(parsed?.agents) && parsed.agents.length > 0) agents = parsed.agents;
        }
      } catch { /* ignore optional endpoint failure */ }

      return {
        binaryPath: null,
        version: info.version,
        health: 'ready',
        accountSummary: `OpenCode (${currentConfig.serverUrl})`,
        models,
        defaultModelId: models[0]?.id ?? 'opencode/default',
        capabilitiesV2: mergeCapabilitiesWithAgents(agents),
        presentation: OPENCODE_PRESENTATION,
      };
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      const safeMsg = sanitizeOpenCodeError(err, secrets);
      return {
        binaryPath: null,
        version: null,
        health: code === 'auth_failed' ? 'unauthenticated' : 'unavailable',
        healthMessage: safeMsg,
        models: OPENCODE_DEFAULT_MODELS,
        defaultModelId: 'opencode/default',
        capabilitiesV2: OPENCODE_CAPABILITIES_V2,
        presentation: OPENCODE_PRESENTATION,
      };
    }
  }

  ctx.harnesses.registerDriver({
    driverId: OPENCODE_DRIVER_ID,
    displayName: 'OpenCode',
    description: 'OpenCode 2.x Server HTTP REST + SSE Adapter',
    protocolLabel: 'opencode-http-sse',
    capabilities: OPENCODE_CAPABILITIES,
    capabilitiesV2: OPENCODE_CAPABILITIES_V2,
    presentation: OPENCODE_PRESENTATION,
    probePassive: () => probePassiveOrActive(true),
    probe: () => probePassiveOrActive(true),
    async readUsageLimits() {
      if (currentConfig.mode === 'managed_local' && !owner.managed?.baseUrl) {
        return {
          loggedIn: true,
          accountLabel: 'OpenCode Local (Standby)',
          planType: 'local',
          authMethod: 'managed_local',
          billingTier: 'local_free',
          rateLimits: [],
        };
      }
      try {
        const conn = await owner.ensureConnection();
        const secrets = conn.password ? [conn.password] : [];
        const res = await owner.fetchJson(conn, '/usage/limits', { method: 'GET' }, 5_000);
        if (res.status === 401 || res.status === 403) {
          return {
            loggedIn: false,
            accountLabel: null,
            planType: null,
            authMethod: conn.mode,
            rateLimits: [],
            error: 'The OpenCode server rejected the server password.',
          };
        }
        if (res.status === 404) {
          return {
            loggedIn: true,
            accountLabel: conn.mode === 'managed_local' ? 'OpenCode Local' : conn.baseUrl,
            planType: null,
            authMethod: conn.mode,
            billingTier: conn.mode === 'managed_local' ? 'local_free' : 'api_payg',
            rateLimits: [],
          };
        }
        if (!res.ok) {
          return {
            loggedIn: false,
            accountLabel: null,
            planType: null,
            authMethod: conn.mode,
            rateLimits: [],
            error: sanitizeOpenCodeError(`HTTP ${res.status}`, secrets),
          };
        }
        const parsed = JSON.parse(res.body || '{}');
        return {
          loggedIn: parsed.loggedIn !== false,
          accountLabel: parsed.accountLabel ?? (conn.mode === 'managed_local' ? 'OpenCode Local' : conn.baseUrl),
          planType: parsed.planType ?? null,
          authMethod: parsed.authMethod ?? conn.mode,
          billingTier: parsed.billingTier ?? (conn.mode === 'managed_local' ? 'local_free' : 'api_payg'),
          gatewayUrl: conn.mode === 'external_server' ? conn.baseUrl : null,
          rateLimits: Array.isArray(parsed.rateLimits) ? parsed.rateLimits : [],
        };
      } catch (err) {
        const secrets = owner.getSecretsForRedaction();
        return {
          loggedIn: false,
          accountLabel: null,
          planType: null,
          authMethod: currentConfig.mode,
          rateLimits: [],
          error: sanitizeOpenCodeError(err, secrets),
        };
      }
    },
    async createSession(sessionConfig) {
      const conn = await owner.ensureConnection();
      const secrets = conn.password ? [conn.password] : [];
      let nativeSessionId = sessionConfig.nativeSessionId || null;

      if (!nativeSessionId) {
        const createRes = await owner.fetchJson(
          conn,
          '/sessions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              directory: sessionConfig.cwd,
              model: sessionConfig.model || 'opencode/default',
              agent: currentConfig.defaultAgent || 'build',
              permissionMode: sessionConfig.permissionMode || 'manual',
            }),
          },
          currentConfig.connectTimeoutMs || 5_000,
        );
        if (createRes.status === 401 || createRes.status === 403) {
          throw new Error('The OpenCode server rejected the server password.');
        }
        if (!createRes.ok) {
          throw new Error(sanitizeOpenCodeError(`Failed to create OpenCode session (HTTP ${createRes.status})`, secrets));
        }
        const created = JSON.parse(createRes.body || '{}');
        nativeSessionId = String(created.sessionID || created.id || '');
        if (!nativeSessionId) {
          throw new Error('The server is not an OpenCode 2 server.');
        }
      }

      const listeners = new Set();
      let currentModel = sessionConfig.model || 'opencode/default';
      let currentEffort = sessionConfig.reasoningEffort || 'medium';
      let currentPermissionMode = sessionConfig.permissionMode || 'manual';
      let disposed = false;
      let activeTurn = null;

      const emit = (ev) => {
        for (const fn of [...listeners]) {
          try { fn(ev); } catch {}
        }
      };

      const sessionObj = {
        get nativeSessionId() {
          return nativeSessionId;
        },
        pluginMcpAvailable: false,
        handleServerCrash(reason) {
          if (!activeTurn || activeTurn.settled) return;
          const turn = activeTurn;
          turn.settled = true;
          turn.cleanup?.();
          activeTurn = null;
          emit({
            type: 'turn.failed',
            turnId: turn.turnId,
            code: 'process_exit',
            failureClass: 'process_exit',
            message: sanitizeOpenCodeError(reason, owner.getSecretsForRedaction()),
          });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        async sendTurn(input) {
          if (disposed) throw new Error('OpenCode session has been disposed');
          const activeConn = await owner.ensureConnection();
          const turnSecrets = activeConn.password ? [activeConn.password] : [];
          const model = input.model || currentModel;
          const opts = input.turnOptions && typeof input.turnOptions === 'object' ? input.turnOptions : {};
          const agent = typeof opts.agent === 'string' && opts.agent ? opts.agent : (currentConfig.defaultAgent || 'build');
          const promptText = composeInlinePrompt(input.text, input.contextSync);
          const silentTimeoutMs = currentConfig.silentStreamTimeoutMs || 45_000;
          const subscriptionTimeoutMs = currentConfig.subscriptionTimeoutMs || 10_000;

          const turnState = {
            turnId: input.turnId,
            settled: false,
            stream: null,
            silenceTimer: null,
            assistantAccum: '',
            completedEmitted: false,
            reconciling: false,
            cleanup: null,
          };
          activeTurn = turnState;

          const clearSilenceTimer = () => {
            if (turnState.silenceTimer) {
              clearTimeout(turnState.silenceTimer);
              turnState.silenceTimer = null;
            }
          };

          turnState.cleanup = () => {
            clearSilenceTimer();
            if (turnState.stream) {
              const s = turnState.stream;
              turnState.stream = null;
              void s.close().catch(() => {});
            }
          };

          const settleTerminal = (event) => {
            if (turnState.settled) return;
            turnState.settled = true;
            turnState.cleanup();
            if (activeTurn === turnState) activeTurn = null;
            emit(event);
          };

          const reconcileOnSilence = async () => {
            if (turnState.settled || turnState.reconciling) return;
            turnState.reconciling = true;
            turnState.cleanup();
            emit({
              type: 'diagnostic.log',
              level: 'warn',
              stream: 'protocol',
              message: `OpenCode SSE stream exceeded ${silentTimeoutMs}ms silent threshold; polling terminal state.`,
            });
            try {
              const pollRes = await owner.fetchJson(
                activeConn,
                `/sessions/${encodeURIComponent(nativeSessionId)}/turns/${encodeURIComponent(input.turnId)}`,
                { method: 'GET' },
                Math.min(5_000, currentConfig.connectTimeoutMs || 5_000),
              );
              if (turnState.settled) return;
              if (pollRes.ok) {
                const statusBody = JSON.parse(pollRes.body || '{}');
                if (statusBody.status === 'completed' || statusBody.status === 'succeeded') {
                  if (typeof statusBody.text === 'string' && statusBody.text && !turnState.completedEmitted) {
                    turnState.completedEmitted = true;
                    emit({ type: 'message.assistant.completed', turnId: input.turnId, text: statusBody.text });
                  }
                  if (statusBody.usage) {
                    emit({ type: 'usage.updated', turnId: input.turnId, usage: statusBody.usage });
                  }
                  settleTerminal({
                    type: 'turn.completed',
                    turnId: input.turnId,
                    stopReason: statusBody.stopReason || 'reconciled',
                  });
                  return;
                }
                if (statusBody.status === 'cancelled' || statusBody.status === 'interrupted') {
                  settleTerminal({ type: 'turn.cancelled', turnId: input.turnId });
                  return;
                }
                if (statusBody.status === 'failed') {
                  settleTerminal({
                    type: 'turn.failed',
                    turnId: input.turnId,
                    code: statusBody.code || 'provider_error',
                    failureClass: statusBody.failureClass || 'provider_error',
                    message: sanitizeOpenCodeError(statusBody.message || 'OpenCode turn failed', turnSecrets),
                  });
                  return;
                }
              }
            } catch {
              // Fall through to silent_stream failure below
            }
            settleTerminal({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'silent_stream',
              failureClass: 'silent_stream',
              message: `OpenCode SSE stream went silent after ${silentTimeoutMs}ms.`,
            });
          };

          const armSilenceTimer = () => {
            clearSilenceTimer();
            if (turnState.settled || turnState.reconciling) return;
            turnState.silenceTimer = setTimeout(() => {
              void reconcileOnSilence();
            }, silentTimeoutMs);
          };

          // ── Step 1: Subscribe to volatile SSE stream FIRST (Subscribe-Before-POST) ──
          let stream;
          try {
            stream = await ctx.net.openStream(
              `${activeConn.baseUrl}/events?sessionID=${encodeURIComponent(nativeSessionId)}`,
              {
                method: 'GET',
                headers: {
                  Accept: 'text/event-stream',
                  ...(activeConn.authHeader ? { Authorization: activeConn.authHeader } : {}),
                },
                connectTimeoutMs: subscriptionTimeoutMs,
              },
            );
          } catch (err) {
            const safeMsg = sanitizeOpenCodeError(err, turnSecrets);
            emit({ type: 'turn.started', turnId: input.turnId });
            settleTerminal({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'server_unreachable',
              failureClass: 'server_unreachable',
              message: safeMsg,
            });
            return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
          }

          turnState.stream = stream;

          if (stream.status === 401 || stream.status === 403) {
            emit({ type: 'turn.started', turnId: input.turnId });
            settleTerminal({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'auth_failed',
              failureClass: 'auth_failed',
              message: 'The OpenCode server rejected the server password.',
            });
            return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
          }
          if (!stream.ok) {
            emit({ type: 'turn.started', turnId: input.turnId });
            settleTerminal({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'server_unreachable',
              failureClass: 'server_unreachable',
              message: sanitizeOpenCodeError(`OpenCode event stream failed (HTTP ${stream.status})`, turnSecrets),
            });
            return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
          }

          const sseParser = createOpenCodeSseStreamParser((parsed) => {
            if (turnState.settled) return;
            // Strict sessionID routing filter: prevents cross-workspace bleed on shared local server
            if (parsed.sessionID && parsed.sessionID !== nativeSessionId) return;

            if (parsed.kind === 'unreadable.execution.ended') {
              emit({
                type: 'diagnostic.log',
                level: 'warn',
                stream: 'protocol',
                message: `OpenCode emitted unreadable terminal frame (${parsed.originalType}); synthesizing terminal settlement.`,
              });
              if (parsed.inferredStatus === 'failed') {
                settleTerminal({
                  type: 'turn.failed',
                  turnId: input.turnId,
                  code: 'provider_error',
                  failureClass: 'provider_error',
                  message: `Turn ended with unreadable failure event (${parsed.originalType}).`,
                });
              } else if (parsed.inferredStatus === 'cancelled') {
                settleTerminal({ type: 'turn.cancelled', turnId: input.turnId });
              } else {
                if (!turnState.completedEmitted && turnState.assistantAccum) {
                  turnState.completedEmitted = true;
                  emit({ type: 'message.assistant.completed', turnId: input.turnId, text: turnState.assistantAccum });
                }
                settleTerminal({
                  type: 'turn.completed',
                  turnId: input.turnId,
                  stopReason: 'unreadable.execution.ended',
                });
              }
              return;
            }

            if (parsed.kind === 'unknown_ignored') {
              if (parsed.type) {
                emit({
                  type: 'diagnostic.log',
                  level: 'info',
                  stream: 'protocol',
                  message: `Ignored forward-compatible OpenCode event: ${parsed.type}`,
                });
              }
              return;
            }

            const data = parsed.data || {};
            switch (parsed.type) {
              case 'heartbeat':
                break;
              case 'message.delta': {
                const delta = String(data.text ?? data.delta ?? '');
                if (delta) {
                  turnState.assistantAccum += delta;
                  emit({
                    type: 'message.assistant.delta',
                    turnId: input.turnId,
                    text: delta,
                    ...(data.messageId ? { messageId: String(data.messageId) } : {}),
                  });
                }
                break;
              }
              case 'message.completed':
                turnState.completedEmitted = true;
                emit({
                  type: 'message.assistant.completed',
                  turnId: input.turnId,
                  text: String(data.text ?? turnState.assistantAccum),
                  ...(data.messageId ? { messageId: String(data.messageId) } : {}),
                });
                break;
              case 'reasoning.delta':
                emit({
                  type: 'thinking.delta',
                  turnId: input.turnId,
                  text: String(data.text ?? data.delta ?? ''),
                });
                break;
              case 'reasoning.completed':
                emit({
                  type: 'thinking.completed',
                  turnId: input.turnId,
                  text: String(data.text ?? ''),
                });
                break;
              case 'tool.call.started':
                emit({
                  type: 'tool.call.started',
                  turnId: input.turnId,
                  toolCallId: String(data.toolCallId || `oc_tool_${input.turnId}`),
                  toolName: String(data.toolName || 'tool'),
                  toolKind: data.toolKind || 'other',
                  summary: String(data.summary || data.toolName || 'OpenCode tool'),
                  input: data.input,
                });
                break;
              case 'tool.call.delta':
                emit({
                  type: 'tool.call.delta',
                  turnId: input.turnId,
                  toolCallId: String(data.toolCallId || ''),
                  outputDelta: String(data.outputDelta ?? ''),
                  diffDelta: data.diffDelta,
                });
                break;
              case 'tool.call.completed':
                emit({
                  type: 'tool.call.completed',
                  turnId: input.turnId,
                  toolCallId: String(data.toolCallId || ''),
                  toolName: String(data.toolName || 'tool'),
                  status: data.status || 'success',
                  output: data.output,
                  diff: data.diff,
                });
                break;
              case 'shell.job.output':
                emit({
                  type: 'command.output.delta',
                  turnId: input.turnId,
                  toolCallId: String(data.toolCallId || data.jobId || 'shell_job'),
                  chunk: String(data.chunk ?? ''),
                  stream: data.stream === 'stderr' ? 'stderr' : 'stdout',
                });
                break;
              case 'image.job.updated': {
                const imgCheck = validateImageJobPayload(data);
                if (!imgCheck.ok) {
                  emit({
                    type: 'diagnostic.log',
                    level: 'warn',
                    stream: 'protocol',
                    message: imgCheck.reason,
                  });
                  emit({
                    type: 'turn_block.ext',
                    turnId: input.turnId,
                    itemId: String(data.jobId || `oc_img_${input.turnId}`),
                    blockType: 'ext:opencode.image_job',
                    title: String(data.title || 'OpenCode 图像生成（已拦截）'),
                    fallbackSummary: imgCheck.reason,
                    status: 'failed',
                    payload: { rejected: true, reason: imgCheck.reason },
                  });
                } else {
                  emit({
                    type: 'turn_block.ext',
                    turnId: input.turnId,
                    itemId: String(data.jobId || `oc_img_${input.turnId}`),
                    blockType: 'ext:opencode.image_job',
                    title: String(data.title || 'OpenCode 图像生成作业'),
                    fallbackSummary: `Image ${imgCheck.mimeType}${data.prompt ? ` · ${String(data.prompt).slice(0, 80)}` : ''}`,
                    status: data.status || 'completed',
                    payload: {
                      jobId: data.jobId,
                      prompt: data.prompt,
                      mimeType: imgCheck.mimeType,
                      fileName: data.fileName,
                      sizeBytes: imgCheck.sizeBytes,
                      dataUri: data.dataUri,
                      previewUrl: data.previewUrl,
                    },
                  });
                }
                break;
              }
              case 'permission.requested':
                emit({
                  type: 'approval.requested',
                  turnId: input.turnId,
                  nativeRequestId: String(data.nativeRequestId || data.requestId || ''),
                  toolName: String(data.toolName || 'shell'),
                  toolKind: data.toolKind || 'shell',
                  summary: String(data.summary || 'OpenCode permission requested'),
                  input: data.input ?? {},
                  diffPreview: data.diffPreview,
                  riskLevel: data.riskLevel || 'medium',
                });
                break;
              case 'usage.updated':
                emit({
                  type: 'usage.updated',
                  turnId: input.turnId,
                  usage: {
                    inputTokens: Number(data.inputTokens ?? 0) || 0,
                    outputTokens: Number(data.outputTokens ?? 0) || 0,
                    ...(data.cachedTokens !== undefined ? { cachedTokens: Number(data.cachedTokens) } : {}),
                    ...(data.modelContextWindow !== undefined ? { modelContextWindow: Number(data.modelContextWindow) } : {}),
                    ...(data.costUsd !== undefined ? { costUsd: Number(data.costUsd) } : {}),
                  },
                });
                break;
              case 'session.execution.succeeded':
                if (!turnState.completedEmitted && turnState.assistantAccum) {
                  turnState.completedEmitted = true;
                  emit({ type: 'message.assistant.completed', turnId: input.turnId, text: turnState.assistantAccum });
                }
                settleTerminal({
                  type: 'turn.completed',
                  turnId: input.turnId,
                  stopReason: typeof data.stopReason === 'string' ? data.stopReason : 'end_turn',
                });
                break;
              case 'session.execution.failed':
                settleTerminal({
                  type: 'turn.failed',
                  turnId: input.turnId,
                  code: data.code ? String(data.code) : 'provider_error',
                  failureClass: data.failureClass ? String(data.failureClass) : undefined,
                  resetAt: data.resetAt ?? null,
                  message: sanitizeOpenCodeError(data.message || 'OpenCode execution failed', turnSecrets),
                });
                break;
              case 'session.execution.interrupted':
                settleTerminal({ type: 'turn.cancelled', turnId: input.turnId });
                break;
              default:
                break;
            }
          });

          stream.onChunk((chunk) => {
            armSilenceTimer();
            sseParser.push(chunk);
          });

          stream.onEnd(() => {
            sseParser.end();
            if (!turnState.settled && !turnState.reconciling) {
              void reconcileOnSilence();
            }
          });

          stream.onError((msg) => {
            if (!turnState.settled && !turnState.reconciling) {
              settleTerminal({
                type: 'turn.failed',
                turnId: input.turnId,
                code: 'server_unreachable',
                failureClass: 'server_unreachable',
                message: sanitizeOpenCodeError(msg, turnSecrets),
              });
            }
          });

          emit({ type: 'turn.started', turnId: input.turnId });
          armSilenceTimer();

          // ── Step 2: ONLY AFTER SSE stream subscription is open, POST the turn ──
          try {
            const postRes = await owner.fetchJson(
              activeConn,
              `/sessions/${encodeURIComponent(nativeSessionId)}/turns`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  turnId: input.turnId,
                  directory: sessionConfig.cwd,
                  prompt: promptText,
                  model,
                  agent,
                  reasoningEffort: input.reasoningEffort ?? currentEffort,
                  permissionMode: input.permissionMode ?? currentPermissionMode,
                }),
              },
              Math.max(10_000, currentConfig.connectTimeoutMs || 5_000),
            );
            if (postRes.status === 401 || postRes.status === 403) {
              settleTerminal({
                type: 'turn.failed',
                turnId: input.turnId,
                code: 'auth_failed',
                failureClass: 'auth_failed',
                message: 'The OpenCode server rejected the server password.',
              });
            } else if (!postRes.ok) {
              settleTerminal({
                type: 'turn.failed',
                turnId: input.turnId,
                code: 'provider_error',
                failureClass: 'provider_error',
                message: sanitizeOpenCodeError(`OpenCode POST turn failed (HTTP ${postRes.status})`, turnSecrets),
              });
            }
          } catch (err) {
            settleTerminal({
              type: 'turn.failed',
              turnId: input.turnId,
              code: 'server_unreachable',
              failureClass: 'server_unreachable',
              message: sanitizeOpenCodeError(err, turnSecrets),
            });
          }

          return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
        },
        async interrupt() {
          const turn = activeTurn;
          if (!turn || turn.settled) return;
          turn.settled = true;
          turn.cleanup?.();
          activeTurn = null;
          try {
            const conn = await owner.ensureConnection();
            await owner.fetchJson(
              conn,
              `/sessions/${encodeURIComponent(nativeSessionId)}/interrupt`,
              { method: 'POST' },
              3_000,
            );
          } catch {
            // Local SSE closure already converges cleanly
          }
          emit({ type: 'turn.cancelled', turnId: turn.turnId });
        },
        async resolveApproval(nativeRequestId, decision, comment) {
          const conn = await owner.ensureConnection();
          await owner.fetchJson(
            conn,
            `/sessions/${encodeURIComponent(nativeSessionId)}/permissions/${encodeURIComponent(nativeRequestId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision, comment }),
            },
            5_000,
          );
        },
        async updateConfig(patch) {
          if (patch.model !== undefined && patch.model) currentModel = patch.model;
          if (patch.reasoningEffort !== undefined && patch.reasoningEffort) currentEffort = patch.reasoningEffort;
          if (patch.permissionMode !== undefined) currentPermissionMode = patch.permissionMode;
        },
        async dispose() {
          disposed = true;
          activeSessionHandles.delete(sessionObj);
          if (activeTurn) {
            activeTurn.settled = true;
            activeTurn.cleanup?.();
            activeTurn = null;
          }
          listeners.clear();
        },
      };

      activeSessionHandles.add(sessionObj);
      return sessionObj;
    },
  });

  ctx.slots.register({
    slot: 'harness.settings',
    id: 'opencode-settings',
    title: 'OpenCode 服务与模式设置',
    ui: 'ui/settings.html',
    key: 'opencode',
    order: 100,
    height: 380,
    async onMessage(payload) {
      const msg = payload && typeof payload === 'object' ? payload : {};
      if (msg.action === 'getConfig') {
        return {
          config: currentConfig,
          serverStatus: owner.getStatusSnapshot(),
        };
      }
      if (msg.action === 'saveConfig') {
        const nextCfg = normalizeOpenCodeConfig({ ...currentConfig, ...(msg.config || {}) });
        currentConfig = nextCfg;
        await ctx.storage.plugin.set('config', currentConfig);
        await owner.forget();
        return {
          ok: true,
          config: currentConfig,
          serverStatus: owner.getStatusSnapshot(),
        };
      }
      if (msg.action === 'testConnection') {
        return await probePassiveOrActive(true);
      }
      return { ok: false, error: 'Unsupported action' };
    },
  });

  ctx.slots.register({
    slot: 'chat.block',
    id: 'opencode-image-job',
    title: 'OpenCode 图像生成作业',
    ui: 'ui/image-job-card.html',
    key: 'ext:opencode.image_job',
    order: 100,
    height: 220,
  });
}
