import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  asWorkId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { HarnessMateStore } from '../src/db/sqlite.js';
import {
  listAgySubagentRecords,
  readAgySubagentDetail,
} from '../src/harnesses/agy/agy-child-work.js';
import {
  CHILD_SCOPE_CONTRACT_REVISION,
  ChildSessionRouter,
  createFrozenChildScopeResolverStub,
  decideAcpChildClientCapabilities,
  parseVersionedChildRecordPayload,
  readChildOwnedTranscriptOnly,
  redactPrivateChildText,
  scanVersionedChildRecords,
} from '../src/harnesses/agy/native/child/index.js';
import { AgyNativeRuntimeRegistry } from '../src/harnesses/agy/native/wiring/index.js';

const tempDirs: string[] = [];
const openStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeBinding(overrides?: Partial<RuntimeBinding>): RuntimeBinding {
  return {
    runtimeId: asRuntimeId(overrides?.runtimeId ?? 'nrt_np05_01'),
    sessionId: overrides?.sessionId ?? 'sess_np05_01',
    instanceId: overrides?.instanceId ?? 'agy_inst_a',
    generation: asBindingGeneration(overrides?.generation ?? 'gen_1'),
  };
}

afterEach(() => {
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

describe('NP-05 shared child scope contract (NP-05 <-> NP-07) & ACP capability gate [synthetic]', () => {
  it('enforces shared ChildScopeResolution signature on frozen stub for direct, parent-forwarded, unresolved, and rejected scopes (T06/T07)', () => {
    const binding = makeBinding();
    const rootAgentId = asNativeAgentId('agt_root_stub');
    const childAgentId = asNativeAgentId('agt_child_stub_1');
    const launchWorkId = asWorkId('wrk_launch_stub_1');

    const stub = createFrozenChildScopeResolverStub({
      expectedBinding: binding,
      expectedProfileRef: 'profile_a',
      rootAgentId,
      confirmedChildrenByWireSessionId: new Map([
        [
          'native_child_sess_1',
          {
            agentId: childAgentId,
            launchWorkId,
            capabilities: { canObserveLiveStream: true, canCancel: true },
          },
        ],
      ]),
      forwardedChildrenByToolCallId: new Map([
        [
          'tc_launch_1',
          {
            agentId: childAgentId,
            launchWorkId,
            capabilities: { canObserveLiveStream: true, canCancel: false },
          },
        ],
      ]),
    });

    expect(stub.contractRevision).toBe(CHILD_SCOPE_CONTRACT_REVISION);

    // 1. Direct confirmed child wire session
    const direct = stub.resolveScope({
      binding,
      wireSessionId: 'native_child_sess_1',
      rootNativeSessionId: 'native_root_sess',
      profileRef: 'profile_a',
    });
    expect(direct.matchKind).toBe('confirmed_child');
    expect(direct.actualWireSessionId).toBe('native_child_sess_1');
    expect(direct.forwardedViaParent).toBe(false);
    expect(direct.targetAgentId).toBe(childAgentId);
    expect(direct.displayOwnerAgentId).toBe(childAgentId);
    expect(direct.allowConfirmedChildAttribution).toBe(true);
    expect(direct.rejectRequest).toBe(false);
    expect(direct.capabilities.canSteer).toBe(false);
    expect(direct.capabilities.canLoadDirect).toBe(false);

    // 2. Parent-forwarded request (AGY 1.5.16+): wire target stays parent, displayOwner is inferred child
    const forwarded = stub.resolveScope({
      binding,
      wireSessionId: 'native_root_sess',
      rootNativeSessionId: 'native_root_sess',
      toolCallId: 'tc_launch_1',
      profileRef: 'profile_a',
    });
    expect(forwarded.matchKind).toBe('forwarded_parent_with_inferred_child');
    expect(forwarded.actualWireSessionId).toBe('native_root_sess');
    expect(forwarded.forwardedViaParent).toBe(true);
    expect(forwarded.targetAgentId).toBe(rootAgentId);
    expect(forwarded.displayOwnerAgentId).toBe(childAgentId);
    expect(forwarded.allowConfirmedChildAttribution).toBe(true);
    expect(forwarded.rejectRequest).toBe(false);

    // 3. Unknown non-root wire session stays unresolved (never impersonates parent)
    const unknown = stub.resolveScope({
      binding,
      wireSessionId: 'native_unknown_999',
      rootNativeSessionId: 'native_root_sess',
      profileRef: 'profile_a',
    });
    expect(unknown.matchKind).toBe('unresolved_child');
    expect(unknown.actualWireSessionId).toBe('native_unknown_999');
    expect(unknown.allowConfirmedChildAttribution).toBe(false);
    expect(unknown.lineage).toBe('unresolved');

    // 4. Stale generation & cross-profile are rejected
    const staleGen = stub.resolveScope({
      binding: makeBinding({ generation: 'gen_old' }),
      wireSessionId: 'native_child_sess_1',
      rootNativeSessionId: 'native_root_sess',
      profileRef: 'profile_a',
    });
    expect(staleGen.matchKind).toBe('rejected_scope');
    expect(staleGen.rejectRequest).toBe(true);

    const wrongProfile = stub.resolveScope({
      binding,
      wireSessionId: 'native_child_sess_1',
      rootNativeSessionId: 'native_root_sess',
      profileRef: 'profile_b',
    });
    expect(wrongProfile.matchKind).toBe('rejected_scope');
    expect(wrongProfile.rejectRequest).toBe(true);

    // 5. Cancel authorization strictly checks child.capabilities.canCancel
    expect(stub.authorizeChildCancel(binding, childAgentId).allowed).toBe(true);
    expect(stub.authorizeChildCancel(makeBinding({ generation: 'gen_old' }), childAgentId).allowed).toBe(false);
  });

  it('declares ACP subagent client extension ONLY when full child routing is wired', () => {
    expect(
      decideAcpChildClientCapabilities({
        featureEnabled: false,
        childRoutingWired: true,
        permissionScopeResolverWired: true,
        timelineBufferWired: true,
        protocolVersion: 1,
      }).declareSubagentExtension,
    ).toBe(false);

    expect(
      decideAcpChildClientCapabilities({
        featureEnabled: true,
        childRoutingWired: true,
        permissionScopeResolverWired: false,
        timelineBufferWired: true,
        protocolVersion: 1,
      }).declareSubagentExtension,
    ).toBe(false);

    expect(
      decideAcpChildClientCapabilities({
        featureEnabled: true,
        childRoutingWired: true,
        permissionScopeResolverWired: true,
        timelineBufferWired: true,
        protocolVersion: 2,
        acpV2PreviewEnabled: false,
      }).declareSubagentExtension,
    ).toBe(false);

    const v1Ready = decideAcpChildClientCapabilities({
      featureEnabled: true,
      childRoutingWired: true,
      permissionScopeResolverWired: true,
      timelineBufferWired: true,
      protocolVersion: 1,
    });
    expect(v1Ready.declareSubagentExtension).toBe(true);
    expect(v1Ready.clientCapabilitiesPatch).toEqual({ experimental: { subagents: true } });
  });
});

describe('NP-05 ChildSessionRouter identity, lineage, buffers, dedup, and scope isolation [synthetic]', () => {
  it('handles two identical roles with distinct native IDs, nested child, child idle->reactivation, and unconfirmed launch evidence (T07)', () => {
    let clock = 1_764_000_000_000;
    const router = new ChildSessionRouter({ now: () => ++clock });
    const binding = makeBinding();
    const { rootAgentId } = router.registerBinding({
      binding,
      rootNativeSessionId: 'root_conv_1',
      profileRef: 'profile_main',
      sourceRef: 'acp',
      connectionId: 'conn_1',
    });

    // Launch 1 & Launch 2 share the EXACT SAME Role ("Codebase Researcher")
    const l1 = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 1,
      channel: 'live',
      originSession: 'root_conv_1',
      wire: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_sub_1',
        title: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { Role: 'Codebase Researcher', TypeName: 'research' },
      },
    });
    const l2 = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 2,
      channel: 'live',
      originSession: 'root_conv_1',
      wire: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_sub_2',
        title: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { Role: 'Codebase Researcher', TypeName: 'research' },
      },
    });
    // Launch 3 has insufficient correlation evidence (never announced) -> must stay unresolved
    const l3 = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 3,
      channel: 'live',
      originSession: 'root_conv_1',
      wire: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_sub_unresolved',
        title: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { Role: 'Codebase Researcher', TypeName: 'research' },
      },
    });

    expect(l1.accepted && l2.accepted && l3.accepted).toBe(true);
    expect(l1.affectedWorkIds[0]).not.toBe(l2.affectedWorkIds[0]);

    // Before child announcement, all three are unresolved with zero confirmed relations
    const beforeSnap = router.getStateSnapshot(binding)!;
    expect(beforeSnap.relations).toHaveLength(0);
    expect(beforeSnap.agents.filter((a) => a.lineage === 'unresolved')).toHaveLength(3);

    // Unresolved launch cannot be cancelled and has no timeline
    const unresolvedAgentId = l3.affectedAgentIds[0]!;
    expect(router.authorizeChildCancel(binding, unresolvedAgentId).allowed).toBe(false);
    expect(
      router.readTimeline({ binding, scopeKind: 'agent', scopeId: unresolvedAgentId, limit: 20 })
        .sourceUnavailableReason,
    ).toBe('child_lineage_unconfirmed');

    // Confirm child A (linked to tc_sub_1, advertises cancel=true) and child B (linked to tc_sub_2, cancel=false)
    const annA = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 4,
      channel: 'live',
      originSession: 'root_conv_1',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'root_conv_1',
        childSessionId: 'child_conv_A',
        launchToolCallId: 'tc_sub_1',
        role: 'Codebase Researcher',
        state: 'running',
        capabilities: { cancel: true },
      },
    });
    const annB = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 5,
      channel: 'live',
      originSession: 'root_conv_1',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'root_conv_1',
        childSessionId: 'child_conv_B',
        launchToolCallId: 'tc_sub_2',
        role: 'Codebase Researcher',
        state: 'running',
        capabilities: { cancel: false },
      },
    });

    const childAId = annA.affectedAgentIds[0]!;
    const childBId = annB.affectedAgentIds[0]!;
    expect(childAId).not.toBe(childBId);
    expect(childAId).not.toBe(rootAgentId);

    // Child A advertises cancel; Child B does NOT -> cancel authorization strictly follows child.capabilities
    const cancelA = router.authorizeChildCancel(binding, childAId);
    expect(cancelA.allowed).toBe(true);
    expect(cancelA.wireSessionId).toBe('child_conv_A');
    expect(router.authorizeChildCancel(binding, childBId).allowed).toBe(false);

    // Independent child timelines (plus verify repeated identical text chunks without stable ID are NOT swallowed!)
    router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 6,
      channel: 'live',
      originSession: 'child_conv_A',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } },
    });
    router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 7,
      channel: 'live',
      originSession: 'child_conv_A',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } },
    });
    router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 8,
      channel: 'live',
      originSession: 'child_conv_B',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'Child B analysis' } },
    });

    const tlA = router.readTimeline({ binding, scopeKind: 'agent', scopeId: childAId, limit: 20 });
    const tlB = router.readTimeline({ binding, scopeKind: 'agent', scopeId: childBId, limit: 20 });
    expect(tlA.items.map((i) => i.text)).toEqual(['ok', 'ok']);
    expect(tlB.items.map((i) => i.text)).toEqual(['Child B analysis']);

    // Child A transitions to IDLE -> must NOT be treated as finished/succeeded, and re-running reactivates cleanly!
    router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 9,
      channel: 'live',
      originSession: 'child_conv_A',
      wire: { sessionUpdate: 'subagent_state_update', state: 'idle' },
    });
    const idleChildA = router.getStateSnapshot(binding)!.agents.find((a) => a.id === childAId)!;
    expect(idleChildA.foreground).toMatchObject({ kind: 'known', value: 'idle' });
    expect(idleChildA.status).toMatchObject({ kind: 'known', value: 'waiting' });

    router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 10,
      channel: 'live',
      originSession: 'child_conv_A',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'Resumed after idle' } },
    });
    const rerunChildA = router.getStateSnapshot(binding)!.agents.find((a) => a.id === childAId)!;
    expect(rerunChildA.id).toBe(childAId);
    expect(rerunChildA.foreground).toMatchObject({ kind: 'known', value: 'running' });

    // Nested grandchild under child A (`root -> childA -> grandchildA1`)
    const annGrandchild = router.acceptFrame({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 11,
      channel: 'live',
      originSession: 'child_conv_A',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'child_conv_A',
        childSessionId: 'grandchild_conv_A1',
        role: 'Verifier',
        state: 'running',
      },
    });
    const grandchildId = annGrandchild.affectedAgentIds[0]!;
    const rels = router.getStateSnapshot(binding)!.relations;
    expect(rels.find((r) => r.childAgentId === grandchildId)?.parentAgentId).toBe(childAId);
    expect(rels.find((r) => r.childAgentId === childAId)?.parentAgentId).toBe(rootAgentId);

    // Parent/Child permission scope resolution (T06):
    // Forwarded via parent with tc_sub_1 -> wire target is root_conv_1, displayOwner is childAId
    const fwdScope = router.resolveScope({
      binding,
      wireSessionId: 'root_conv_1',
      rootNativeSessionId: 'root_conv_1',
      toolCallId: 'tc_sub_1',
      profileRef: 'profile_main',
      sourceRef: 'acp',
      connectionId: 'conn_1',
    });
    expect(fwdScope.matchKind).toBe('forwarded_parent_with_inferred_child');
    expect(fwdScope.actualWireSessionId).toBe('root_conv_1');
    expect(fwdScope.forwardedViaParent).toBe(true);
    expect(fwdScope.targetAgentId).toBe(rootAgentId);
    expect(fwdScope.displayOwnerAgentId).toBe(childAId);

    // Forwarded via parent with unresolved tc_sub_unresolved -> stays unresolved_child!
    const unresolvedFwd = router.resolveScope({
      binding,
      wireSessionId: 'root_conv_1',
      rootNativeSessionId: 'root_conv_1',
      toolCallId: 'tc_sub_unresolved',
      profileRef: 'profile_main',
      sourceRef: 'acp',
      connectionId: 'conn_1',
    });
    expect(unresolvedFwd.matchKind).toBe('unresolved_child');
    expect(unresolvedFwd.allowConfirmedChildAttribution).toBe(false);
    expect(unresolvedFwd.actualWireSessionId).toBe('root_conv_1');
  });

  it('rejects cycles, multi-parent conflicts, cross-profile frames, and stale generations; buffers & drains unowned frames boundedly', () => {
    const router = new ChildSessionRouter({
      limits: { maxUnownedFrames: 3, maxTimelineEntriesPerAgent: 4 },
    });
    const binding = makeBinding();
    router.registerBinding({
      binding,
      rootNativeSessionId: 'root_1',
      profileRef: 'prof_1',
      sourceRef: 'acp',
      connectionId: 'conn_a',
    });

    // Unowned frames arrive BEFORE child announcement -> buffered up to cap 3 (oldest dropped)
    for (let ord = 1; ord <= 4; ord++) {
      const res = router.acceptFrame({
        binding,
        connectionId: 'conn_a',
        ingressOrdinal: ord,
        channel: 'live',
        originSession: 'child_early',
        wire: { sessionUpdate: 'agent_message_chunk', content: { text: `early-${ord}` } },
      });
      expect(res.buffered).toBe(true);
    }
    expect(router.getStateSnapshot(binding)!.unownedBufferedCount).toBe(3);

    // Duplicate ingress ordinal is ignored
    const dup = router.acceptFrame({
      binding,
      connectionId: 'conn_a',
      ingressOrdinal: 4,
      channel: 'live',
      originSession: 'child_early',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'early-4' } },
    });
    expect(dup.deduplicated).toBe(true);

    // Verified announcement arrives -> drains buffered frames 2, 3, 4 in order
    const ann = router.acceptFrame({
      binding,
      connectionId: 'conn_a',
      ingressOrdinal: 5,
      channel: 'live',
      originSession: 'root_1',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'root_1',
        childSessionId: 'child_early',
        state: 'running',
        capabilities: { cancel: true },
      },
    });
    const childId = ann.affectedAgentIds[0]!;
    expect(router.getStateSnapshot(binding)!.unownedBufferedCount).toBe(0);
    const tl = router.readTimeline({ binding, scopeKind: 'agent', scopeId: childId, limit: 10 });
    expect(tl.items.map((i) => i.text)).toEqual(['early-2', 'early-3', 'early-4']);

    // Add second confirmed child B under child_early
    const annB = router.acceptFrame({
      binding,
      connectionId: 'conn_a',
      ingressOrdinal: 6,
      channel: 'live',
      originSession: 'child_early',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'child_early',
        childSessionId: 'child_b',
        state: 'running',
      },
    });
    const childBId = annB.affectedAgentIds[0]!;
    expect(annB.accepted).toBe(true);

    // Ancestor cycle attempt: make child_b the parent of child_early -> REJECTED + conflicting + cancel revoked!
    const cycle = router.acceptFrame({
      binding,
      connectionId: 'conn_a',
      ingressOrdinal: 7,
      channel: 'live',
      originSession: 'child_b',
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'child_b',
        childSessionId: 'child_early',
        state: 'running',
      },
    });
    expect(cycle.accepted).toBe(false);
    expect(cycle.diagnostic?.code).toBe('relation_parent_conflict_rejected');
    expect(router.authorizeChildCancel(binding, childId).allowed).toBe(false);
    expect(
      router.resolveScope({
        binding,
        wireSessionId: 'child_early',
        rootNativeSessionId: 'root_1',
        profileRef: 'prof_1',
      }).matchKind,
    ).toBe('conflicting_child');

    // Cross-profile ingress frame rejected
    const crossProf = router.acceptFrame(
      {
        binding,
        connectionId: 'conn_a',
        ingressOrdinal: 8,
        channel: 'live',
        originSession: 'child_b',
        wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'hijack' } },
      },
      { profileRef: 'prof_other' },
    );
    expect(crossProf.accepted).toBe(false);
    expect(crossProf.diagnostic?.code).toBe('cross_profile_rejected');

    // Generation rotation / restart marks old generation stale & historical while keeping history readable
    const gen2 = makeBinding({ generation: 'gen_2' });
    router.registerBinding({
      binding: gen2,
      rootNativeSessionId: 'root_1',
      profileRef: 'prof_1',
      sourceRef: 'acp',
      connectionId: 'conn_b',
    });

    const staleWrite = router.acceptFrame({
      binding,
      connectionId: 'conn_a',
      ingressOrdinal: 9,
      channel: 'live',
      originSession: 'child_b',
      wire: { sessionUpdate: 'agent_message_chunk', content: { text: 'late-from-gen1' } },
    });
    expect(staleWrite.accepted).toBe(false);
    expect(staleWrite.diagnostic?.code).toBe('stale_generation_rejected');

    const histSnap = router.getStateSnapshot(binding)!;
    expect(histSnap.isHistorical).toBe(true);
    expect(histSnap.agents.find((a) => a.id === childBId)?.foreground.kind).toBe('stale');
    expect(router.authorizeChildCancel(binding, childBId).allowed).toBe(false);
  });
});

