import { describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  AGY_NATIVE_MIGRATION_COMPONENT,
  AGY_NATIVE_MIGRATION_VERSION,
  NativeCanonicalEventSchema,
  NativeCaptureRecordV1Schema,
  NativeCommandRequestSchema,
  NativeControlRequestSchema,
  NativeRuntimeProjectionSchema,
  NativeSnapshotResponseSchema,
  NativeTimelineResponseSchema,
  NativeWorkflowResourceResponseSchema,
  NativeWsClientFrameSchema,
  NativeWsServerFrameSchema,
  ResolveNativeRequestInputSchema,
  RpcIdSchema,
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  asWorkId,
  asWorkflowId,
  createDefaultAgyCapabilityDescriptors,
  createKnownEmptyNativeProjection,
  createSampleNativeProjectionFixture,
  sanitizeAgentIdentityForPublic,
  sanitizeNativeRelationshipForPublic,
  sanitizeNativeWorkForPublic,
  sanitizeNativeWorkflowForPublic,
  toPublicEvidenceDto,
  type NativeRelationship,
  type NativeWork,
  type NativeWorkflow,
} from '../src/index.js';

describe('AGY Native v1 shared contracts (NP-02)', () => {
  it('exposes frozen version constants and validates branded opaque scopes & typed RpcId', () => {
    expect(AGY_NATIVE_CONTRACT_VERSION).toBe(1);
    expect(AGY_NATIVE_CONTRACT_REVISION).toBe('agy-native-v1.0.0');
    expect(AGY_NATIVE_MIGRATION_COMPONENT).toBe('agy-native-runtime');
    expect(AGY_NATIVE_MIGRATION_VERSION).toBe(1);

    expect(asRuntimeId('nrt_abc123')).toBe('nrt_abc123');
    expect(asActivityId('act_1')).toBe('act_1');
    expect(asWorkId('wrk_1')).toBe('wrk_1');
    expect(asNativeAgentId('agt_1')).toBe('agt_1');
    expect(asWorkflowId('wf_1')).toBe('wf_1');
    expect(asBindingGeneration('gen_1')).toBe('gen_1');

    expect(() => asRuntimeId('../escape')).toThrow();
    expect(() => asWorkId('')).toThrow();

    const numId = RpcIdSchema.parse(42);
    const strId = RpcIdSchema.parse('42');
    expect(typeof numId).toBe('number');
    expect(typeof strId).toBe('string');
    expect(RpcIdSchema.safeParse(1.5).success).toBe(false);
  });

  it('sanitizes internal evidence and entities via DTO allowlist without leaking private fields', () => {
    const liveEvidence = {
      kind: 'live_protocol' as const,
      connectionId: 'conn_secret_internal_123',
      ingressOrdinal: 7,
      wireVariant: 'acp_v1',
      observedAt: 1_764_000_000_000,
    };

    const publicEv = toPublicEvidenceDto(liveEvidence);
    expect(publicEv).toEqual({
      sourceKind: 'live_protocol',
      freshness: 'live',
      observedAt: 1_764_000_000_000,
    });
    expect('connectionId' in publicEv).toBe(false);

    const staleSnapEv = toPublicEvidenceDto(
      {
        kind: 'native_snapshot',
        sourceId: 'D:\\private\\path\\brain.db',
        schemaVersion: '1.5.16',
        observedAt: 1000,
        staleAt: 2000,
      },
      2500,
    );
    expect(staleSnapEv).toEqual({
      sourceKind: 'native_snapshot',
      freshness: 'stale',
      observedAt: 1000,
    });
    expect('sourceId' in staleSnapEv).toBe(false);

    const work: NativeWork = {
      id: asWorkId('wrk_1'),
      kind: 'finite_command',
      blocking: 'confirmed_blocking',
      state: { kind: 'known', value: 'running', evidence: liveEvidence },
      revision: 1,
    };
    const workDto = sanitizeNativeWorkForPublic(work);
    expect(JSON.stringify(workDto)).not.toContain('conn_secret_internal_123');

    // Prior-generation demotion produces stale DTO
    const priorGenWorkDto = sanitizeNativeWorkForPublic(work, 1_764_000_000_000, 'prior_generation_snapshot');
    expect(priorGenWorkDto.state.kind).toBe('stale');

    const agentDto = sanitizeAgentIdentityForPublic({
      id: asNativeAgentId('agt_1'),
      foreground: { kind: 'known', value: 'running', evidence: liveEvidence },
      launchWorkIds: [asWorkId('wrk_1')],
      lineage: 'confirmed',
      revision: 1,
    });
    expect(JSON.stringify(agentDto)).not.toContain('conn_secret_internal_123');

    const rel: NativeRelationship = {
      parentAgentId: asNativeAgentId('agt_root'),
      childAgentId: asNativeAgentId('agt_1'),
      confidence: 'protocol_confirmed',
      evidence: liveEvidence,
    };
    const relDto = sanitizeNativeRelationshipForPublic(rel);
    expect(relDto.evidence.sourceKind).toBe('live_protocol');
    expect('connectionId' in relDto.evidence).toBe(false);

    const wf: NativeWorkflow = {
      id: asWorkflowId('wf_1'),
      originActivityId: asActivityId('act_1'),
      state: { kind: 'known', value: 'running', evidence: liveEvidence },
      detail: {
        kind: 'swarm',
        coordinatorId: asNativeAgentId('agt_root'),
        workerIds: [asNativeAgentId('agt_1')],
        board: { kind: 'known', value: 'upstream_limited', evidence: liveEvidence },
      },
      revision: 1,
    };
    const wfDto = sanitizeNativeWorkflowForPublic(wf);
    expect(wfDto.detail.kind).toBe('swarm');
    expect(JSON.stringify(wfDto)).not.toContain('conn_secret_internal_123');
  });

  it('strictly validates permission resolution, command/control, timeline, workflow resource allowlist, and WS schemas', () => {
    const gen = asBindingGeneration('gen_1');
    const binding = {
      runtimeId: asRuntimeId('nrt_1'),
      sessionId: 'sess_1',
      instanceId: 'agy',
      generation: gen,
    };

    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'selected',
        optionId: 'allow_once',
      }).success,
    ).toBe(true);

    expect(
      ResolveNativeRequestInputSchema.safeParse({ generation: gen, outcome: 'selected' }).success,
    ).toBe(false);
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'selected',
        optionId: 'allow_once',
        formPayload: { answer: 'yes' },
      }).success,
    ).toBe(false);
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'form_submitted',
        formPayload: {},
      }).success,
    ).toBe(false);
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'cancelled',
        optionId: 'reject_once',
      }).success,
    ).toBe(false);

    expect(
      NativeCommandRequestSchema.safeParse({
        bindingGeneration: gen,
        catalogRevision: 1,
        capabilityId: 'agy.workflow.goal',
        actionKey: 'launch',
        idempotencyKey: 'idem_1',
        extraBadField: true,
      }).success,
    ).toBe(false);

    expect(
      NativeControlRequestSchema.safeParse({
        generation: gen,
        target: { type: 'work', id: 'wrk_1' },
        action: 'cancel',
        expectedRevision: 2,
        idempotencyKey: 'ctrl_1',
      }).success,
    ).toBe(true);

    // R4: Workflow resource DTO allowlist accepts typed items and REJECTS arbitrary debug / host path fields
    expect(
      NativeWorkflowResourceResponseSchema.safeParse({
        schemaVersion: 1,
        binding,
        workflowId: asWorkflowId('wf_1'),
        resource: 'board',
        revision: 1,
        available: true,
        items: [
          {
            kind: 'board_post',
            postId: 'post_1',
            summary: 'Coordinator update',
            truncated: false,
            createdAt: 1000,
            evidence: { sourceKind: 'live_protocol', freshness: 'live', observedAt: 1000 },
          },
        ],
        nextPageToken: null,
        hasMore: false,
      }).success,
    ).toBe(true);

    expect(
      NativeWorkflowResourceResponseSchema.safeParse({
        schemaVersion: 1,
        binding,
        workflowId: asWorkflowId('wf_1'),
        resource: 'board',
        revision: 1,
        available: true,
        items: [{ debugPath: 'C:\\Users\\secret\\token.json', rawPayload: { secret: true } }],
        nextPageToken: null,
        hasMore: false,
      }).success,
    ).toBe(false);

    // R6: NP-03 aligned timeline & snapshot envelopes
    expect(
      NativeTimelineResponseSchema.safeParse({
        schemaVersion: 1,
        binding,
        scopeKind: 'activity',
        scopeId: 'act_1',
        revision: 1,
        items: [],
        nextPageToken: null,
        hasMore: false,
      }).success,
    ).toBe(true);

    expect(
      NativeCanonicalEventSchema.safeParse({
        schemaVersion: 1,
        runtimeId: 'nrt_1',
        sessionId: 'sess_1',
        generation: 'gen_1',
        seq: 1,
        turnId: null,
        createdAt: 1000,
        type: 'native.runtime.changed',
        payload: {
          status: 'attached',
          retentionReasons: ['finite_work:wrk_1'],
          revision: 1,
        },
      }).success,
    ).toBe(true);

    expect(
      NativeWsClientFrameSchema.safeParse({
        op: 'subscribe_native',
        schemaVersion: 1,
        afterSeq: 0,
      }).success,
    ).toBe(true);

    expect(
      NativeWsServerFrameSchema.safeParse({
        op: 'native_resync_required',
        schemaVersion: 1,
        code: 'RESYNC_REQUIRED',
        reason: 'stale_cursor_generation',
        latestSeq: 5,
        currentGeneration: 'gen_2',
      }).success,
    ).toBe(true);
  });

  it('validates all NP-01 capture-v1 Windows sanitized record shapes and rejects malformed records (R6)', () => {
    const np01WindowsCleanV1Samples = [
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: null,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595202371,
        producer: 'observatory_cli',
        seq: 1,
        monotonicMs: 4.15,
        layer: 'raw',
        direction: 'lifecycle',
        messageKind: 'capture_meta',
        provenance: {
          origin: 'live_windows_agy_clean_unauthenticated',
          migratedFrom: null,
          timingSynthetic: false,
          notes: 'Captured via NP-01 observatory CLI v0.2 with allowlist reconstruction',
        },
        correlation: {
          connectionId: 'conn-1',
          ingressOrdinal: 0,
          channel: 'live',
          diagnosticCode: 'AGY-DIAG-v1:cap-20261125082642-c74e32:clean_v1:conn-1:gen-0:live:0:s1:raw:capture_start',
        },
        shape: { profileSource: 'ephemeral', requestedProtocol: 1 },
      },
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: null,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595204037,
        producer: 'observatory_cli',
        seq: 2,
        monotonicMs: 1670.56,
        layer: 'raw',
        direction: 'lifecycle',
        messageKind: 'cli_catalog',
        correlation: { connectionId: 'conn-1', ingressOrdinal: 0, channel: 'live' },
        shape: { command: 'models', exitCode: 1 },
      },
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: 1,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595206891,
        producer: 'observatory_cli',
        seq: 5,
        monotonicMs: 4521.43,
        layer: 'raw',
        direction: 'inbound',
        messageKind: 'rpc_response',
        latencyMs: 730.3,
        correlation: {
          connectionId: 'conn-1',
          ingressOrdinal: 1,
          channel: 'live',
          rpcIdAlias: 'rpc-1',
          rpcIdType: 'number',
        },
        shape: { jsonrpc: '2.0', protocolVersion: 1 },
      },
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: 1,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595207146,
        producer: 'observatory_cli',
        seq: 7,
        monotonicMs: 4776.14,
        layer: 'raw',
        direction: 'inbound',
        messageKind: 'rpc_error',
        latencyMs: 250.65,
        correlation: {
          connectionId: 'conn-1',
          ingressOrdinal: 2,
          channel: 'live',
          rpcIdAlias: 'rpc-2',
          rpcIdType: 'number',
        },
        shape: { error: { code: -32000, authenticationRequired: true } },
      },
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: 1,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595208688,
        producer: 'observatory_cli',
        seq: 8,
        monotonicMs: 6321.57,
        layer: 'raw',
        direction: 'lifecycle',
        messageKind: 'process_exit',
        correlation: { connectionId: 'conn-1', ingressOrdinal: 0, channel: 'live' },
        shape: { exitCode: 0, signal: null },
      },
      {
        schemaVersion: 1,
        captureId: 'cap-20261125082642-c74e32',
        scenario: 'clean_v1',
        platform: 'win32',
        cliVersion: '1.5.17',
        protocol: 1,
        accountCategory: 'none',
        source: 'live_raw',
        observedAt: 1795595208690,
        producer: 'observatory_cli',
        seq: 9,
        monotonicMs: 6323.19,
        layer: 'raw',
        direction: 'lifecycle',
        messageKind: 'capture_end',
        correlation: { connectionId: 'conn-1', ingressOrdinal: 0, channel: 'live' },
        shape: { outcome: 'expected_auth_required', negotiatedProtocol: 1 },
      },
    ];

    for (const rec of np01WindowsCleanV1Samples) {
      expect(NativeCaptureRecordV1Schema.safeParse(rec).success).toBe(true);
    }

    // Strict schema rejects shape as string, extra provenance key, and numeric correlation.generation
    expect(
      NativeCaptureRecordV1Schema.safeParse({ ...np01WindowsCleanV1Samples[0], shape: 'bad' }).success,
    ).toBe(false);
    expect(
      NativeCaptureRecordV1Schema.safeParse({
        ...np01WindowsCleanV1Samples[0],
        provenance: { ...np01WindowsCleanV1Samples[0]!.provenance, extraLeak: 'nope' },
      }).success,
    ).toBe(false);
    expect(
      NativeCaptureRecordV1Schema.safeParse({
        ...np01WindowsCleanV1Samples[0],
        correlation: { ...np01WindowsCleanV1Samples[0]!.correlation, generation: 123 },
      }).success,
    ).toBe(false);
  });

  it('produces valid Known Empty, NP-03 sample fixture, wrapped snapshot, and honest default capabilities', () => {
    const empty = createKnownEmptyNativeProjection({
      sessionId: 'sess_empty',
      instanceId: 'agy',
    });
    expect(NativeRuntimeProjectionSchema.parse(empty).enabled).toBe(false);
    expect(
      NativeSnapshotResponseSchema.parse({
        schemaVersion: 1,
        contractRevision: AGY_NATIVE_CONTRACT_REVISION,
        enabled: false,
        projection: empty,
      }).projection.asOfSeq,
    ).toBe(0);

    const sample = createSampleNativeProjectionFixture();
    expect(NativeRuntimeProjectionSchema.parse(sample).enabled).toBe(true);
    expect(sample.activities).toHaveLength(1);
    expect(sample.work).toHaveLength(1);
    expect(sample.agents).toHaveLength(2);
    expect(sample.requests).toHaveLength(1);

    const caps = createDefaultAgyCapabilityDescriptors(0);
    expect(caps.length).toBeGreaterThanOrEqual(8);
    for (const desc of caps) {
      expect(desc.launch).toBe('not_tested');
      expect(desc.observe).toBe('not_tested');
      expect(desc.control).toBe('not_tested');
      expect(desc.verifiedLevel).toBeNull();
    }
  });
});
