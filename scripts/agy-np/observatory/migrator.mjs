import { ProtocolObservatoryRecorder } from './recorder.mjs';
import { validateCaptureRecords } from './schema-validator.mjs';
import { safeLabel, safeMetaToken } from './sanitizer.mjs';

export function detectLegacyFormat(lines) {
  const parsed = lines.map((l) => JSON.parse(l));
  if (parsed.length === 0) return { format: 'empty', parsed };
  const first = parsed[0];
  if (first && typeof first === 'object' && first.schemaVersion === 1 && first.correlation) {
    return { format: 'observatory_v1', parsed };
  }
  if (first && typeof first === 'object' && typeof first.stage === 'string' && first.frame && typeof first.frame === 'object') {
    return { format: 'agy_1_5_14_stage_fixture', parsed };
  }
  if (first && typeof first === 'object' && typeof first.ms === 'number' && typeof first.kind === 'string') {
    return { format: 'np00_probe_acp', parsed };
  }
  if (first && typeof first === 'object' && first.kind === 'synthetic' && typeof first.event === 'string') {
    return { format: 'np00_synthetic_routing', parsed };
  }
  return { format: 'unknown', parsed };
}

/**
 * Migrates legacy NP-00 probe outputs, 0409bc8 synthetic routing outputs, or
 * sanitized agy-1.5.14 stage fixtures into Observatory Capture v1 NDJSON without
 * mutating the source file.
 * Fails closed: returns `records: []` whenever validation fails so invalid/leaking records
 * are never emitted to stdout or files.
 */
