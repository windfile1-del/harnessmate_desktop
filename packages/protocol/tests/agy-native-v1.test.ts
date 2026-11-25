import { describe, expect, it } from 'vitest';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  AGY_NATIVE_MIGRATION_COMPONENT,
  AGY_NATIVE_MIGRATION_VERSION,
  NativeCanonicalEventSchema,
  NativeCaptureMetadataSchema,
  NativeCommandRequestSchema,
  NativeControlRequestSchema,
  NativeRuntimeProjectionSchema,
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

    // RpcId preserves string vs number types
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

  it('strictly validates permission resolution, command/control inputs, and WS/capture schemas', () => {
    const gen = asBindingGeneration('gen_1');

    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'selected',
        optionId: 'allow_once',
      }).success,
    ).toBe(true);

    // Reject missing optionId on selected
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'selected',
      }).success,
    ).toBe(false);

    // Reject mixing optionId + formPayload
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'selected',
        optionId: 'allow_once',
        formPayload: { answer: 'yes' },
      }).success,
    ).toBe(false);

    // Reject empty formPayload on form_submitted
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'form_submitted',
        formPayload: {},
      }).success,
    ).toBe(false);

    // Reject optionId on cancelled
    expect(
      ResolveNativeRequestInputSchema.safeParse({
        generation: gen,
        outcome: 'cancelled',
        optionId: 'reject_once',
      }).success,
    ).toBe(false);

    // Reject unknown fields (strict)
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

    expect(
      NativeCaptureMetadataSchema.safeParse({
        schemaVersion: 1,
        captureId: 'cap_01',
        scenario: 'T02',
        platform: 'win32',
        cliVersion: '1.5.16',
        protocol: 'acp_v1',
        accountCategory: 'personal_test',
        source: 'synthetic',
        observedAt: 1_764_000_000_000,
        producer: 'np01-observatory',
        seq: 1,
        monotonicMs: 12.5,
        direction: 'in',
        messageKind: 'notification',
      }).success,
    ).toBe(true);
  });

  it('produces valid Known Empty, NP-03 sample fixture, and honest default capabilities', () => {
    const empty = createKnownEmptyNativeProjection({
      sessionId: 'sess_empty',
      instanceId: 'agy',
    });
    expect(NativeRuntimeProjectionSchema.parse(empty).enabled).toBe(false);
    expect(empty.activities).toEqual([]);
    expect(empty.asOfSeq).toBe(0);

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
