import { execFileSync } from 'node:child_process';
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
import { validateLiveRecordOptions } from '../../../scripts/agy-np/observatory/probe-live.mjs';
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

describe('NP-01 Protocol Observatory: Schema, Sanitizer & Recorder Core', () => {
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

    // Outbound numeric RPC request (prompt containing raw text + path that must NOT leak)
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

    // Inbound response to numeric RPC 7 with unknown top-level field
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

    // Inbound server_request with STRING rpc id & childSessionId & security warning
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

    // Downstream layers (normalized, native_canonical, ui) using the SAME real IDs -> must map to SAME aliases
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

    // Client responds to string server request after 35ms
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

    // Verify numeric vs string RPC ID types and latencies
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

    // Same alias spans all 4 layers at ingressOrdinal=2
    const layerRecords = recorder.records.slice(2, 6);
    expect(layerRecords.map((r) => r.layer)).toEqual(['raw', 'normalized', 'native_canonical', 'ui']);
    const sessionAliases = new Set(layerRecords.map((r) => r.correlation.sessionAlias));
    const childAliases = new Set(layerRecords.map((r) => r.correlation.childAlias));
    const toolAliases = new Set(layerRecords.map((r) => r.correlation.toolAlias));
    const approvalAliases = new Set(layerRecords.map((r) => r.correlation.approvalAlias));
    expect(sessionAliases.size).toBe(1);
    expect(childAliases.size).toBe(1);
    expect(toolAliases.size).toBe(1);
    expect(approvalAliases.size).toBe(1);

    // Four-layer summary and NP-03 diagnostic code format
    const summary = buildFourLayerSummary(recorder.records);
    const alignedRow = summary.rows.find((r) => r.ingressOrdinal === 2);
    expect(alignedRow?.attributionStatus).toBe('four_layer_aligned');
    const parsedCode = parseDiagnosticCode(summary.np03DiagnosticInput.copyableDiagnosticCode);
    expect(parsedCode).not.toBeNull();
    expect(parsedCode?.version).toBe('v1');
    expect(renderFourLayerMarkdownTable(summary)).toContain('Four-Layer Correlation Summary');
  });

  it('enforces bounded drop/overflow, line byte truncation, fail-isolated sink, and opt-out no-op mode', () => {
    const throwingRecorder = new ProtocolObservatoryRecorder({
      captureId: 'cap-bounds-001',
      scenario: 'bounds_test',
      maxRecords: 3,
      maxLineBytes: 512,
      sink: () => {
        throw new Error('disk full simulated error');
      },
    });

    const tap = createDaemonTapCallbacks(throwingRecorder);
    // Must never throw even when sink throws on every call
    expect(() => {
      for (let i = 1; i <= 6; i++) {
        tap.onInboundFrame({
          connectionId: 'conn-1',
          ingressOrdinal: i,
          frame: {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-1',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: `tool-${i}`,
                // Include many unknown keys to trigger line byte truncation
                ...Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`extra_field_${k}`, 'v'])),
              },
            },
          },
        });
      }
    }).not.toThrow();

    const stats = throwingRecorder.getStats();
    expect(stats.droppedCount).toBeGreaterThanOrEqual(3);
    expect(stats.sinkErrorCount).toBeGreaterThanOrEqual(4);
    expect(throwingRecorder.records.some((r) => r.messageKind === 'drop_overflow')).toBe(true);
    expect(throwingRecorder.records.some((r) => r.truncated === true)).toBe(true);
    expect(validateCaptureRecords(throwingRecorder.records).valid).toBe(true);

    // Opt-out recorder produces zero records
    const disabledRecorder = new ProtocolObservatoryRecorder({ enabled: false });
    const disabledTap = createDaemonTapCallbacks(disabledRecorder);
    expect(disabledTap.enabled).toBe(false);
    disabledTap.onInboundFrame({ connectionId: 'conn-1', ingressOrdinal: 1, frame: { jsonrpc: '2.0', method: 'ping' } });
    expect(disabledRecorder.records).toHaveLength(0);
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

    // Leak guard catches raw secret if ever injected directly into a custom diagnostic record
    const leakFindings = scanRecordForLeaks({ shape: { bad: 'AIzaSyFAKEKEY12345678901234567890' } });
    expect(leakFindings).toContain('google_api_key');

    const code = formatDiagnosticCode({
      captureId: 'cap-1',
      scenario: 'T02',
      connectionId: 'conn-1',
      ingressOrdinal: 4,
      layer: 'normalized',
      reasonCode: 'placeholder_turn_bg',
    });
    expect(code).toBe('AGY-DIAG-v1:cap-1:T02:conn-1:4:normalized:placeholder_turn_bg');
    expect(scanTextForLeaks(code)).toHaveLength(0);
  });
});