export function migrateNdjsonToV1(ndjsonText, options = {}) {
  const lines = String(ndjsonText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let format;
  let parsed;
  try {
    ({ format, parsed } = detectLegacyFormat(lines));
  } catch {
    return {
      format: 'invalid_json',
      valid: false,
      records: [],
      validation: { valid: false, recordCount: 0, errors: ['input: invalid_json'], leakFindings: [] },
    };
  }

  if (format === 'observatory_v1') {
    const validation = validateCaptureRecords(parsed);
    return {
      format,
      valid: validation.valid,
      records: validation.valid ? parsed : [],
      validation,
    };
  }

  if (format === 'empty') {
    return {
      format,
      valid: true,
      records: [],
      validation: { valid: true, recordCount: 0, errors: [], leakFindings: [] },
    };
  }

  const safeCaptureId = options.captureId ? safeMetaToken(options.captureId, 'migrated-capture').value : undefined;
  const safeScenario = options.scenario ? safeMetaToken(options.scenario, 'migrated_scenario').value : undefined;

  if (format === 'np00_probe_acp') {
    const launch = parsed.find((r) => r.kind === 'launch') ?? {};
    const isDedicated = launch.profileSource === 'dedicated_test';
    const recorder = new ProtocolObservatoryRecorder({
      captureId: safeCaptureId ?? 'migrated-np00-probe',
      scenario: safeScenario ?? (launch.protocol === 2 ? 'clean_v2' : 'clean_v1'),
      platform: options.platform ?? 'win32',
      cliVersion: launch.version ?? null,
      protocol: null,
      accountCategory: isDedicated ? 'dedicated_test_personal' : 'none',
      source: options.source ?? 'live_raw',
      producer: 'migrator',
      salt: options.salt ?? 'np01-migrator-salt',
      provenance: {
        origin: options.origin ?? 'np00_probe_acp_ndjson',
        migratedFrom: 'np00_probe_acp',
        timingSynthetic: false,
        notes: 'Migrated from NP-00 probe-acp.mjs allowlist summary stream',
      },
    });

    for (const item of parsed) {
      const ms = typeof item.ms === 'number' ? item.ms : 0;
      if (item.kind === 'launch') {
        recorder.recordCaptureMeta(
          {
            profileSource: item.profileSource ?? (item.cleanProfile ? 'ephemeral' : 'unknown'),
            mode: 'clean_probe',
            requestedProtocol: item.protocol,
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'cli-catalog') {
        recorder.recordCliCatalog(item, { monotonicMs: ms });
      } else if (item.kind === 'send') {
        recorder.recordOutboundFrame(
          {
            jsonrpc: '2.0',
            id: item.id,
            method: item.method,
            params: item.session ? { sessionId: item.session } : {},
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'initialize') {
        recorder.recordInboundFrame(
          {
            jsonrpc: '2.0',
            id: 1,
            ...(item.error
              ? { error: item.error }
              : {
                  result: {
                    protocolVersion: item.protocol,
                    agentInfo: { name: item.name, version: item.version },
                    authMethods: (item.auth ?? []).map((id) => ({ id })),
                    agentCapabilities: {
                      loadSession: item.loadSession,
                      promptCapabilities: item.prompt,
                      sessionCapabilities: item.sessionCapabilities,
                    },
                  },
                }),
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'session-new') {
        recorder.recordInboundFrame(
          {
            jsonrpc: '2.0',
            id: 2,
            ...(item.error
              ? {
                  error: {
                    code: item.error.code,
                    message: item.error.authenticationRequired ? 'Authentication required' : 'Session error',
                  },
                }
              : {
                  result: {
                    sessionId: item.session,
                    modes: item.modes
                      ? { currentModeId: item.currentMode, availableModes: item.modes.map((id) => ({ id })) }
                      : undefined,
                  },
                }),
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'update') {
        recorder.recordInboundFrame(
          {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: item.session,
              update: {
                sessionUpdate: item.type,
                status: item.status,
                toolCallId: item.tool,
                ...(item.child ? { childSessionId: item.child } : {}),
              },
            },
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'server-request') {
        recorder.recordInboundFrame(
          {
            jsonrpc: '2.0',
            id: item.id,
            method: item.method,
            params: {
              sessionId: item.session,
              toolCall: { toolCallId: item.tool },
              options: (item.optionKinds ?? []).map((kind, idx) => ({ optionId: `opt-${idx + 1}`, kind })),
            },
          },
          { monotonicMs: ms },
        );
      } else if (item.kind === 'non-json-stdout') {
        recorder.recordMalformedLine('<non-json-stdout>', { monotonicMs: ms });
      } else if (item.kind === 'process-exit') {
        recorder.recordProcessExit({ exitCode: item.exitCode, reason: 'child_exit' }, { monotonicMs: ms });
      } else if (item.kind === 'end') {
        recorder.recordCaptureEnd(
          { reason: item.reason, stderrBytes: item.stderrBytes ?? 0, promptSent: Boolean(item.promptSent) },
          { monotonicMs: ms },
        );
      }
    }

    const validation = validateCaptureRecords(recorder.records);
    return { format, valid: validation.valid, records: validation.valid ? recorder.records : [], validation };
  }

  if (format === 'agy_1_5_14_stage_fixture') {
    const initEntry = parsed.find((e) => e.stage === 'initialize');
    const cliVersion = initEntry?.frame?.result?.agentInfo?.version ?? '1.5.14';
    const protocol = initEntry?.frame?.result?.protocolVersion ?? 1;
    const recorder = new ProtocolObservatoryRecorder({
      captureId: safeCaptureId ?? 'migrated-agy-1.5.14-fixture',
      scenario: safeScenario ?? 'agy_1_5_14_replay',
      platform: options.platform ?? 'unknown',
      cliVersion,
      protocol,
      accountCategory: 'replay_sanitized',
      source: 'replay_with_provenance',
      producer: 'migrator',
      salt: options.salt ?? 'np01-migrator-1514',
      provenance: {
        origin: options.origin ?? 'packages/daemon/tests/fixtures/agy-1.5.14',
        migratedFrom: 'agy_1_5_14_stage_fixture',
        timingSynthetic: true,
        notes: 'Original 1.5.14 stage fixture preserved untouched; monotonic timing and request IDs are synthetic',
      },
    });

    recorder.recordCaptureMeta({ profileSource: 'replay_sanitized', mode: 'stage_fixture_migration' }, { monotonicMs: 0 });
    let ms = 10;
    let reqId = 1;
    for (const entry of parsed) {
      const stage = safeLabel(entry.stage) ?? 'stage';
      const frame = entry.frame;
      if (stage === 'initialize') {
        recorder.recordOutboundFrame({ jsonrpc: '2.0', id: reqId, method: 'initialize', params: { protocolVersion: 1 } }, { monotonicMs: ms });
        ms += 5;
        recorder.recordInboundFrame({ ...frame, id: reqId }, { monotonicMs: ms });
        reqId++;
      } else if (stage === 'session/new') {
        recorder.recordOutboundFrame({ jsonrpc: '2.0', id: reqId, method: 'session/new', params: { cwd: '<sanitized>', mcpServers: [] } }, { monotonicMs: ms });
        ms += 5;
        recorder.recordInboundFrame({ ...frame, id: reqId }, { monotonicMs: ms });
        reqId++;
      } else if (frame.error) {
        recorder.recordOutboundFrame({ jsonrpc: '2.0', id: reqId, method: 'session/prompt', params: { prompt: [{ type: 'text', text: '' }] } }, { monotonicMs: ms });
        ms += 5;
        recorder.recordInboundFrame({ ...frame, id: reqId }, { monotonicMs: ms });
        reqId++;
      } else {
        recorder.recordInboundFrame(frame, { monotonicMs: ms });
      }
      ms += 10;
    }
    recorder.recordCaptureEnd({ reason: 'migration_complete', promptSent: false, stderrBytes: 0 }, { monotonicMs: ms });
    const validation = validateCaptureRecords(recorder.records);
    return { format, valid: validation.valid, records: validation.valid ? recorder.records : [], validation };
  }

  if (format === 'np00_synthetic_routing') {
    const recorder = new ProtocolObservatoryRecorder({
      captureId: safeCaptureId ?? 'migrated-0409bc8-synthetic-routing',
      scenario: safeScenario ?? 'baseline_0409bc8_routing',
      platform: options.platform ?? 'win32',
      cliVersion: null,
      protocol: 1,
      accountCategory: 'synthetic',
      source: 'synthetic',
      producer: 'migrator',
      salt: options.salt ?? 'np01-migrator-routing',
      provenance: {
        origin: options.origin ?? 'docs/phase-agy-native-parity/evidence/0409bc8-synthetic-routing.ndjson',
        migratedFrom: 'np00_synthetic_routing',
        timingSynthetic: true,
        notes: 'Migrated baseline source-audit synthetic adapter routing evidence',
      },
    });
    recorder.recordCaptureMeta({ profileSource: 'synthetic', mode: 'routing_migration' }, { monotonicMs: 0 });
    let ms = 10;
    let ordinal = 1;
    for (const item of parsed) {
      if (item.event === 'permission.response') {
        recorder.recordOutboundFrame(
          { jsonrpc: '2.0', id: 'synthetic-permission', result: { outcome: { outcome: item.outcome } } },
          { monotonicMs: ms, ingressOrdinal: ordinal },
        );
      } else {
        recorder.recordNormalizedEvent(
          { type: item.event, turnId: item.turnId },
          { monotonicMs: ms, ingressOrdinal: ordinal, backgroundLease: item.backgroundLease },
        );
      }
      ms += 10;
      ordinal++;
    }
    recorder.recordCaptureEnd({ reason: 'migration_complete', promptSent: true, stderrBytes: 0 }, { monotonicMs: ms });
    const validation = validateCaptureRecords(recorder.records);
    return { format, valid: validation.valid, records: validation.valid ? recorder.records : [], validation };
  }

  return {
    format: 'unknown',
    valid: false,
    records: [],
    validation: { valid: false, recordCount: 0, errors: ['input: unsupported_capture_format'], leakFindings: [] },
  };
}
