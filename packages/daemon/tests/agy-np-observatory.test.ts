import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFourLayerSummary,
  formatDiagnosticCode,
  parseDiagnosticCode,
  renderFourLayerMarkdownTable,
} from '../../../scripts/agy-np/observatory/four-layer.mjs';
import { migrateNdjsonToV1 } from '../../../scripts/agy-np/observatory/migrator.mjs';
import {
  G0_DEDICATED_PROFILE_DIR,
  runLiveRecord,
  validateLiveRecordOptions,
} from '../../../scripts/agy-np/observatory/probe-live.mjs';
import {
  createDaemonTapCallbacks,
  ProtocolObservatoryRecorder,
} from '../../../scripts/agy-np/observatory/recorder.mjs';
import {
  loadReplayFixture,
  runFourLayerBaselineCorrelation,
  runTransportReplay,
} from '../../../scripts/agy-np/observatory/replay-runner.mjs';
import {
  AliasTable,
  classifyStderrLine,
  scanRecordForLeaks,
  scanTextForLeaks,
} from '../../../scripts/agy-np/observatory/sanitizer.mjs';
import {
  parseAndValidateNdjson,
  validateCaptureRecord,
  validateCaptureRecords,
} from '../../../scripts/agy-np/observatory/schema-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const NP_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'agy-np');
const LEGACY_1514_DIR = path.join(__dirname, 'fixtures', 'agy-1.5.14');
const NP00_EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'phase-agy-native-parity', 'evidence');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'agy-np', 'observatory', 'cli.mjs');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('NP-01 Protocol Observatory: Schema, Sanitizer & Recorder Core (R1, R4, R5)', () => {
  it('reconstructs inbound/outbound frames with allowlist, preserves RPC ID type, tracks latency, and correlates aliases across 4 layers', () => {
    let clock = 1000;
    const recorder = new ProtocolObservatoryRecorder({
      captureId: 'cap-test-001',
      scenario: 'T06',
      platform: 'win32',
      cliVersion: '1.5.16',
      protocol: 1,
      accountCategory: 'synthetic',
      source: 'synthetic',
      producer: 'daemon_tap_callback',
      salt: 'unit-test-salt',
      nowMonotonic: () => clock,
      nowEpoch: () => 1_700_000_000_000,
    });

    const tap = createDaemonTapCallbacks(recorder);
    expect(tap.enabled).toBe(true);

    clock = 1010;
    tap.onOutboundFrame({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      frame: {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: {
          sessionId: 'real-native-session-xyz',
          prompt: [{ type: 'text', text: 'Secret prompt C:\\Users\\Alice\\file.ts NP00_FINITE_DONE' }],
        },
      },
      turnId: 'hm-turn-1',
    });

    clock = 1055;
    tap.onInboundFrame({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 1,
      frame: {
        jsonrpc: '2.0',
        id: 7,
        result: { stopReason: 'end_turn' },
        vendorTraceHeader: 'should-only-capture-key-name',
      },
    });

    clock = 1100;
    tap.onInboundFrame({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 2,
      frame: {
        jsonrpc: '2.0',
        id: 'srv-perm-str-42',
        method: 'session/request_permission',
        params: {
          sessionId: 'real-native-session-xyz',
          childSessionId: 'real-child-beta',
          toolCall: { toolCallId: 'tool-real-99', kind: 'execute', title: 'Run private.ps1' },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', _meta: { 'agy.security.warning': 'Danger' } },
          ],
        },
      },
    });

    tap.onNormalizedEvent({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 2,
      event: {
        type: 'approval.requested',
        turnId: 'hm-turn-1',
        nativeRequestId: 'acp_req_srv-perm-str-42',
        toolCallId: 'tool-real-99',
        kind: 'permission',
      },
      aliases: {
        sessionId: 'real-native-session-xyz',
        childSessionId: 'real-child-beta',
      },
    });

    tap.onNativeCanonicalEvent({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 2,
      event: { type: 'native.request.changed', seq: 12, state: 'requires_action', receiptState: 'pending' },
      aliases: {
        sessionId: 'real-native-session-xyz',
        childSessionId: 'real-child-beta',
        toolCallId: 'tool-real-99',
        approvalId: 'srv-perm-str-42',
        turnId: 'hm-turn-1',
      },
    });

    tap.onUiProjection({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 2,
      projection: { status: 'requires_action', asOfSeq: 12, pendingRequestCount: 1 },
      aliases: {
        sessionId: 'real-native-session-xyz',
        childSessionId: 'real-child-beta',
        toolCallId: 'tool-real-99',
        approvalId: 'srv-perm-str-42',
        turnId: 'hm-turn-1',
      },
    });

    clock = 1135;
    tap.onOutboundFrame({
      connectionId: 'raw-conn-alpha',
      generation: 'gen-1',
      ingressOrdinal: 2,
      frame: {
        jsonrpc: '2.0',
        id: 'srv-perm-str-42',
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      },
    });

    const validation = validateCaptureRecords(recorder.records);
    expect(validation.valid).toBe(true);
    expect(validation.leakFindings).toHaveLength(0);

    const ndjson = recorder.toNdjson();
    expect(ndjson).not.toContain('real-native-session-xyz');
    expect(ndjson).not.toContain('real-child-beta');
    expect(ndjson).not.toContain('tool-real-99');
    expect(ndjson).not.toContain('C:\\Users\\Alice\\file.ts');
    expect(ndjson).not.toContain('should-only-capture-key-name');

    const promptReq = recorder.records[0]!;
    const promptRes = recorder.records[1]!;
    expect(promptReq.correlation.rpcIdType).toBe('number');
    expect(promptRes.correlation.rpcIdType).toBe('number');
    expect(promptRes.correlation.rpcIdAlias).toBe(promptReq.correlation.rpcIdAlias);
    expect(promptRes.latencyMs).toBe(45);
    expect(promptRes.unknownKeys).toContain('vendorTraceHeader');
    expect(promptReq.shape.testMarkers?.[0]?.marker).toBe('NP00_FINITE_DONE');
    expect(promptReq.shape.testMarkers?.[0]?.saltedTag).toMatch(/^salted:[0-9a-f]{12}$/);

    const srvReq = recorder.records[2]!;
    const srvReply = recorder.records[6]!;
    expect(srvReq.correlation.rpcIdType).toBe('string');
    expect(srvReply.correlation.rpcIdType).toBe('string');
    expect(srvReply.latencyMs).toBe(35);

    // Every record has a unique copyable diagnostic code
    const allCodes = recorder.records.map((r) => r.correlation.diagnosticCode);
    expect(new Set(allCodes).size).toBe(allCodes.length);

    const summary = buildFourLayerSummary(recorder.records);
    const alignedRow = summary.rows.find((r) => r.ingressOrdinal === 2);
    expect(alignedRow?.attributionStatus).toBe('four_layer_aligned');
    // Both inbound server_request AND outbound permission reply are preserved in the row
    expect(alignedRow?.layers.raw?.eventCount).toBe(2);
    expect(alignedRow?.layers.raw?.label).toContain('outcome=selected');

    const parsedCode = parseDiagnosticCode(summary.np03DiagnosticInput.copyableDiagnosticCode);
    expect(parsedCode).not.toBeNull();
    expect(parsedCode?.version).toBe('v1');
    expect(renderFourLayerMarkdownTable(summary)).toContain('Four-Layer Correlation Summary');
  });

  it('R1: blocks fictitious sensitive inputs across metadata, provenance, generation, dynamic keys, and migrate stdout/--out', async () => {
    const tmp = makeTempDir('hm-np01-r1-');
    const outPath = path.join(tmp, 'recorder.ndjson');
    const sinkLines: string[] = [];
    const fakeEmail = 'fictitious.reviewer@example.test';

    const recorder = new ProtocolObservatoryRecorder({
      captureId: fakeEmail,
      scenario: fakeEmail,
      cliVersion: `1.5.16-${fakeEmail}`,
      accountCategory: 'synthetic',
      source: 'synthetic',
      provenance: {
        origin: fakeEmail,
        migratedFrom: fakeEmail,
        notes: `Contains ${fakeEmail} and C:\\Users\\Fictitious\\key.txt`,
      },
      outputFile: outPath,
      sink: (_rec, line) => sinkLines.push(line),
    });

    recorder.recordInboundFrame(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-r1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-r1',
            [fakeEmail]: 'nested-secret',
            secret_token_key: 'nested-secret-2',
          },
        },
      },
      { generation: fakeEmail, ingressOrdinal: 1 },
    );
    await recorder.flush();

    const fileContent = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    const combinedOut = `${recorder.toNdjson()}\n${sinkLines.join('\n')}\n${fileContent}`;
    expect(combinedOut).not.toContain(fakeEmail);
    expect(combinedOut).not.toContain('secret_token_key');
    expect(combinedOut).not.toContain('C:\\Users\\Fictitious\\key.txt');
    expect(validateCaptureRecords(recorder.records).valid).toBe(true);
    expect(recorder.getStats().metadataSanitizedCount).toBeGreaterThanOrEqual(3);

    // R1: migrate CLI must NEVER write invalid/leaking v1 records to stdout OR --out
    const poisonedV1Path = path.join(tmp, 'poisoned-v1.ndjson');
    const poisonedRecord = {
      ...recorder.records[0],
      scenario: fakeEmail,
    };
    fs.writeFileSync(poisonedV1Path, `${JSON.stringify(poisonedRecord)}\n`, 'utf8');

    const migratedStdoutRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'migrate', '--in', poisonedV1Path],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(migratedStdoutRes.status).toBe(1);
    expect(migratedStdoutRes.stdout).toBe('');
    expect(migratedStdoutRes.stderr).not.toContain(fakeEmail);
    expect(migratedStdoutRes.stderr).toContain('leak_detected');

    const migratedOutFile = path.join(tmp, 'should-not-exist.ndjson');
    const migratedFileRes = spawnSync(
      process.execPath,
      [CLI_PATH, 'migrate', '--in', poisonedV1Path, '--out', migratedOutFile],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(migratedFileRes.status).toBe(1);
    expect(fs.existsSync(migratedOutFile)).toBe(false);
    expect(migratedFileRes.stderr).not.toContain(fakeEmail);
  });

  it('R4: bounds aliases, pending requests, disabled recorder, long lines, and async file IO queue', async () => {
    // 1) Directly calling enabled=false recorder allocates 0 aliases & 0 pending requests
    const disabled = new ProtocolObservatoryRecorder({ enabled: false });
    disabled.recordOutboundFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    disabled.recordInboundFrame({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    expect(disabled.getStats().recordCount).toBe(0);
    expect(disabled.getStats().allocatedAliases).toBe(0);
    expect(disabled.getStats().pendingClientRequests).toBe(0);

    // 2) Early drop on maxRecords=2 stops alias & pending request growth before emitting
    const capped = new ProtocolObservatoryRecorder({
      captureId: 'cap-r4-early-drop',
      scenario: 'r4_bounds',
      maxRecords: 2,
      maxLineBytes: 512,
      sink: () => {
        throw new Error('simulated slow/failing sink');
      },
    });
    for (let i = 1; i <= 20; i++) {
      capped.recordOutboundFrame({
        jsonrpc: '2.0',
        id: i,
        method: 'session/prompt',
        params: { sessionId: `sess-${i}`, prompt: [{ type: 'text', text: 'x'.repeat(200) }] },
      });
    }
    const cappedStats = capped.getStats();
    expect(cappedStats.recordCount).toBe(3); // 2 regular + 1 drop_overflow
    expect(cappedStats.allocatedAliases).toBeLessThanOrEqual(6); // stopped after 2 records, NOT 20!
    expect(cappedStats.pendingClientRequests).toBeLessThanOrEqual(2);
    expect(cappedStats.dropReasons.max_records).toBe(18);
    expect(cappedStats.dropReasons.sink_error).toBeGreaterThanOrEqual(3);
    expect(validateCaptureRecords(capped.records).valid).toBe(true);

    // 3) AliasTable hard cap
    const smallAlias = new AliasTable({ maxAliasesPerNamespace: 3, maxTotalAliases: 6 });
    expect(smallAlias.alias('tool', 'a')).toBe('tool-1');
    expect(smallAlias.alias('tool', 'b')).toBe('tool-2');
    expect(smallAlias.alias('tool', 'c')).toBe('tool-3');
    expect(smallAlias.alias('tool', 'd')).toBe('tool-overflow');
    expect(smallAlias.overflowCount).toBe(1);

    // 4) Non-blocking async file IO queue with overflow cap & clean flush
    const tmp = makeTempDir('hm-np01-r4-io-');
    const outFile = path.join(tmp, 'async-io.ndjson');
    const ioRec = new ProtocolObservatoryRecorder({
      captureId: 'cap-r4-io',
      scenario: 'r4_io',
      outputFile: outFile,
      maxQueuedWriteLines: 2,
    });
    for (let i = 1; i <= 6; i++) {
      ioRec.recordStderrLine(`warn line ${i} ${'a'.repeat(50_000)}`);
    }
    await ioRec.flush();
    expect(ioRec.getStats().dropReasons.io_queue_overflow).toBeGreaterThanOrEqual(1);
    const parsedFile = parseAndValidateNdjson(fs.readFileSync(outFile, 'utf8'));
    expect(parsedFile.valid).toBe(true);
  });

  it('R5: single-source schema validator rejects shape string, extra provenance key, numeric generation, and leaks without echoing raw values', () => {
    const rec = new ProtocolObservatoryRecorder({ captureId: 'cap-r5-schema', scenario: 'r5_test', protocol: 1 });
    const validRecord = rec.recordCaptureMeta({ profileSource: 'synthetic', mode: 'test' })!;
    expect(validateCaptureRecord(validRecord, 0).valid).toBe(true);

    const badShape = { ...validRecord, shape: 'not-an-object' };
    const r1 = validateCaptureRecord(badShape, 0);
    expect(r1.valid).toBe(false);
    expect(r1.errors).toContain('record[0].shape: invalid_type');

    const badProv = { ...validRecord, provenance: { origin: 'ok', undeclaredSecretKey: 123 } };
    const r2 = validateCaptureRecord(badProv, 0);
    expect(r2.valid).toBe(false);
    expect(r2.errors.some((e) => e.includes('additional_property_not_allowed'))).toBe(true);
    expect(r2.errors.join('\n')).not.toContain('undeclaredSecretKey');

    const badGen = { ...validRecord, correlation: { ...validRecord.correlation, generation: 123 } };
    const r3 = validateCaptureRecord(badGen, 0);
    expect(r3.valid).toBe(false);
    expect(r3.errors).toContain('record[0].correlation.generation: invalid_type');

    const badPlatform = { ...validRecord, platform: 'SECRET_BAD_ENUM_VALUE' };
    const r4 = validateCaptureRecord(badPlatform, 0);
    expect(r4.valid).toBe(false);
    expect(r4.errors).toContain('record[0].platform: invalid_enum');
    expect(r4.errors.join('\n')).not.toContain('SECRET_BAD_ENUM_VALUE');
  });

  it('R2: scopes four-layer rows by generation & channel, preserves multi-events, distinguishes raw-only captures, and yields unique diagnostic codes', () => {
    let t = 0;
    const rec = new ProtocolObservatoryRecorder({
      captureId: 'cap-r2-scope',
      scenario: 'r2_scope',
      protocol: 1,
      nowMonotonic: () => (t += 10),
    });

    // Generation 1, live channel, ordinal 1
    rec.recordOutboundFrame({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's1' } }, { generation: 'gen-1', channel: 'live' });
    rec.recordInboundFrame({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }, { generation: 'gen-1', channel: 'live', ingressOrdinal: 1 });

    // Generation 1, history_replay channel, SAME ordinal 1
    rec.recordInboundFrame(
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } } } },
      { generation: 'gen-1', channel: 'history_replay', ingressOrdinal: 1 },
    );

    // Generation 2 (reconnect), live channel, SAME ordinal 1 with server_request (raw-only capture!)
    rec.recordInboundFrame(
      { jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', kind: 'execute' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } },
      { generation: 'gen-2', channel: 'live', ingressOrdinal: 1 },
    );
    rec.recordOutboundFrame(
      { jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'cancelled' } } },
      { generation: 'gen-2', channel: 'live', ingressOrdinal: 1 },
    );

    const summary = buildFourLayerSummary(rec.records);
    const ordinal1Rows = summary.rows.filter((r) => r.ingressOrdinal === 1);
    expect(ordinal1Rows).toHaveLength(3); // gen-1/live, gen-1/history_replay, gen-2/live NEVER collapsed!

    // gen-2/live has BOTH inbound server_request AND outbound cancelled reply
    const gen2Row = ordinal1Rows.find((r) => r.generation === 'gen-2')!;
    expect(gen2Row.layers.raw?.eventCount).toBe(2);
    expect(gen2Row.layers.raw?.label).toContain('outcome=cancelled');
    // Because normalized layer was NEVER captured in gen-2/live, attribution MUST be layer_not_captured (NOT dropped_before_adapter!)
    expect(gen2Row.attributionStatus).toBe('layer_not_captured');
    expect(summary.anomalies.some((a) => a.status === 'dropped_before_adapter')).toBe(false);

    // All diagnostic codes across rows & records are unique
    const recCodes = rec.records.map((r) => r.correlation.diagnosticCode);
    expect(new Set(recCodes).size).toBe(recCodes.length);
  });

  it('classifies stderr without leaking raw text and catches synthetic leak injections', () => {
    const aliases = new AliasTable({ salt: 'leak-test' });
    const oauthLine = 'Open https://accounts.google.com/o/oauth2/auth?code=abc123&access_token=ya29.SECRET_XYZ';
    const classified = classifyStderrLine(oauthLine, aliases);
    expect(classified.category).toBe('oauth_url_suppressed');
    expect(classified.shapeHash).toMatch(/^shape:[0-9a-f]{16}$/);
    expect(JSON.stringify(classified)).not.toContain('ya29.SECRET_XYZ');
    expect(JSON.stringify(classified)).not.toContain('abc123');

    expect(scanTextForLeaks(oauthLine)).toEqual(expect.arrayContaining(['oauth_query_secret', 'google_oauth_token']));
    expect(scanTextForLeaks('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toContain('bearer_token');
    expect(scanTextForLeaks('C:\\Users\\Windfile\\secrets\\token.json')).toContain('windows_user_path');
    expect(scanTextForLeaks('user.private@company.com')).toContain('email_address');

    const leakFindings = scanRecordForLeaks({ shape: { bad: 'AIzaSyFAKEKEY12345678901234567890' } });
    expect(leakFindings).toContain('google_api_key');

    const code = formatDiagnosticCode({
      captureId: 'cap-1',
      scenario: 'T02',
      connectionId: 'conn-1',
      generation: 'gen-1',
      channel: 'live',
      ingressOrdinal: 4,
      seq: 9,
      layer: 'normalized',
      reasonCode: 'placeholder_turn_bg',
    });
    expect(code).toBe('AGY-DIAG-v1:cap-1:T02:conn-1:gen-1:live:4:s9:normalized:placeholder_turn_bg');
    expect(parseDiagnosticCode(code)?.seq).toBe(9);
    expect(scanTextForLeaks(code)).toHaveLength(0);
  });
});