describe('NP-01 Protocol Observatory: T01–T06 & Failure Fixture Replays', () => {
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

      expect(result.validation.valid).toBe(true);
      expect(result.validation.leakFindings).toHaveLength(0);
      expect(result.verdict.passed).toBe(true);

      if (fileName === 't04-parallel-finite-and-daemon.ndjson') {
        const toolUpdates = result.records.filter(
          (r) => r.layer === 'raw' && (r.shape.updateType === 'tool_call' || r.shape.updateType === 'tool_call_update'),
        );
        const distinctTools = new Set(toolUpdates.map((r) => r.correlation.toolAlias).filter(Boolean));
        const distinctTasks = new Set(toolUpdates.map((r) => r.correlation.taskAlias).filter(Boolean));
        expect(distinctTools.size).toBe(3);
        expect(distinctTasks.size).toBe(3);
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
        // Verify outbound permission replies recorded latency and same approvalAlias
        const replies = result.records.filter(
          (r) => r.direction === 'outbound' && r.messageKind === 'rpc_response',
        );
        expect(replies).toHaveLength(2);
        expect(replies.every((r) => typeof r.latencyMs === 'number' && r.latencyMs >= 0)).toBe(true);
      }
    }, 20_000);
  }

  it('runs real baseline AcpSessionHandle + AntigravityAcpFlavorPolicy four-layer correlation and detects turn_bg & cancelled permission anomalies', async () => {
    const distFile = path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'harnesses', 'acp', 'strict-acp-adapter.js');
    if (!fs.existsSync(distFile)) {
      return;
    }
    const res = await runFourLayerBaselineCorrelation();
    expect(res.validation.valid).toBe(true);
    expect(res.permReplyOutcome).toBe('cancelled');
    expect(res.summary.layerCounts.raw).toBeGreaterThan(0);
    expect(res.summary.layerCounts.normalized).toBeGreaterThan(0);
    expect(res.summary.layerCounts.native_canonical).toBeGreaterThan(0);
    expect(res.summary.layerCounts.ui).toBeGreaterThan(0);
    expect(res.summary.anomalies.some((a) => a.status === 'adapter_misattributed_placeholder')).toBe(true);
    expect(res.summary.anomalies.some((a) => a.status === 'dropped_before_adapter')).toBe(true);
  }, 20_000);
});

describe('NP-01 Protocol Observatory: Format Migration & CLI Safety Guards', () => {
  it('migrates NP-00 probe NDJSON, 0409bc8 synthetic routing, and agy-1.5.14 fixtures without modifying originals', () => {
    const cleanV1Path = path.join(NP00_EVIDENCE_DIR, 'windows-1.5.16-clean-v1.ndjson');
    const cleanV1Before = fs.readFileSync(cleanV1Path, 'utf8');
    const migratedClean = migrateNdjsonToV1(cleanV1Before, { origin: 'windows-1.5.16-clean-v1.ndjson' });
    expect(migratedClean.format).toBe('np00_probe_acp');
    expect(migratedClean.validation.valid).toBe(true);
    expect(migratedClean.records[0]?.source).toBe('live_raw');

    const routingPath = path.join(NP00_EVIDENCE_DIR, '0409bc8-synthetic-routing.ndjson');
    const migratedRouting = migrateNdjsonToV1(fs.readFileSync(routingPath, 'utf8'));
    expect(migratedRouting.format).toBe('np00_synthetic_routing');
    expect(migratedRouting.validation.valid).toBe(true);
    expect(migratedRouting.records[0]?.source).toBe('synthetic');

    const legacy1514Path = path.join(LEGACY_1514_DIR, 'session-full.ndjson');
    const legacyBefore = fs.readFileSync(legacy1514Path, 'utf8');
    const migrated1514 = migrateNdjsonToV1(legacyBefore, { origin: 'session-full.ndjson' });
    expect(migrated1514.format).toBe('agy_1_5_14_stage_fixture');
    expect(migrated1514.validation.valid).toBe(true);
    expect(migrated1514.records[0]?.source).toBe('replay_with_provenance');
    expect(migrated1514.records[0]?.provenance?.timingSynthetic).toBe(true);
    // Original 1.5.14 fixture remains byte-for-byte untouched
    expect(fs.readFileSync(legacy1514Path, 'utf8')).toBe(legacyBefore);
  });

  it('rejects non-D paths, non-agy binaries, bad Gemini 3.8 Flash model IDs, and supports dry-run CLI', () => {
    expect(() =>
      validateLiveRecordOptions(
        { agy: 'C:\\tools\\agy.exe', scratch: 'C:\\Temp\\bad', protocol: '1' },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/D:\\/i);

    expect(() =>
      validateLiveRecordOptions(
        { agy: 'C:\\tools\\fake.exe', scratch: 'D:\\HarnessMate\\scratch', protocol: '1' },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/agy\.exe/i);

    expect(() =>
      validateLiveRecordOptions(
        {
          agy: 'C:\\tools\\agy.exe',
          scratch: 'D:\\HarnessMate\\scratch',
          'test-profile': 'D:\\HarnessMate\\profile',
          'reactive-confirmed': true,
          model: 'gemini-2.5-pro',
          protocol: '1',
        },
        { platform: 'win32', isTTY: true },
      ),
    ).toThrow(/Gemini 3\.8 Flash/i);

    // Dry-run succeeds via CLI without spawning agy.exe
    const stdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        'record',
        '--dry-run',
        '--agy',
        'C:\\Users\\example\\AppData\\Local\\agy\\bin\\agy.exe',
        '--scratch',
        'D:\\HarnessMate\\np00-research',
        '--catalog',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const plan = JSON.parse(stdout);
    expect(plan.dryRun).toBe(true);
    expect(plan.mode).toBe('clean_unauthenticated');
    expect(plan.isolation.dDriveEnforced).toBe(true);

    // CLI migrate + validate roundtrip in temp dir
    const tmp = makeTempDir('hm-np01-cli-');
    const outFile = path.join(tmp, 'migrated.ndjson');
    execFileSync(
      process.execPath,
      [CLI_PATH, 'migrate', '--in', path.join(NP00_EVIDENCE_DIR, 'windows-1.5.16-clean-v1.ndjson'), '--out', outFile],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const parsed = parseAndValidateNdjson(fs.readFileSync(outFile, 'utf8'));
    expect(parsed.valid).toBe(true);
  });
});
