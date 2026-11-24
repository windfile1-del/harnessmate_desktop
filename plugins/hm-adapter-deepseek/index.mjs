import { randomUUID } from 'node:crypto';
import {
  DEEPSEEK_CAPABILITIES,
  DEEPSEEK_CAPABILITIES_V2,
  DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
  DEEPSEEK_DRIVER_ID,
  DEEPSEEK_MODELS,
  DEEPSEEK_PRESENTATION,
  buildReasoningBudgetBlock,
  classifyDeepSeekHttpError,
  composeInlinePrompt,
  createSseParser,
  normalizeDeepSeekConfig,
  scrubSecrets,
} from './lib/protocol.mjs';

export const name = 'hm-adapter-deepseek';
export const requires = ['harness.driver.v2', 'runtime.spawnCli', 'ui.slots.v5'];

const DELTA_COALESCE_MS = 50;

export async function apply(ctx, initialConfig) {
  const stored = await ctx.storage.plugin.get('config').catch(() => null);
  let currentConfig = normalizeDeepSeekConfig({
    ...(initialConfig && typeof initialConfig === 'object' ? initialConfig : {}),
    ...(stored && typeof stored === 'object' ? stored : {}),
  });

  if (typeof ctx.onConfigUpdated === 'function') {
    ctx.onConfigUpdated((nextCfg) => {
      currentConfig = normalizeDeepSeekConfig({ ...currentConfig, ...(nextCfg || {}) });
    });
  }

  async function resolveApiKey() {
    const ref = currentConfig.apiKeyRef?.secretRef;
    if (!ref) return null;
    try {
      return await ctx.secrets.resolve(ref);
    } catch {
      return null;
    }
  }

  async function runPassiveProbe() {
    const cachedModels = await ctx.storage.plugin.get('modelsCache').catch(() => null);
    const models = Array.isArray(cachedModels) && cachedModels.length > 0 ? cachedModels : DEEPSEEK_MODELS;
    return {
      binaryPath: currentConfig.mode === 'cli' ? currentConfig.cliCommand : null,
      version: currentConfig.mode === 'cli' ? 'cli' : 'api-v1',
      health: 'ready',
      accountSummary: currentConfig.mode === 'cli'
        ? `CLI: ${currentConfig.cliCommand}`
        : `API: ${currentConfig.apiBaseUrl}`,
      models,
      defaultModelId: currentConfig.defaultModel,
      capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
      presentation: DEEPSEEK_PRESENTATION,
    };
  }

  async function runActiveProbe() {
    if (currentConfig.mode === 'cli') {
      try {
        const proc = await ctx.runtime.spawnCli({
          command: currentConfig.cliCommand,
          args: ['--version'],
          timeoutMs: 4_000,
        });
        let out = '';
        proc.onStdout((chunk) => { out += chunk; });
        proc.onStderr((chunk) => { out += chunk; });
        const exit = await proc.wait();
        const versionLine = out.trim().split(/\r?\n/)[0] || 'deepseek-cli';
        if (exit.code !== 0) {
          return {
            binaryPath: currentConfig.cliCommand,
            version: null,
            health: 'unavailable',
            healthMessage: versionLine || `CLI exited with code ${exit.code}`,
            models: DEEPSEEK_MODELS,
            defaultModelId: currentConfig.defaultModel,
            capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
            presentation: DEEPSEEK_PRESENTATION,
          };
        }
        return {
          binaryPath: currentConfig.cliCommand,
          version: versionLine,
          health: 'ready',
          accountSummary: `CLI (${versionLine})`,
          models: DEEPSEEK_MODELS,
          defaultModelId: currentConfig.defaultModel,
          capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
          presentation: DEEPSEEK_PRESENTATION,
        };
      } catch (err) {
        return {
          binaryPath: null,
          version: null,
          health: 'unavailable',
          healthMessage: err instanceof Error ? err.message : String(err),
          models: DEEPSEEK_MODELS,
          defaultModelId: currentConfig.defaultModel,
          capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
          presentation: DEEPSEEK_PRESENTATION,
        };
      }
    }

    const apiKey = await resolveApiKey();
    try {
      const res = await ctx.net.fetch(`${currentConfig.apiBaseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        timeoutMs: 5_000,
      });
      if (res.status === 401 || res.status === 403) {
        return {
          binaryPath: null,
          version: 'api-v1',
          health: 'unauthenticated',
          healthMessage: 'DeepSeek API authentication failed.',
          models: DEEPSEEK_MODELS,
          defaultModelId: currentConfig.defaultModel,
          capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
          presentation: DEEPSEEK_PRESENTATION,
        };
      }
      if (!res.ok) {
        return {
          binaryPath: null,
          version: 'api-v1',
          health: 'degraded',
          healthMessage: scrubSecrets(`HTTP ${res.status} from ${currentConfig.apiBaseUrl}`, apiKey ? [apiKey] : []),
          models: DEEPSEEK_MODELS,
          defaultModelId: currentConfig.defaultModel,
          capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
          presentation: DEEPSEEK_PRESENTATION,
        };
      }
      let models = DEEPSEEK_MODELS;
      try {
        const parsed = JSON.parse(res.body);
        if (Array.isArray(parsed?.data) && parsed.data.length > 0) {
          models = parsed.data.map((m) => {
            const id = String(m.id || m.name || '');
            const existing = DEEPSEEK_MODELS.find((d) => d.id === id);
            return existing ?? {
              id,
              displayName: String(m.displayName || id),
              group: 'DeepSeek',
              inputModalities: ['text'],
            };
          });
          await ctx.storage.plugin.set('modelsCache', models).catch(() => {});
        }
      } catch {
        // Keep default model catalog if /v1/models payload is minimal
      }
      return {
        binaryPath: null,
        version: 'api-v1',
        health: 'ready',
        accountSummary: apiKey ? 'API Key configured' : `Gateway (${currentConfig.apiBaseUrl})`,
        models,
        defaultModelId: currentConfig.defaultModel,
        capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
        presentation: DEEPSEEK_PRESENTATION,
      };
    } catch (err) {
      return {
        binaryPath: null,
        version: null,
        health: 'unavailable',
        healthMessage: scrubSecrets(err instanceof Error ? err.message : String(err), apiKey ? [apiKey] : []),
        models: DEEPSEEK_MODELS,
        defaultModelId: currentConfig.defaultModel,
        capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
        presentation: DEEPSEEK_PRESENTATION,
      };
    }
  }

  ctx.harnesses.registerDriver({
    driverId: DEEPSEEK_DRIVER_ID,
    displayName: 'DeepSeek',
    description: 'DeepSeek CLI & HTTP-SSE Reasoner/Chat Adapter',
    protocolLabel: 'deepseek-hybrid',
    capabilities: DEEPSEEK_CAPABILITIES,
    capabilitiesV2: DEEPSEEK_CAPABILITIES_V2,
    presentation: DEEPSEEK_PRESENTATION,
    probePassive: runPassiveProbe,
    probe: runActiveProbe,
    createSession(sessionConfig) {
      const listeners = new Set();
      let nativeSessionId = sessionConfig.nativeSessionId ?? null;
      let currentModel = sessionConfig.model || currentConfig.defaultModel || 'deepseek-reasoner';
      let currentEffort = sessionConfig.reasoningEffort || 'medium';
      let currentPermissionMode = sessionConfig.permissionMode || 'manual';
      let disposed = false;

      let cliProc = null;
      let cliStdoutBuf = '';
      let activeTurn = null;
      const apiMessages = [];

      const emit = (event) => {
        for (const fn of [...listeners]) {
          try { fn(event); } catch {}
        }
      };

      const flushDeltas = (turnState) => {
        if (!turnState) return;
        if (turnState.flushTimer) {
          clearTimeout(turnState.flushTimer);
          turnState.flushTimer = null;
        }
        if (turnState.pendingThinking) {
          const text = turnState.pendingThinking;
          turnState.pendingThinking = '';
          emit({ type: 'thinking.delta', turnId: turnState.turnId, text });
        }
        if (turnState.pendingAssistant) {
          const text = turnState.pendingAssistant;
          turnState.pendingAssistant = '';
          emit({ type: 'message.assistant.delta', turnId: turnState.turnId, text });
        }
      };

      const queueDelta = (turnState, kind, chunk) => {
        if (!chunk || !turnState || turnState.settled) return;
        if (kind === 'thinking') {
          turnState.thinkingAccum += chunk;
          turnState.pendingThinking += chunk;
        } else {
          turnState.assistantAccum += chunk;
          turnState.pendingAssistant += chunk;
        }
        if (!turnState.flushTimer) {
          turnState.flushTimer = setTimeout(() => flushDeltas(turnState), DELTA_COALESCE_MS);
        }
      };

      const emitReasoningBudgetIfNeeded = (turnState, usage) => {
        if (!turnState || turnState.budgetBlockEmitted) return;
        turnState.budgetBlockEmitted = true;
        const reasoningTokens =
          usage?.reasoningTokens ??
          Math.max(0, Math.ceil(turnState.thinkingAccum.length / 4));
        const outputTokens =
          usage?.outputTokens ??
          Math.max(0, Math.ceil(turnState.assistantAccum.length / 4));
        emit(
          buildReasoningBudgetBlock({
            turnId: turnState.turnId,
            model: turnState.model,
            reasoningBudget: turnState.reasoningBudget,
            deepThink: turnState.deepThink,
            reasoningTokens,
            outputTokens,
            status: 'completed',
          }),
        );
      };

      async function ensureCliProcess() {
        if (cliProc) return cliProc;
        const apiKey = await resolveApiKey();
        const spawned = await ctx.runtime.spawnCli({
          command: currentConfig.cliCommand,
          args: ['--stdio-json'],
          cwd: sessionConfig.cwd,
          extraEnv: {
            ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
            ...(currentConfig.apiBaseUrl ? { DEEPSEEK_API_BASE: currentConfig.apiBaseUrl } : {}),
          },
        });
        cliProc = spawned;
        cliStdoutBuf = '';

        spawned.onStdout((chunk) => {
          cliStdoutBuf += chunk;
          while (true) {
            const nl = cliStdoutBuf.indexOf('\n');
            if (nl < 0) break;
            const line = cliStdoutBuf.slice(0, nl).trim();
            cliStdoutBuf = cliStdoutBuf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            handleCliFrame(msg);
          }
        });

        spawned.onStderr((chunk) => {
          const safeMsg = scrubSecrets(chunk.trim(), apiKey ? [apiKey] : []);
          if (safeMsg) {
            emit({ type: 'diagnostic.log', level: 'warn', stream: 'stderr', message: safeMsg.slice(0, 500) });
          }
        });

        spawned.onExit((info) => {
          if (cliProc === spawned) cliProc = null;
          if (activeTurn && activeTurn.mode === 'cli' && !activeTurn.settled) {
            const turn = activeTurn;
            turn.settled = true;
            flushDeltas(turn);
            activeTurn = null;
            emit({
              type: 'turn.failed',
              turnId: turn.turnId,
              code: 'process_exit',
              failureClass: 'process_exit',
              message: `DeepSeek CLI exited unexpectedly (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`,
            });
          }
        });

        return spawned;
      }

      function handleCliFrame(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'native_session_ready' && typeof msg.nativeSessionId === 'string') {
          nativeSessionId = msg.nativeSessionId;
          emit({ type: 'native_session_ready', nativeSessionId });
          return;
        }
        const turn = activeTurn;
        if (!turn || turn.settled) return;

        switch (msg.type) {
          case 'model.confirmed':
            emit({
              type: 'model.confirmed',
              actualModel: String(msg.actualModel || turn.model),
              reroutedFrom: msg.reroutedFrom,
              reason: msg.reason,
            });
            break;
          case 'thinking.delta':
            queueDelta(turn, 'thinking', String(msg.text ?? ''));
            break;
          case 'thinking.completed':
            flushDeltas(turn);
            emit({ type: 'thinking.completed', turnId: turn.turnId, text: String(msg.text ?? turn.thinkingAccum) });
            break;
          case 'message.assistant.delta':
            queueDelta(turn, 'assistant', String(msg.text ?? ''));
            break;
          case 'message.assistant.completed':
            flushDeltas(turn);
            emit({
              type: 'message.assistant.completed',
              turnId: turn.turnId,
              text: String(msg.text ?? turn.assistantAccum),
            });
            break;
          case 'tool.call.started':
            flushDeltas(turn);
            emit({
              type: 'tool.call.started',
              turnId: turn.turnId,
              toolCallId: String(msg.toolCallId || `ds_tool_${randomUUID().slice(0, 6)}`),
              toolName: String(msg.toolName || 'tool'),
              toolKind: msg.toolKind || 'other',
              summary: String(msg.summary || msg.toolName || 'Tool call'),
              input: msg.input,
            });
            break;
          case 'tool.call.delta':
            emit({
              type: 'tool.call.delta',
              turnId: turn.turnId,
              toolCallId: String(msg.toolCallId),
              outputDelta: String(msg.outputDelta ?? ''),
              diffDelta: msg.diffDelta,
            });
            break;
          case 'tool.call.completed':
            emit({
              type: 'tool.call.completed',
              turnId: turn.turnId,
              toolCallId: String(msg.toolCallId),
              toolName: String(msg.toolName || 'tool'),
              status: msg.status || 'success',
              output: msg.output,
              diff: msg.diff,
            });
            break;
          case 'command.output.delta':
            emit({
              type: 'command.output.delta',
              turnId: turn.turnId,
              toolCallId: String(msg.toolCallId),
              chunk: String(msg.chunk ?? ''),
              stream: msg.stream || 'stdout',
            });
            break;
          case 'approval.requested':
            flushDeltas(turn);
            emit({
              type: 'approval.requested',
              turnId: turn.turnId,
              nativeRequestId: String(msg.nativeRequestId || `ds_req_${randomUUID().slice(0, 6)}`),
              toolName: String(msg.toolName || 'bash'),
              toolKind: msg.toolKind || 'shell',
              summary: String(msg.summary || 'Action requires approval'),
              input: msg.input ?? {},
              diffPreview: msg.diffPreview,
              riskLevel: msg.riskLevel || 'medium',
            });
            break;
          case 'turn_block.ext':
            if (msg.blockType === 'ext:deepseek.reasoning_budget') {
              turn.budgetBlockEmitted = true;
            }
            emit({
              type: 'turn_block.ext',
              turnId: turn.turnId,
              itemId: String(msg.itemId || `deepseek:ext:${turn.turnId}`),
              blockType: String(msg.blockType || 'ext:deepseek.custom'),
              title: String(msg.title || 'DeepSeek Block'),
              fallbackSummary: String(msg.fallbackSummary || ''),
              status: msg.status || 'completed',
              payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
            });
            break;
          case 'usage.updated': {
            const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
            const inputTokens = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
            const outputTokens = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
            const reasoningTokens = Number(u.reasoningTokens ?? u.reasoning_tokens ?? 0) || undefined;
            const cachedTokens = u.cachedTokens !== undefined ? Number(u.cachedTokens) : undefined;
            turn.lastUsage = { inputTokens, outputTokens, reasoningTokens, cachedTokens };
            emit({
              type: 'usage.updated',
              turnId: turn.turnId,
              usage: {
                inputTokens,
                outputTokens,
                ...(cachedTokens !== undefined ? { cachedTokens } : {}),
                ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
                modelContextWindow: Number(u.modelContextWindow) || currentConfig.contextWindowTokens || DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
                ...(u.costUsd !== undefined ? { costUsd: Number(u.costUsd) } : {}),
              },
            });
            break;
          }
          case 'turn.completed':
            turn.settled = true;
            flushDeltas(turn);
            emitReasoningBudgetIfNeeded(turn, turn.lastUsage);
            if (activeTurn === turn) activeTurn = null;
            emit({ type: 'turn.completed', turnId: turn.turnId, stopReason: msg.stopReason || 'end_turn' });
            break;
          case 'turn.failed':
            turn.settled = true;
            flushDeltas(turn);
            if (activeTurn === turn) activeTurn = null;
            emit({
              type: 'turn.failed',
              turnId: turn.turnId,
              code: msg.code,
              failureClass: msg.failureClass,
              resetAt: msg.resetAt ?? null,
              message: String(msg.message || 'DeepSeek CLI turn failed'),
            });
            break;
          case 'turn.cancelled':
            turn.settled = true;
            flushDeltas(turn);
            if (activeTurn === turn) activeTurn = null;
            emit({ type: 'turn.cancelled', turnId: turn.turnId });
            break;
          default:
            break;
        }
      }

      async function runApiTurn(turnState, promptText) {
        const apiKey = await resolveApiKey();
        const secrets = apiKey ? [apiKey] : [];
        let stream;
        try {
          apiMessages.push({ role: 'user', content: promptText });
          stream = await ctx.net.openStream(`${currentConfig.apiBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: turnState.model,
              stream: true,
              stream_options: { include_usage: true },
              messages: apiMessages,
              reasoning_budget: turnState.reasoningBudget,
              deep_think: turnState.deepThink,
            }),
            connectTimeoutMs: 15_000,
          });
          turnState.streamHandle = stream;

          if (turnState.settled) {
            await stream.close().catch(() => {});
            return;
          }

          if (!stream.ok) {
            let errBody = '';
            await new Promise((resolve) => {
              stream.onChunk((chunk) => {
                if (errBody.length < 8_192) errBody += chunk;
              });
              stream.onEnd(resolve);
              stream.onError(resolve);
            });
            await stream.close().catch(() => {});
            if (turnState.settled) return;
            turnState.settled = true;
            if (activeTurn === turnState) activeTurn = null;
            const classified = classifyDeepSeekHttpError(stream.status, stream.headers, errBody, secrets);
            emit({
              type: 'turn.failed',
              turnId: turnState.turnId,
              code: classified.code,
              failureClass: classified.failureClass,
              resetAt: classified.resetAt,
              message: classified.message,
            });
            return;
          }

          let streamDone = false;
          let streamUsage = null;

          const parser = createSseParser((frame) => {
            if (turnState.settled) return;
            if (frame.done) {
              streamDone = true;
              return;
            }
            const data = frame.data;
            if (!data || typeof data !== 'object') return;
            if (typeof data.model === 'string' && data.model && !turnState.modelConfirmed) {
              turnState.modelConfirmed = true;
              emit({ type: 'model.confirmed', actualModel: data.model });
            }
            const choice = Array.isArray(data.choices) ? data.choices[0] : null;
            const delta = choice?.delta;
            if (delta && typeof delta === 'object') {
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                queueDelta(turnState, 'thinking', delta.reasoning_content);
              }
              if (typeof delta.content === 'string' && delta.content) {
                queueDelta(turnState, 'assistant', delta.content);
              }
            }
            if (data.usage && typeof data.usage === 'object') {
              const u = data.usage;
              const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
              const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
              const reasoningTokens =
                u.completion_tokens_details?.reasoning_tokens !== undefined
                  ? Number(u.completion_tokens_details.reasoning_tokens)
                  : (u.reasoning_tokens !== undefined ? Number(u.reasoning_tokens) : undefined);
              const cachedTokens =
                u.prompt_cache_hit_tokens !== undefined
                  ? Number(u.prompt_cache_hit_tokens)
                  : (u.prompt_tokens_details?.cached_tokens !== undefined ? Number(u.prompt_tokens_details.cached_tokens) : undefined);
              streamUsage = { inputTokens, outputTokens, reasoningTokens, cachedTokens };
            }
            if (choice?.finish_reason) {
              streamDone = true;
            }
          });

          await new Promise((resolve) => {
            let resolved = false;
            const finish = (errMsg) => {
              if (resolved) return;
              resolved = true;
              parser.end();
              resolve(errMsg || null);
            };
            stream.onChunk((chunk) => {
              parser.push(chunk);
              if (streamDone) finish(null);
            });
            stream.onEnd(() => finish(null));
            stream.onError((msg) => finish(msg || 'SSE stream interrupted'));
          }).then(async (errMsg) => {
            await stream.close().catch(() => {});
            if (turnState.settled) return;
            if (errMsg && !streamDone) {
              turnState.settled = true;
              flushDeltas(turnState);
              if (activeTurn === turnState) activeTurn = null;
              emit({
                type: 'turn.failed',
                turnId: turnState.turnId,
                code: 'provider_unavailable',
                failureClass: 'provider_unavailable',
                message: scrubSecrets(errMsg, secrets),
              });
              return;
            }
            turnState.settled = true;
            flushDeltas(turnState);
            if (activeTurn === turnState) activeTurn = null;
            if (turnState.thinkingAccum) {
              emit({ type: 'thinking.completed', turnId: turnState.turnId, text: turnState.thinkingAccum });
            }
            if (turnState.assistantAccum) {
              apiMessages.push({ role: 'assistant', content: turnState.assistantAccum });
            }
            emit({ type: 'message.assistant.completed', turnId: turnState.turnId, text: turnState.assistantAccum });
            emitReasoningBudgetIfNeeded(turnState, streamUsage);
            const inputTokens = streamUsage?.inputTokens ?? Math.ceil(promptText.length / 4);
            const outputTokens = streamUsage?.outputTokens ?? Math.ceil(turnState.assistantAccum.length / 4);
            const reasoningTokens =
              streamUsage?.reasoningTokens ?? Math.ceil(turnState.thinkingAccum.length / 4);
            emit({
              type: 'usage.updated',
              turnId: turnState.turnId,
              usage: {
                inputTokens,
                outputTokens,
                ...(streamUsage?.cachedTokens !== undefined ? { cachedTokens: streamUsage.cachedTokens } : {}),
                ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
                modelContextWindow: currentConfig.contextWindowTokens || DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
              },
            });
            emit({ type: 'turn.completed', turnId: turnState.turnId, stopReason: 'end_turn' });
          });
        } catch (err) {
          if (stream) await stream.close().catch(() => {});
          if (turnState.settled) return;
          turnState.settled = true;
          flushDeltas(turnState);
          if (activeTurn === turnState) activeTurn = null;
          emit({
            type: 'turn.failed',
            turnId: turnState.turnId,
            code: 'provider_unavailable',
            failureClass: 'provider_unavailable',
            message: scrubSecrets(err instanceof Error ? err.message : String(err), secrets),
          });
        }
      }

      return {
        get nativeSessionId() {
          return nativeSessionId;
        },
        pluginMcpAvailable: false,
        onEvent(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        async sendTurn(input) {
          if (disposed) throw new PluginApiError('E_STALE_RUN', 'DeepSeek session disposed');
          const model = input.model || currentModel;
          const opts = input.turnOptions && typeof input.turnOptions === 'object' ? input.turnOptions : {};
          const reasoningBudget =
            opts.reasoningBudget === 'low' || opts.reasoningBudget === 'medium' || opts.reasoningBudget === 'high'
              ? opts.reasoningBudget
              : (currentEffort === 'high' ? 'high' : currentEffort === 'low' ? 'low' : 'medium');
          const deepThink =
            opts.deepThink !== undefined ? Boolean(opts.deepThink) : model.includes('reasoner');
          const promptText = composeInlinePrompt(input.text, input.contextSync);

          if (!nativeSessionId && currentConfig.mode === 'api_compatible') {
            nativeSessionId = `deepseek_api_${randomUUID().slice(0, 8)}`;
            emit({ type: 'native_session_ready', nativeSessionId });
          }

          const turnState = {
            turnId: input.turnId,
            mode: currentConfig.mode,
            model,
            reasoningBudget,
            deepThink,
            pendingThinking: '',
            pendingAssistant: '',
            thinkingAccum: '',
            assistantAccum: '',
            flushTimer: null,
            settled: false,
            budgetBlockEmitted: false,
            modelConfirmed: false,
            lastUsage: null,
            streamHandle: null,
          };
          activeTurn = turnState;

          if (currentConfig.mode === 'cli') {
            const proc = await ensureCliProcess();
            emit({ type: 'turn.started', turnId: input.turnId });
            await proc.writeStdin(
              JSON.stringify({
                type: 'user_turn',
                turnId: input.turnId,
                prompt: promptText,
                model,
                reasoningEffort: input.reasoningEffort ?? currentEffort,
                permissionMode: input.permissionMode ?? currentPermissionMode,
                turnOptions: { reasoningBudget, deepThink },
                nativeSessionId,
              }) + '\n',
            );
          } else {
            emit({ type: 'turn.started', turnId: input.turnId });
            void runApiTurn(turnState, promptText);
          }

          return { driverUsed: input.contextSync ? 'prompt_envelope' : undefined };
        },
        async interrupt() {
          const turn = activeTurn;
          if (!turn || turn.settled) return;
          turn.settled = true;
          flushDeltas(turn);
          activeTurn = null;
          if (turn.mode === 'cli' && cliProc) {
            await cliProc.writeStdin(JSON.stringify({ type: 'interrupt', turnId: turn.turnId }) + '\n').catch(() => {});
          } else if (turn.streamHandle) {
            await turn.streamHandle.close().catch(() => {});
          }
          emit({ type: 'turn.cancelled', turnId: turn.turnId });
        },
        async resolveApproval(nativeRequestId, decision, comment) {
          if (cliProc) {
            await cliProc.writeStdin(
              JSON.stringify({ type: 'approval_response', nativeRequestId, decision, comment }) + '\n',
            );
          }
        },
        async updateConfig(patch) {
          if (patch.model !== undefined && patch.model) currentModel = patch.model;
          if (patch.reasoningEffort !== undefined && patch.reasoningEffort) currentEffort = patch.reasoningEffort;
          if (patch.permissionMode !== undefined) currentPermissionMode = patch.permissionMode;
        },
        async dispose() {
          disposed = true;
          if (activeTurn) {
            activeTurn.settled = true;
            if (activeTurn.flushTimer) clearTimeout(activeTurn.flushTimer);
            if (activeTurn.streamHandle) await activeTurn.streamHandle.close().catch(() => {});
            activeTurn = null;
          }
          if (cliProc) {
            const target = cliProc;
            cliProc = null;
            await target.kill('SIGTERM').catch(() => {});
          }
          listeners.clear();
        },
      };
    },
  });

  ctx.slots.register({
    slot: 'chat.block',
    id: 'deepseek-reasoning-budget',
    title: 'DeepSeek 推理预算',
    ui: 'ui/reasoning-card.html',
    key: 'ext:deepseek.reasoning_budget',
    order: 100,
    height: 150,
  });

  ctx.slots.register({
    slot: 'harness.settings',
    id: 'deepseek-settings',
    title: 'DeepSeek 连接与模式',
    ui: 'ui/settings.html',
    key: 'deepseek',
    order: 100,
    height: 340,
    async onMessage(payload) {
      const msg = payload && typeof payload === 'object' ? payload : {};
      if (msg.action === 'getConfig') {
        return { config: currentConfig };
      }
      if (msg.action === 'saveConfig') {
        currentConfig = normalizeDeepSeekConfig({ ...currentConfig, ...(msg.config || {}) });
        await ctx.storage.plugin.set('config', currentConfig);
        return { ok: true, config: currentConfig };
      }
      if (msg.action === 'testConnection') {
        return await runActiveProbe();
      }
      return { ok: false, error: 'Unsupported action' };
    },
  });
}