describe('NP-01 Protocol Observatory: T01–T06, Slow-Start T03 & Baseline Four-Layer Replays (R2, R5)', () => {
  const fixtureFiles = [
    't01-single-turn.ndjson',
    't02-reactive-20s-wake.ndjson',
    't03-long-finite-timeout-exit.ndjson',
    't04-parallel-finite-and-daemon.ndjson',
    't05-double-wake-and-usage-only.ndjson',
    't06-post-turn-permission-and-child.ndjson',
    'failure-malformed-and-secret-trap.ndjson',
  ];

  for (const fileName of fixtureFiles) {
    it(`replays ${fileName} deterministically and satisfies explicit verdict criteria`, async () => {
      const fixture = loadReplayFixture(path.join(NP_FIXTURES_DIR, fileName));
      const result = await runTransportReplay(fixture);

      expect(result.validation.errors).toEqual([]);
      expect(result.validation.leakFindings).toEqual([]);
      expect(result.verdict.checks.filter((c) => !c.passed)).toEqual([]);

      if (fileName === 't04-parallel-finite-and-daemon.ndjson') {
        const toolUpdates = result.records.filter(
          (r) => r.layer === 'raw' && (r.shape.updateType === 'tool_call' || r.shape.updateType === 'tool_call_update'),
        );
        expect(new Set(toolUpdates.map((r) => r.correlation.toolAlias).filter(Boolean)).size).toBe(3);
        expect(new Set(toolUpdates.map((r) => r.correlation.taskAlias).filter(Boolean)).size).toBe(3);
      }

      if (fileName === 't05-double-wake-and-usage-only.ndjson') {
        expect(result.records.some((r) => r.unknownKeys?.includes('update.experimentalWakeEpoch'))).toBe(true);
      }

      if (fileName === 't06-post-turn-permission-and-child.ndjson') {
        const srvReqs = result.records.filter((r) => r.messageKind === 'server_request');
        expect(srvReqs).toHaveLength(2);
        expect(srvReqs[0]?.correlation.rpcIdType).toBe('number');
        expect(srvReqs[0]?.shape.hasSecurityWarning).toBe(true);
        expect(srvReqs[1]?.correlation.rpcIdType).toBe('string');
        expect(srvReqs[1]?.shape.isInteraction).toBe(true);
        expect(srvReqs[1]?.correlation.childAlias).toBe('child-1');
        const replies = result.records.filter(
          (r) => r.direction === 'outbound' && r.messageKind === 'rpc_response',
        );
        expect(replies).toHaveLength(2);
        expect(replies.every((r) => typeof r.latencyMs === 'number' && r.latencyMs >= 0)).toBe(true);
      }
    }, 20_000);
  }

  it('R5: T03 remains deterministic under simulated slow Windows startup', async () => {
    const fixture = loadReplayFixture(path.join(NP_FIXTURES_DIR, 't03-long-finite-timeout-exit.ndjson'));
    const result = await runTransportReplay(fixture, { simulateSlowStartMs: 700, watchdogMs: 4_000 });
    expect(result.validation.errors).toEqual([]);
    expect(result.verdict.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.summary.exitCode).toBe(137);
  }, 20_000);

  it('R2: runs real baseline AcpSessionHandle + AntigravityAcpFlavorPolicy four-layer correlation and preserves outbound cancelled reply', async () => {
    const distFile = path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'acp', 'strict-acp-adapter.js');
    if (!fs.existsSync(distFile)) {
      return;
    }
    const res = await runFourLayerBaselineCorrelation();
    expect(res.validation.errors).toEqual([]);
    expect(res.permReplyOutcome).toBe('cancelled');
    expect(res.summary.layerCounts.raw).toBeGreaterThan(0);
    expect(res.summary.layerCounts.normalized).toBeGreaterThan(0);
    expect(res.summary.layerCounts.native_canonical).toBeGreaterThan(0);
    expect(res.summary.layerCounts.ui).toBeGreaterThan(0);

    const permRow = res.summary.rows.find((r) => r.ingressOrdinal === 10);
    expect(permRow?.layers.raw?.eventCount).toBe(2);
    expect(permRow?.layers.raw?.label).toContain('outcome=cancelled');
    expect(permRow?.attributionStatus).toBe('dropped_before_adapter');
    expect(permRow?.reasonCode).toBe('server_request_cancelled_before_adapter');
    expect(res.summary.anomalies.some((a) => a.status === 'adapter_misattributed_placeholder')).toBe(true);
  }, 20_000);
});