describe('NP-05 versioned E06/CLI read-only parser, no parent transcript fallback, Windows reparse & privacy (T15 / R-05) [synthetic]', () => {
  it('parses E06 real App app_v1 records and cli_legacy_v0, rejects unknown/future schemas, caps scans, and NEVER falls back to parent transcript', () => {
    const tmp = makeTempDir('hm-np05-records-');
    const appDataPath = path.join(tmp, 'antigravity');
    const subDir = path.join(appDataPath, 'brain', 'parent_sess_1', '.system_generated', 'subagents');
    const logsDir = path.join(appDataPath, 'brain', 'parent_sess_1', '.system_generated', 'logs');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Parent transcript exists — MUST NEVER be returned as a child's transcript!
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      '{"role":"parent","text":"PRIVATE PARENT SECRET TRANSCRIPT"}\n',
      'utf8',
    );

    // 1. Real E06 App shape (app_v1): no sibling JSONL
    fs.writeFileSync(
      path.join(subDir, 'rec_app_1.json'),
      JSON.stringify({
        conversationId: 'conv_child_app_01',
        subagentDescriptor: {
          role: 'Codebase Researcher',
          typeName: 'research',
          summary: 'Inspected C:\\Users\\alice\\secret\\repo.ts with Bearer secret_token_123456',
        },
        state: 'idle',
        spawnStepIndex: 4,
        workspaceUris: ['file:///C:/Users/alice/secret/repo'],
      }),
      'utf8',
    );

    // 2. Legacy CLI shape (cli_legacy_v0) with sibling child JSONL
    fs.writeFileSync(
      path.join(subDir, 'rec_cli_1.json'),
      JSON.stringify({
        id: 'rec_cli_1',
        role: 'Verifier',
        typeName: 'verifier',
        status: 'running',
        summary: 'Checking test suite',
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(subDir, 'rec_cli_1.jsonl'),
      '{"step":1,"msg":"child own log"}\n',
      'utf8',
    );

    // 3. Unknown future schema version -> MUST fail closed
    fs.writeFileSync(
      path.join(subDir, 'rec_future.json'),
      JSON.stringify({
        schemaVersion: 99,
        conversationId: 'conv_future',
        subagentDescriptor: { role: 'Future' },
        state: 'running',
        spawnStepIndex: 1,
        workspaceUris: [],
      }),
      'utf8',
    );

    // 4. Unknown unrecognized shape -> MUST fail closed
    fs.writeFileSync(
      path.join(subDir, 'rec_unknown.json'),
      JSON.stringify({ arbitrary: true, unexpectedField: 42 }),
      'utf8',
    );

    const scan = scanVersionedChildRecords(appDataPath, 'parent_sess_1', {
      nowMs: 1_764_000_000_000,
      staleTtlMs: 30_000,
    });
    expect(scan.records).toHaveLength(2);
    expect(scan.rejected.map((r) => r.reasonCode).sort()).toEqual([
      'unknown_record_schema',
      'unsupported_schema_version',
    ]);

    const appRec = scan.records.find((r) => r.recordId === 'rec_app_1')!;
    expect(appRec.schemaVersion).toBe('app_v1');
    expect(appRec.conversationId).toBe('conv_child_app_01');
    expect(appRec.spawnStepIndex).toBe(4);
    expect(appRec.foreground).toBe('idle');
    expect(appRec.workState).toBe('waiting'); // idle != finished
    // Privacy redaction: raw Windows path and Bearer token stripped!
    expect(appRec.summary).not.toContain('alice');
    expect(appRec.summary).not.toContain('secret_token_123456');
    expect(appRec.summary).toContain('[REDACTED]');

    // Legacy wrapper `readAgySubagentDetail` NEVER falls back to parent transcript!
    const appDetail = readAgySubagentDetail(appDataPath, 'parent_sess_1', 'rec_app_1');
    expect(appDetail).not.toBeNull();
    expect(appDetail?.transcriptLines).toEqual([]);
    expect(appDetail?.transcriptSource).toBe('unavailable');
    expect(appDetail?.sourceUnavailableReason).toBe('child_transcript_not_present');
    expect(appDetail?.rawText).toBeUndefined();

    // Child WITH its own sibling JSONL returns ONLY its own lines
    const cliDetail = readAgySubagentDetail(appDataPath, 'parent_sess_1', 'rec_cli_1');
    expect(cliDetail?.transcriptSource).toBe('child_jsonl');
    expect(cliDetail?.transcriptLines).toEqual(['{"step":1,"msg":"child own log"}']);

    // Legacy `listAgySubagentRecords` sees both valid schemas and excludes rejected unknown/future ones
    const listed = listAgySubagentRecords(appDataPath, 'parent_sess_1');
    expect(listed.map((r) => r.id).sort()).toEqual(['rec_app_1', 'rec_cli_1']);

    // Schema gate disablement: disabling all schemas returns empty with disabled reason
    const disabledScan = scanVersionedChildRecords(appDataPath, 'parent_sess_1', {
      supportedSchemas: [],
    });
    expect(disabledScan.records).toHaveLength(0);
    expect(disabledScan.readerDisabledReason).toBe('reader_disabled_by_schema_gate');

    // Directory scan cap enforcement
    const cappedScan = scanVersionedChildRecords(appDataPath, 'parent_sess_1', {
      maxFilesPerDir: 1,
    });
    expect(cappedScan.scannedFileCount).toBe(1);
    expect(cappedScan.truncatedDirectoryScan).toBe(true);

    // Deeply nested adversarial JSON rejected
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const deepRes = parseVersionedChildRecordPayload({
      recordId: 'deep',
      raw: deep,
      truncated: false,
      observedAt: 1000,
      staleAt: 2000,
      sourceId: 'test',
      supportedSchemas: ['app_v1', 'cli_legacy_v0'],
      maxJsonDepth: 8,
    });
    expect(deepRes.ok).toBe(false);
    if (!deepRes.ok) expect(deepRes.reasonCode).toBe('json_depth_exceeded');
  });

  it('rejects Windows junctions / symlinks and path traversal while redacting private strings', () => {
    const tmp = makeTempDir('hm-np05-reparse-');
    const outsideDir = path.join(tmp, 'outside');
    const appDataPath = path.join(tmp, 'antigravity');
    const subDir = path.join(appDataPath, 'brain', 'sess_safe', '.system_generated', 'subagents');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    const outsideFile = path.join(outsideDir, 'secret.json');
    fs.writeFileSync(
      outsideFile,
      JSON.stringify({ id: 'escaped', role: 'Evil', status: 'running' }),
      'utf8',
    );

    // Traversal attempt rejected
    expect(readAgySubagentDetail(appDataPath, 'sess_safe', '../escape')).toBeNull();
    expect(readChildOwnedTranscriptOnly(appDataPath, 'sess_safe', '../logs/transcript').available).toBe(
      false,
    );

    // Directory junction / symlink escape attempt: replace `subagents` with a junction pointing outside!
    const junctionParent = path.join(appDataPath, 'brain', 'sess_junc', '.system_generated');
    fs.mkdirSync(junctionParent, { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    let linkCreated = false;
    try {
      fs.symlinkSync(outsideDir, path.join(junctionParent, 'subagents'), linkType);
      linkCreated = true;
    } catch {
      // Some restricted environments may disallow symlink creation; skip symlink-only assertion if OS denies
    }
    if (linkCreated) {
      const scan = scanVersionedChildRecords(appDataPath, 'sess_junc');
      expect(scan.records).toHaveLength(0);
    }

    // Privacy redactor test
    const redacted = redactPrivateChildText(
      'Failed reading file:///C:/Users/bob/.gemini/oauth_creds.json access_token=ya29.secret_xyz',
    );
    expect(redacted).not.toContain('bob');
    expect(redacted).not.toContain('ya29.secret_xyz');
  });

  it('integrates ChildSessionRouter snapshot + live ingestion with real SQLite AgyNativeRuntimeRegistry without leaking private fields', () => {
    const tmp = makeTempDir('hm-np05-sqlite-');
    const dbPath = path.join(tmp, 'hm.sqlite');
    const appDataPath = path.join(tmp, 'antigravity');
    const subDir = path.join(appDataPath, 'brain', 'root_sql_1', '.system_generated', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'snap_child_1.json'),
      JSON.stringify({
        conversationId: 'private_conv_secret_001',
        subagentDescriptor: { role: 'App Snapshot Worker' },
        state: 'running',
        spawnStepIndex: 2,
        workspaceUris: ['file:///D:/private/workspace'],
      }),
      'utf8',
    );

    const store = new HarnessMateStore(dbPath);
    openStores.push(store);
    store.createWorkspace({
      id: 'ws_np05',
      name: 'NP05 WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: 1000,
    });
    store.createSession({
      id: 'sess_np05_sql',
      workspaceId: 'ws_np05',
      harnessId: 'agy',
      harnessKind: 'agy',
      nativeSessionId: 'root_sql_1',
      cwd: tmp,
      worktreeBranch: null,
      title: 'NP05 SQLite Test',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const registry = new AgyNativeRuntimeRegistry(store, { enabled: true });
    const storedBinding = registry.ensureRuntimeBinding({
      sessionId: 'sess_np05_sql',
      instanceId: 'agy',
      profileRef: 'prof_sql',
      sourceRef: 'desktop',
      status: 'attached',
    });
    const binding: RuntimeBinding = {
      runtimeId: storedBinding.runtimeId,
      sessionId: storedBinding.sessionId,
      instanceId: storedBinding.instanceId,
      generation: storedBinding.generation,
    };

    const router = new ChildSessionRouter({ now: () => 1_764_000_000_000 });
    registry.registerModules({ timelineReader: router });
    const { rootAgentId } = router.registerBinding({
      binding,
      rootNativeSessionId: 'root_sql_1',
      profileRef: 'prof_sql',
      sourceRef: 'desktop',
      appDataPath,
      enableReadOnlySnapshot: true,
    });

    // Ingest E06 App snapshot and commit to real SQLite registry
    const ingested = router.ingestReadOnlySnapshot({
      binding,
      profileRef: 'prof_sql',
      sourceRef: 'desktop',
    });
    expect(ingested.affectedAgentIds).toHaveLength(1);
    const snapChildId = ingested.affectedAgentIds[0]!;

    // Persist root + snapshot child commits
    const rootSnap = router.getStateSnapshot(binding)!.agents.find((a) => a.id === rootAgentId)!;
    registry.commitAndPublish(
      binding,
      { agents: [rootSnap] },
      {
        type: 'native.agent.changed',
        turnId: null,
        payload: {
          agent: {
            id: rootSnap.id,
            foreground: {
              kind: 'known',
              value: 'idle',
              evidence: { sourceKind: 'host_observation', freshness: 'host', observedAt: 1_764_000_000_000, reasonCode: 'root_session_bound' },
            },
            launchWorkIds: [],
            lineage: 'confirmed',
            revision: 1,
          },
        },
      },
    );
    router.commitToRegistry(registry, binding, ingested.commits);

    const projection = registry.getProjectionForSession('sess_np05_sql', 'agy');
    expect(projection.agents.map((a) => a.id)).toContain(snapChildId);
    expect(projection.relations).toHaveLength(1);
    expect(projection.relations[0]?.confidence).toBe('snapshot_confirmed');
    expect(projection.relations[0]?.parentAgentId).toBe(rootAgentId);

    // Public projection MUST NOT leak private conversationId or workspaceUris!
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('private_conv_secret_001');
    expect(serialized).not.toContain('D:/private/workspace');

    // Timeline reader registered on AgyNativeRuntimeRegistry returns honest unavailable for App record without JSONL
    const timeline = registry.getTimelineReaderPort()!.readTimeline({
      binding,
      scopeKind: 'agent',
      scopeId: snapChildId,
      limit: 20,
    });
    expect(timeline.items).toEqual([]);
    expect(timeline.sourceUnavailableReason).toBe('child_transcript_source_not_provided');

    // Snapshot-only child NEVER gets cancel permission
    expect(router.authorizeChildCancel(binding, snapChildId).allowed).toBe(false);

    const ingress = {
      binding,
      connectionId: 'g2-review',
      channel: 'live' as const,
      originSession: 'root_sql_1',
    };
    const launch = router.acceptFrame({
      ...ingress,
      ingressOrdinal: 1,
      wire: {
        sessionUpdate: 'tool_call',
        toolCallId: 'review_launch',
        title: 'invoke_subagent',
        status: 'in_progress',
      },
    });
    router.commitToRegistry(registry, binding, launch.commits);
    const candidateId = launch.affectedAgentIds[0]!;
    const announce = router.acceptFrame({
      ...ingress,
      ingressOrdinal: 2,
      wire: {
        sessionUpdate: 'subagent_update',
        parentSessionId: 'root_sql_1',
        childSessionId: 'review_child',
        launchToolCallId: 'review_launch',
        state: 'running',
      },
    });
    router.commitToRegistry(registry, binding, announce.commits);
    const confirmedId = announce.affectedAgentIds[0]!;
    expect(confirmedId).toBe(candidateId);
    const projected = registry.getProjectionForSession('sess_np05_sql', 'agy');
    expect(projected.agents.filter((agent) => agent.launchWorkIds.includes(launch.affectedWorkIds[0]!)))
      .toEqual([expect.objectContaining({ id: candidateId, lineage: 'confirmed' })]);
  });
});