describe('NP-01 Protocol Observatory: Format Migration & U01 Boundary Guards (R1, R3)', () => {
  it('migrates NP-00 probe NDJSON, 0409bc8 synthetic routing, and agy-1.5.14 fixtures without modifying originals', () => {
    const cleanV2Path = path.join(NP00_EVIDENCE_DIR, 'windows-1.5.16-request-v2.ndjson');
    const migratedV2 = migrateNdjsonToV1(fs.readFileSync(cleanV2Path, 'utf8'), { origin: 'windows-1.5.16-request-v2.ndjson' });
    expect(migratedV2.valid).toBe(true);
    const v2Summary = buildFourLayerSummary(migratedV2.records);
    expect(v2Summary.requestedProtocol).toBe(2);
    expect(v2Summary.negotiatedProtocol).toBe(1);

    const legacy1514Path = path.join(LEGACY_1514_DIR, 'session-full.ndjson');
    const legacyBefore = fs.readFileSync(legacy1514Path, 'utf8');
    const migrated1514 = migrateNdjsonToV1(legacyBefore, { origin: 'session-full.ndjson' });
    expect(migrated1514.format).toBe('agy_1_5_14_stage_fixture');
    expect(migrated1514.valid).toBe(true);
    expect(migrated1514.records[0]?.source).toBe('replay_with_provenance');
    expect(fs.readFileSync(legacy1514Path, 'utf8')).toBe(legacyBefore);
  });

  it('R3: enforces G0 dedicated profile, official agy.exe path, and strict outcome exit codes', () => {
    const officialAgy = path.win32.join(
      process.env.LOCALAPPDATA ?? 'C:\\Users\\example\\AppData\\Local',
      'agy',
      'bin',
      'agy.exe',
    );

    // Reject arbitrary D-drive profile outside G0 dedicated profile!
    expect(() =>
      validateLiveRecordOptions(
        {
          agy: officialAgy,
          scratch: 'D:\\HarnessMate\\agy-np-test-profile\\runs',
          'test-profile': 'D:\\qa\\other-profile',
          'discover-confirmed': true,
          'dry-run': true,
          protocol: '1',
        },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/G0 dedicated test profile/i);

    // Reject arbitrary same-name binary outside official AGY install locations!
    expect(() =>
      validateLiveRecordOptions(
        {
          agy: 'C:\\evil\\agy.exe',
          scratch: 'D:\\HarnessMate\\np00-research',
          'dry-run': true,
          protocol: '1',
        },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/official Google AGY installation locations/i);

    // Reject bad Gemini 3.8 Flash model ID
    expect(() =>
      validateLiveRecordOptions(
        {
          agy: officialAgy,
          scratch: 'D:\\HarnessMate\\agy-np-test-profile\\runs',
          'test-profile': G0_DEDICATED_PROFILE_DIR,
          'reactive-confirmed': true,
          model: 'gemini-2.5-pro',
          'dry-run': true,
          protocol: '1',
        },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/Gemini 3\.8 Flash/i);

    // Accept G0 dedicated profile under dry-run
    const stdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        'record',
        '--dry-run',
        '--agy',
        officialAgy,
        '--scratch',
        'D:\\HarnessMate\\agy-np-test-profile\\runs',
        '--test-profile',
        G0_DEDICATED_PROFILE_DIR,
        '--discover-confirmed',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const plan = JSON.parse(stdout);
    expect(plan.dryRun).toBe(true);
    expect(plan.dedicatedProfileBound).toBe(true);
    expect(plan.officialPathVerified).toBe(true);
    expect(plan.signatureCheckPlanned).toBe(true);
  });

  it('R3: mock server verifies model-not-advertised, model-rejected, discovery, reactive success, and v2 downgrade outcomes', async () => {
    const tmp = makeTempDir('hm-np01-r3-mock-');
    const mockProfile = path.join(tmp, 'gemini');
    const mockScratch = path.join(tmp, 'runs');
    const mockScript = path.join(tmp, 'mock-agy.mjs');

    fs.writeFileSync(
      mockScript,
      `
      import readline from 'node:readline';
      const mode = process.argv[2] || 'success';
      const write = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'initialize') {
          write({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' }, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          const models = mode === 'unadvertised'
            ? [{ value: 'gemini-3.1-pro' }]
            : [{ value: 'gemini-3.1-pro' }, { value: 'gemini-3.8-flash' }];
          write({
            id: msg.id,
            result: {
              sessionId: 'mock-sess-1',
              configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.1-pro', options: models }],
            },
          });
        } else if (msg.method === 'session/set_config_option') {
          if (mode === 'rejected') {
            write({ id: msg.id, error: { code: -32001, message: 'Model rejected' } });
          } else {
            write({
              id: msg.id,
              result: {
                configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: msg.params.value, options: [{ value: msg.params.value }] }],
              },
            });
          }
        } else if (msg.method === 'session/prompt') {
          write({ method: 'session/update', params: { sessionId: 'mock-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NP00_FINITE_DONE' } } } });
          write({ id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      `,
      'utf8',
    );

    const commonHooks = (mode: string) => ({
      allowMockBinaryForTest: true,
      dedicatedProfileOverride: mockProfile,
      allowedRootsOverride: [mockScratch],
      allowedAuthorizedRootsOverride: [mockScratch],
      mockSpawnCommand: process.execPath,
      mockSpawnArgs: [mockScript, mode],
      quietStdout: true,
      quietStderr: true,
      mockOperator: {
        question: async () => 'YES',
        close: () => {},
      },
    });

    // 1) Model not advertised -> success: false
    const unadv = await runLiveRecord(
      ['--agy', 'mock', '--scratch', mockScratch, '--test-profile', mockProfile, '--reactive-confirmed', '--model', 'gemini-3.8-flash'],
      commonHooks('unadvertised'),
    );
    expect(unadv.success).toBe(false);
    expect(unadv.reason).toBe('requested-model-not-advertised');
    expect(unadv.summary.exitCode).not.toBeNull();

    // 2) Model config rejected -> success: false
    const rej = await runLiveRecord(
      ['--agy', 'mock', '--scratch', mockScratch, '--test-profile', mockProfile, '--reactive-confirmed', '--model', 'gemini-3.8-flash'],
      commonHooks('rejected'),
    );
    expect(rej.success).toBe(false);
    expect(rej.reason).toBe('model-config-rejected');

    // 3) Discovery complete -> success: true
    const disc = await runLiveRecord(
      ['--agy', 'mock', '--scratch', mockScratch, '--test-profile', mockProfile, '--discover-confirmed'],
      commonHooks('success'),
    );
    expect(disc.success).toBe(true);
    expect(disc.outcome).toBe('discovery_complete');
    expect(disc.negotiatedProtocol).toBe(1);

    // 4) Reactive confirmed happy path -> success: true
    const ok = await runLiveRecord(
      ['--agy', 'mock', '--scratch', mockScratch, '--test-profile', mockProfile, '--reactive-confirmed', '--model', 'gemini-3.8-flash'],
      commonHooks('success'),
    );
    expect(ok.success).toBe(true);
    expect(ok.outcome).toBe('reactive_observed');
    expect(ok.promptSent).toBe(true);

    // 5) Clean v2 request downgraded to v1 -> success: true, requestedProtocol=2, negotiatedProtocol=1
    const v2 = await runLiveRecord(
      ['--agy', 'mock', '--scratch', mockScratch, '--protocol', '2'],
      commonHooks('success'),
    );
    expect(v2.success).toBe(true);
    expect(v2.outcome).toBe('expected_v2_downgrade_to_v1');
    expect(v2.summary.requestedProtocol).toBe(2);
    expect(v2.summary.negotiatedProtocol).toBe(1);
  }, 25_000);
});
