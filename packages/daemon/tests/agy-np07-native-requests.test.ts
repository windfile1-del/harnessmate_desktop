import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asActivityId,
  asBindingGeneration,
  asNativeAgentId,
  asWorkflowId,
  type NativeCanonicalEvent,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import { ApprovalCenterService } from '../src/core/approval-center-service.js';
import { AgyAdapter } from '../src/harnesses/agy/agy-driver.js';
import { DEFAULT_AGY_APP_DATA_DIR_NAME } from '../src/harnesses/agy/agy-launch-context.js';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  NativePermissionRouter,
  NativeRequestValidationError,
  StubNativeRequestTargetResolver,
  parseIncomingWireRequest,
  validateElicitationFormPayload,
} from '../src/harnesses/agy/native/requests/index.js';
import { createDaemon } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: Array<ReturnType<typeof createDaemon>> = [];
const activeRouters: NativePermissionRouter[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeRouters.length > 0) {
    activeRouters.pop()?.dispose();
  }
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop();
    await d?.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

async function createAgyTestEnv(opts?: {
  unknownChildPolicy?: 'hold_bounded_cancel_only' | 'reject_immediately';
  defaultDeadlineMs?: number;
  unknownChildDeadlineMs?: number;
  now?: () => number;
  permissionMode?: 'manual' | 'accept_edits';
}) {
  const tmp = makeTempDir('hm-np07-');
  const daemon = createDaemon({
    dataDir: path.join(tmp, 'data'),
    port: 0,
    webDistDir: null,
  });
  activeDaemons.push(daemon);
  await daemon.app.ready();

  const ws = daemon.store.createWorkspace({
    id: 'ws_np07',
    name: 'NP07 WS',
    rootPath: tmp,
    isGitRepo: false,
    gitBranch: null,
    createdAt: 1_000,
  });

  const session = daemon.store.createSession({
    id: 'sess_np07',
    workspaceId: ws.id,
    harnessId: 'agy',
    harnessKind: 'agy',
    nativeSessionId: 'nat_root_1',
    cwd: tmp,
    worktreeBranch: null,
    title: 'NP-07 Native Approval Session',
    status: 'idle',
    model: null,
    reasoningEffort: null,
    permissionMode: opts?.permissionMode ?? 'manual',
    lastSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  daemon.nativeRegistry.setFeatureFlags({
    enabled: true,
    nativeLifecycle: true,
    nativePermissions: true,
    nativeCommands: false,
    observatoryTap: false,
    acpV2Preview: false,
  });

  const storedBinding = daemon.nativeRegistry.ensureRuntimeBinding({
    sessionId: session.id,
    instanceId: 'agy',
    profileRef: 'agy:default',
    status: 'attached',
  });

  const binding: RuntimeBinding = {
    runtimeId: storedBinding.runtimeId,
    sessionId: storedBinding.sessionId,
    instanceId: storedBinding.instanceId,
    generation: storedBinding.generation,
  };

  const resolver = new StubNativeRequestTargetResolver();
  resolver.registerRootSession(binding, 'conn_1', 'nat_root_1');

  const approvalCenter = new ApprovalCenterService(daemon.store);
  const rulesBefore = approvalCenter.listRules().map((r) => r.id);

  const router = new NativePermissionRouter(daemon.nativeRegistry, {
    targetResolver: resolver,
    unknownChildPolicy: opts?.unknownChildPolicy,
    defaultDeadlineMs: opts?.defaultDeadlineMs,
    unknownChildDeadlineMs: opts?.unknownChildDeadlineMs,
    now: opts?.now,
    approvalCenterBridge: {
      evaluateLocalAnnotations: (ctx) => approvalCenter.evaluateLocalRules(ctx),
      getSessionContext: (sid) => {
        const s = daemon.store.getSession(sid);
        return s ? { workspaceId: s.workspaceId, cwd: s.cwd, parentSessionId: s.parentSessionId ?? null } : null;
      },
      mirrorPendingApproval: (approval) => {
        daemon.store.createApproval(approval);
      },
      syncResolvedApproval: ({ approvalId, status, decision, resolvedBy, comment }) => {
        if (status === 'expired') {
          daemon.store.expireApprovalIfPending(approvalId);
        } else {
          daemon.store.resolveApprovalIfPending(
            approvalId,
            decision ?? 'deny',
            resolvedBy ?? 'auto',
            comment ?? undefined,
            { statusOverride: status },
          );
        }
      },
    },
  });
  activeRouters.push(router);

  daemon.nativeRegistry.registerModules({ permissions: router });

  return {
    tmp,
    daemon,
    session,
    binding,
    resolver,
    router,
    approvalCenter,
    rulesBefore,
  };
}

describe('NP-07 Wire & Elicitation Schema Codec (synthetic)', () => {
  it('validates permission options, rejects unknown methods (-32601) and malformed params (-32602), and parses AGY interaction_* questions', () => {
    const unknown = parseIncomingWireRequest('vendor/unknown_prompt', { sessionId: 's1' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.rpcError.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    }

    const missingSession = parseIncomingWireRequest('session/request_permission', {
      options: [{ optionId: 'allow_once', name: 'Allow once' }],
    });
    expect(missingSession.ok).toBe(false);
    if (!missingSession.ok) {
      expect(missingSession.rpcError.code).toBe(JSON_RPC_INVALID_PARAMS);
    }

    const dupOption = parseIncomingWireRequest('session/request_permission', {
      sessionId: 's1',
      options: [
        { optionId: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_once', name: 'Duplicate' },
      ],
    });
    expect(dupOption.ok).toBe(false);
    if (!dupOption.ok) {
      expect(dupOption.rpcError.code).toBe(JSON_RPC_INVALID_PARAMS);
    }

    // Standard ACP v1 subject.toolCall shape with security warning
    const perm = parseIncomingWireRequest('session/request_permission', {
      sessionId: 's1',
      title: 'Run shell script',
      subject: {
        type: 'tool_call',
        toolCall: {
          toolCallId: 'tc_1',
          kind: 'execute',
          title: 'Run migrate.mjs',
          rawInput: { command: 'node migrate.mjs' },
        },
      },
      options: [
        {
          optionId: 'allow_once',
          kind: 'allow_once',
          name: 'Allow once',
          _meta: { 'agy.security.warning': 'Script modifies workspace root files' },
        },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(perm.ok).toBe(true);
    if (perm.ok) {
      expect(perm.parsed.kind).toBe('permission');
      expect(perm.parsed.allowsFreeText).toBe(false);
      expect(perm.parsed.securityWarnings).toEqual(['Script modifies workspace root files']);
      expect(perm.parsed.options.find((o) => o.optionId === 'allow_always')?.scopeWidening).toBe(true);
      expect(perm.parsed.options.find((o) => o.optionId === 'allow_once')?.scopeWidening).toBe(false);
    }

    // AGY 1.5.14 / 1.5.16 interaction_* question with fixed options
    const question = parseIncomingWireRequest('session/request_permission', {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'interaction_001',
        title: 'Select target environment',
        rawInput: { question: 'Which target should run after verification?' },
      },
      options: [
        { optionId: 'staging', name: 'Staging' },
        { optionId: 'production', name: 'Production' },
      ],
    });
    expect(question.ok).toBe(true);
    if (question.ok) {
      expect(question.parsed.kind).toBe('question');
      expect(question.parsed.allowsFreeText).toBe(false);
      expect(question.parsed.canAnswer).toBe(true);
      expect(question.parsed.options.map((o) => o.optionId)).toEqual(['staging', 'production']);
    }

    // AGY interaction_* with zero options -> honestly marked unanswerable (no silent free-text fabrication)
    const zeroOptQ = parseIncomingWireRequest('session/request_permission', {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'interaction_002',
        title: 'Free form?',
        rawInput: { question: 'Describe custom deployment note' },
      },
      options: [],
    });
    expect(zeroOptQ.ok).toBe(true);
    if (zeroOptQ.ok) {
      expect(zeroOptQ.parsed.kind).toBe('question');
      expect(zeroOptQ.parsed.allowsFreeText).toBe(false);
      expect(zeroOptQ.parsed.canAnswer).toBe(false);
      expect(zeroOptQ.parsed.unsupportedReason).toBe('no_verified_free_text_wire_encoding');
    }
  });

  it('validates ACP v1 elicitation/create form schema, rejects malformed/url mode, and detects unsupported nested schemas', () => {
    const urlRejected = parseIncomingWireRequest('elicitation/create', {
      sessionId: 's1',
      mode: 'url',
      message: 'Sign in externally',
      url: 'https://example.com/auth',
    });
    expect(urlRejected.ok).toBe(false);
    if (!urlRejected.ok) {
      expect(urlRejected.rpcError.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    }

    const parsedForm = parseIncomingWireRequest('elicitation/create', {
      sessionId: 's1',
      mode: 'form',
      message: 'Configure deployment parameters',
      requestedSchema: {
        type: 'object',
        required: ['env', 'replicas', 'email'],
        additionalProperties: false,
        properties: {
          env: { type: 'string', enum: ['staging', 'prod'], title: 'Environment' },
          replicas: { type: 'integer', minimum: 1, maximum: 10 },
          dryRun: { type: 'boolean', default: false },
          email: { type: 'string', format: 'email' },
          tags: { type: 'array', items: { type: 'string', enum: ['canary', 'fast'] } },
        },
      },
    });
    expect(parsedForm.ok).toBe(true);
    if (!parsedForm.ok || !parsedForm.parsed.formSpec) throw new Error('expected parsed form');

    expect(parsedForm.parsed.kind).toBe('elicitation');
    expect(parsedForm.parsed.canAnswer).toBe(true);
    expect(parsedForm.parsed.allowsFreeText).toBe(true);

    const validOut = validateElicitationFormPayload(parsedForm.parsed.formSpec, {
      env: 'staging',
      replicas: 3,
      dryRun: true,
      email: 'ops@example.com',
      tags: ['canary'],
    });
    expect(validOut).toEqual({
      env: 'staging',
      replicas: 3,
      dryRun: true,
      email: 'ops@example.com',
      tags: ['canary'],
    });

    // Rejects invalid integer, out-of-range, invalid enum, invalid format, and unknown extra field
    expect(() =>
      validateElicitationFormPayload(parsedForm.parsed.formSpec!, {
        env: 'staging',
        replicas: 2.5,
        email: 'ops@example.com',
      }),
    ).toThrow(NativeRequestValidationError);

    expect(() =>
      validateElicitationFormPayload(parsedForm.parsed.formSpec!, {
        env: 'invalid_env',
        replicas: 2,
        email: 'ops@example.com',
      }),
    ).toThrow(NativeRequestValidationError);

    expect(() =>
      validateElicitationFormPayload(parsedForm.parsed.formSpec!, {
        env: 'staging',
        replicas: 2,
        email: 'not-an-email',
      }),
    ).toThrow(NativeRequestValidationError);

    expect(() =>
      validateElicitationFormPayload(parsedForm.parsed.formSpec!, {
        env: 'staging',
        replicas: 2,
        email: 'ops@example.com',
        injectedExtra: 'nope',
      }),
    ).toThrow(NativeRequestValidationError);

    // Unsupported nested object field -> honestly marked unsupported (cannot answer, cancel/decline only)
    const nested = parseIncomingWireRequest('elicitation/create', {
      sessionId: 's1',
      mode: 'form',
      message: 'Nested form',
      requestedSchema: {
        type: 'object',
        properties: {
          nestedCfg: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
    });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.parsed.canAnswer).toBe(false);
      expect(nested.parsed.formSpec?.supported).toBe(false);
      expect(nested.parsed.unsupportedReason).toContain('unsupported_elicitation_field:nestedCfg');
    }
  });
});

describe('NP-07 T06/T07/T14 Routing, Child Attribution, CAS, Expiry, Stop & Recovery (synthetic)', () => {
  it('T06: handles detached out-of-turn, AGY 1.5.16 default/accept-edits forwarded child & workflow requests, preserves RpcId types, and never auto-approves or mutates Approval Center rules', async () => {
    const { daemon, session, binding, resolver, router, approvalCenter, rulesBefore } =
      await createAgyTestEnv({ permissionMode: 'accept_edits' });

    const detachedActId = asActivityId('act_detached_bg_1');
    const childAgentId = asNativeAgentId('agt_researcher_1');
    const wfId = asWorkflowId('wf_dynamic_1');

    resolver.setRootActivity(binding, {
      activityId: detachedActId,
      turnId: null,
      isDetached: true,
    });
    resolver.registerChildSession(binding, {
      childNativeSessionId: 'nat_child_1',
      agentId: childAgentId,
      agentLabel: 'Codebase Researcher',
      activityId: asActivityId('act_child_1'),
      lineage: 'confirmed',
      turnId: null,
    });
    resolver.registerWorkflow(binding, {
      workflowId: wfId,
      workflowKind: 'dynamic',
      workflowLabel: 'Dynamic Audit Pipeline',
      activityId: asActivityId('act_wf_1'),
      toolCallIds: ['tc_wf_script_1'],
      turnId: null,
    });

    const wireResponses: Array<{ rpcId: string | number; result: unknown }> = [];

    // 1. Detached out-of-turn permission request with NUMERIC RpcId + dangerous command triggering read-only Approval Center rule
    const r1 = router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 10,
      channel: 'live',
      wireRequestId: 8101,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: {
          toolCallId: 'tc_bg_cmd_1',
          kind: 'execute',
          title: 'git push --force origin main',
          rawInput: { command: 'git push --force origin main' },
        },
        options: [
          {
            optionId: 'allow_once',
            kind: 'allow_once',
            name: 'Allow once',
            _meta: { 'agy.security.warning': 'Force push overwrites remote history' },
          },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireResponses.push({ rpcId: 8101, result });
        return true;
      },
      respondError: () => true,
    });
    expect(r1).toEqual({ handled: true });

    // 2. AGY 1.5.16 parent-forwarded confirmed child request with STRING RpcId
    const r2 = router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 11,
      channel: 'live',
      wireRequestId: 'str-rpc-child-2',
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        _meta: { subagentSessionId: 'nat_child_1' },
        toolCall: {
          toolCallId: 'tc_child_edit_1',
          kind: 'edit',
          title: 'Edit src/index.ts',
        },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireResponses.push({ rpcId: 'str-rpc-child-2', result });
        return true;
      },
      respondError: () => true,
    });
    expect(r2).toEqual({ handled: true });

    // 3. AGY 1.5.16 parent-forwarded confirmed workflow request
    const r3 = router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 12,
      channel: 'live',
      wireRequestId: 8103,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: {
          toolCallId: 'tc_wf_script_1',
          kind: 'execute',
          title: 'Approve Dynamic Workflow script',
        },
        options: [
          { optionId: 'approve_script', kind: 'allow_once', name: 'Approve script' },
          { optionId: 'reject_script', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireResponses.push({ rpcId: 8103, result });
        return true;
      },
      respondError: () => true,
    });
    expect(r3).toEqual({ handled: true });

    // Nothing was auto-approved!
    expect(wireResponses).toHaveLength(0);

    const pending = router.listPendingRequests(binding);
    expect(pending).toHaveLength(3);

    const details = router.listRequestDetails(binding);
    expect(details).toHaveLength(3);

    const detachedDetail = details.find((d) => d.toolName === 'git push --force origin main')!;
    expect(detachedDetail.isDetached).toBe(true);
    expect(detachedDetail.activityId).toBe(detachedActId);
    expect(detachedDetail.riskLevel).toBe('critical'); // read-only ApprovalCenterService builtin.git_force_push annotation
    expect(detachedDetail.annotations.some((a) => a.label.includes('强制推送'))).toBe(true);
    expect(detachedDetail.securityWarnings).toEqual(['Force push overwrites remote history']);

    // Verify public DTO allowlist: ZERO private fields leaked!
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('conn_1');
    expect(serialized).not.toContain('nat_root_1');
    expect(serialized).not.toContain('str-rpc-child-2');

    const childDetail = details.find((d) => d.agentId === childAgentId)!;
    expect(childDetail.scope).toBe('confirmed_child');
    expect(childDetail.targetLineage).toBe('confirmed');
    expect(childDetail.forwardedToParentSession).toBe(true);
    expect(childDetail.agentLabel).toBe('Codebase Researcher');

    const wfDetail = details.find((d) => d.workflowId === wfId)!;
    expect(wfDetail.scope).toBe('confirmed_workflow');
    expect(wfDetail.workflowKind).toBe('dynamic');
    expect(wfDetail.workflowLabel).toBe('Dynamic Audit Pipeline');

    // Resolve via Fastify REST endpoint POST /api/v1/sessions/:id/native/requests/:approvalId/resolve
    const res1 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${detachedDetail.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'reject_once',
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().receiptState).toBe('response_written');

    // Duplicate double-click loses DB CAS -> 409 ALREADY_RESOLVED, zero second wire write!
    const res1Dup = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${detachedDetail.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(res1Dup.statusCode).toBe(409);
    expect(res1Dup.json().code).toBe('ALREADY_RESOLVED');

    // Resolve child & workflow requests
    const res2 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${childDetail.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(res2.statusCode).toBe(200);

    const res3 = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${wfDetail.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'approve_script',
      },
    });
    expect(res3.statusCode).toBe(200);

    expect(wireResponses).toEqual([
      { rpcId: 8101, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } },
      { rpcId: 'str-rpc-child-2', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } },
      { rpcId: 8103, result: { outcome: { outcome: 'selected', optionId: 'approve_script' } } },
    ]);
    expect(typeof wireResponses[0]!.rpcId).toBe('number');
    expect(typeof wireResponses[1]!.rpcId).toBe('string');

    // Approval Center rules were NEVER modified
    expect(approvalCenter.listRules().map((r) => r.id)).toEqual(rulesBefore);
  });

  it('T07: enforces unknown child, unresolved forwarded child, and conflicting lineage security boundaries without ever widening permissions', async () => {
    let clock = 10_000;
    const { daemon, session, binding, resolver, router } = await createAgyTestEnv({
      unknownChildPolicy: 'hold_bounded_cancel_only',
      defaultDeadlineMs: 120_000,
      unknownChildDeadlineMs: 15_000,
      now: () => clock,
    });

    resolver.registerChildSession(binding, {
      childNativeSessionId: 'nat_child_conflict',
      agentId: asNativeAgentId('agt_conflict'),
      lineage: 'conflicting',
    });

    const wireWrites: Array<{ rpcId: string | number; result: unknown }> = [];

    // 1. Unknown foreign child session (neither root nor registered child)
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 20,
      channel: 'live',
      wireRequestId: 9001,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_mystery_child_99',
        toolCall: { toolCallId: 'tc_mystery', kind: 'execute', title: 'Run mystery command' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireWrites.push({ rpcId: 9001, result });
        return true;
      },
      respondError: () => true,
    });

    const mysteryPending = router.listPendingRequests(binding)[0]!;
    // All allow options stripped; ONLY reject_once remains, bounded shorter deadline applied!
    expect(mysteryPending.allowedOptionIds).toEqual(['reject_once']);
    expect(mysteryPending.deadline).toBe(25_000);

    // Attempting to select allow_once via REST is rejected (400 INVALID_REQUEST), zero wire writes!
    const widenAttempt = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${mysteryPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(widenAttempt.statusCode).toBe(400);
    expect(wireWrites).toHaveLength(0);

    // Advance clock past bounded deadline -> auto-expires & writes cancelled safely on wire!
    clock = 26_000;
    const expiredIds = router.expireDueRequests(clock);
    expect(expiredIds).toEqual([mysteryPending.approvalId]);
    expect(wireWrites).toEqual([{ rpcId: 9001, result: { outcome: { outcome: 'cancelled' } } }]);
    expect(router.getRequestDetail(mysteryPending.approvalId)?.receiptState).toBe('expired');

    // 2. Conflicting child lineage -> strips ALL allow options
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 21,
      channel: 'live',
      wireRequestId: 9002,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_child_conflict',
        toolCall: { toolCallId: 'tc_conf', kind: 'edit', title: 'Edit secret' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        ],
      },
      respond: (result) => {
        wireWrites.push({ rpcId: 9002, result });
        return true;
      },
      respondError: () => true,
    });
    const conflictPending = router.listPendingRequests(binding).find((p) => p.wireRequestId === 9002)!;
    expect(conflictPending.allowedOptionIds).toEqual([]);
    expect(router.getRequestDetail(conflictPending.approvalId)?.targetLineage).toBe('conflicting');
    expect(router.getRequestDetail(conflictPending.approvalId)?.canAnswer).toBe(false);

    // 3. Forwarded via root session with unresolved child hint -> blocks scope-widening allow_always!
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 22,
      channel: 'live',
      wireRequestId: 9003,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        _meta: { subagentSessionId: 'nat_unregistered_child_hint' },
        toolCall: { toolCallId: 'tc_fwd', kind: 'edit', title: 'Forwarded edit' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireWrites.push({ rpcId: 9003, result });
        return true;
      },
      respondError: () => true,
    });
    const fwdUnresolved = router.listPendingRequests(binding).find((p) => p.wireRequestId === 9003)!;
    expect(fwdUnresolved.allowedOptionIds).toEqual(['allow_once', 'reject_once']);
    expect(fwdUnresolved.allowedOptionIds).not.toContain('allow_always');

    // 4. Reject-immediately policy for unknown child cancels directly on ingress
    const { router: strictRouter, binding: strictBinding } = await createAgyTestEnv({
      unknownChildPolicy: 'reject_immediately',
    });
    const immediateRes = strictRouter.onIncomingRequest({
      binding: strictBinding,
      connectionId: 'conn_1',
      ingressOrdinal: 1,
      channel: 'live',
      wireRequestId: 9004,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_unknown_foreign',
        toolCall: { toolCallId: 'tc_imm', kind: 'execute', title: 'Unknown' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: () => true,
      respondError: () => true,
    });
    expect(immediateRes).toEqual({
      handled: true,
      response: { outcome: { outcome: 'cancelled' } },
    });
    expect(strictRouter.listPendingRequests(strictBinding)).toHaveLength(0);
  });

  it('forbids silently mapping free-text to options[0] on fixed-option questions (both native and legacy bridge)', async () => {
    const { binding, router } = await createAgyTestEnv();
    const wireWrites: unknown[] = [];

    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 30,
      channel: 'live',
      wireRequestId: 7001,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: {
          toolCallId: 'interaction_001',
          title: 'Choose deploy target',
          rawInput: { question: 'Which environment?' },
        },
        options: [
          { optionId: 'staging', name: 'Staging' },
          { optionId: 'production', name: 'Production' },
        ],
      },
      respond: (result) => {
        wireWrites.push(result);
        return true;
      },
      respondError: () => true,
    });

    const pending = router.listPendingRequests(binding)[0]!;

    // 1. Pre-CAS validation rejects form_submitted on fixed-option question
    const check = router.validateResolutionInput(binding, pending.approvalId, {
      generation: binding.generation,
      outcome: 'form_submitted',
      formPayload: { answer: 'custom free text' },
    });
    expect(check.valid).toBe(false);
    expect(check.errorCode).toBe('FREE_TEXT_NOT_SUPPORTED');

    // 2. Direct resolveWithCas throws NativeRequestValidationError and does NOT write to wire or burn CAS!
    await expect(
      router.resolveWithCas({
        binding,
        approvalId: pending.approvalId,
        request: {
          generation: binding.generation,
          outcome: 'form_submitted',
          formPayload: { answer: 'custom free text' },
        },
        resolvedBy: 'desktop',
      }),
    ).rejects.toMatchObject({ code: 'FREE_TEXT_NOT_SUPPORTED' });
    expect(wireWrites).toHaveLength(0);

    // 3. Legacy Approval Center bridge ALSO rejects free-text without mapping to options[0] ('staging')!
    await expect(
      router.resolveViaLegacyApprovalCenter({
        binding,
        approvalId: pending.approvalId,
        receiptId: 'nrcpt_test',
        request: {
          questionAnswer: { freeText: 'deploy to dev instead' },
          resolvedBy: 'desktop',
        },
        resolvedBy: 'desktop',
      }),
    ).rejects.toMatchObject({ code: 'FREE_TEXT_NOT_SUPPORTED' });
    expect(wireWrites).toHaveLength(0);

    // 4. Selecting an exact declared native optionId ('production') still succeeds cleanly!
    const ok = await router.resolveWithCas({
      binding,
      approvalId: pending.approvalId,
      request: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'production',
      },
      resolvedBy: 'desktop',
    });
    expect(ok.conflict).toBe(false);
    expect(ok.receiptState).toBe('response_written');
    expect(wireWrites).toEqual([{ outcome: { outcome: 'selected', optionId: 'production' } }]);
  });

  it('T14: handles Stop race, connection loss, write failure/throw, epoch switch, history_replay, and shared Legacy+Native CAS', async () => {
    const { daemon, session, binding, router } = await createAgyTestEnv();
    const events: NativeCanonicalEvent[] = [];
    daemon.nativeRegistry.subscribeSession(session.id, (ev) => events.push(ev));

    // 0. history_replay request MUST be rejected with -32601 and never create pending requests
    const replayRes = router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 1,
      channel: 'history_replay',
      wireRequestId: 5000,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        options: [{ optionId: 'allow_once', name: 'Allow once' }],
      },
      respond: () => true,
      respondError: () => true,
    });
    expect(replayRes?.handled).toBe(true);
    expect(replayRes?.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    expect(router.listPendingRequests(binding)).toHaveLength(0);

    // 1. Stop vs pending approval race
    const stopWrites: unknown[] = [];
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 2,
      channel: 'live',
      wireRequestId: 5001,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_stop', kind: 'execute', title: 'Long command' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: (r) => {
        stopWrites.push(r);
        return true;
      },
      respondError: () => true,
    });
    const stopPending = router.listPendingRequests(binding)[0]!;
    const stopRes = router.handleStopRequested(binding);
    expect(stopRes.cancelledApprovalIds).toEqual([stopPending.approvalId]);
    expect(stopWrites).toEqual([{ outcome: { outcome: 'cancelled' } }]);

    // User clicking approve right after Stop gets 409 ALREADY_RESOLVED and zero second wire write!
    const afterStopClick = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${stopPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(afterStopClick.statusCode).toBe(409);
    expect(afterStopClick.json().code).toBe('ALREADY_RESOLVED');
    expect(stopWrites).toHaveLength(1);

    // 2. Wire write returns false -> receiptState = 'connection_lost' (no replay!)
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 3,
      channel: 'live',
      wireRequestId: 5002,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_false', kind: 'execute', title: 'Stdin closed' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: () => false,
      respondError: () => true,
    });
    const falsePending = router.listPendingRequests(binding)[0]!;
    const falseRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${falsePending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(falseRes.statusCode).toBe(200);
    expect(falseRes.json().receiptState).toBe('connection_lost');

    // 3. Wire write throws -> receiptState = 'delivery_unknown' (never retried!)
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 4,
      channel: 'live',
      wireRequestId: 5003,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_throw', kind: 'execute', title: 'Write threw' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: () => {
        throw new Error('EPIPE broken pipe');
      },
      respondError: () => true,
    });
    const throwPending = router.listPendingRequests(binding)[0]!;
    const throwRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${throwPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(throwRes.statusCode).toBe(200);
    expect(throwRes.json().receiptState).toBe('delivery_unknown');

    // 4. Connection close invalidates pending -> connection_lost, never replays!
    let closedWrites = 0;
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_drop',
      ingressOrdinal: 5,
      channel: 'live',
      wireRequestId: 5004,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_drop', kind: 'execute', title: 'Drops mid-wait' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: () => {
        closedWrites += 1;
        return true;
      },
      respondError: () => true,
    });
    const dropPending = router.listPendingRequests(binding)[0]!;
    daemon.nativeRegistry.handleTransportClosed(binding, 'conn_drop', 'process_crashed');
    expect(router.getRequestDetail(dropPending.approvalId)?.receiptState).toBe('connection_lost');
    expect(router.listPendingRequests(binding)).toHaveLength(0);
    const afterDrop = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${dropPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(afterDrop.statusCode).toBe(409);
    expect(closedWrites).toBe(0);

    // 5. Shared CAS between Legacy SessionManager.resolveRuntimeRequest and Native endpoint
    const sharedWrites: unknown[] = [];
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 6,
      channel: 'live',
      wireRequestId: 5005,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_shared', kind: 'execute', title: 'Dual entry race' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (r) => {
        sharedWrites.push(r);
        return true;
      },
      respondError: () => true,
    });
    const sharedPending = router.listPendingRequests(binding)[0]!;

    // Native endpoint resolves first
    const nativeWin = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${sharedPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(nativeWin.statusCode).toBe(200);
    expect(sharedWrites).toHaveLength(1);

    // Legacy SessionManager.resolveRuntimeRequest loses shared DB CAS cleanly (conflict: true)
    const legacyLose = await daemon.sessionManager.resolveRuntimeRequest(
      sharedPending.approvalId,
      { decision: 'deny', resolvedBy: 'desktop' },
      'desktop',
    );
    expect(legacyLose.conflict).toBe(true);
    expect(legacyLose.updated).toBe(false);
    expect(sharedWrites).toHaveLength(1);

    // 6. Epoch / Generation switch invalidates old pending request -> 409 STALE_BINDING, zero wire writes!
    let epochWrites = 0;
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 7,
      channel: 'live',
      wireRequestId: 5006,
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_epoch', kind: 'execute', title: 'Epoch switch' },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
      respond: () => {
        epochWrites += 1;
        return true;
      },
      respondError: () => true,
    });
    const epochPending = router.listPendingRequests(binding)[0]!;
    const nextStored = daemon.nativeRegistry.advanceRuntimeGeneration(binding.runtimeId, {
      generation: asBindingGeneration('gen_next_epoch'),
    });
    const nextBinding: RuntimeBinding = {
      ...binding,
      generation: nextStored.generation,
    };
    router.handleGenerationChanged(binding, nextBinding);
    expect(router.getRequestDetail(epochPending.approvalId)?.receiptState).toBe('connection_lost');

    const staleGenRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${epochPending.approvalId}/resolve`,
      payload: {
        generation: binding.generation,
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });
    expect(staleGenRes.statusCode).toBe(409);
    expect(staleGenRes.json().code).toBe('STALE_BINDING');
    expect(epochWrites).toBe(0);
    expect(events.some((e) => e.type === 'native.request.changed')).toBe(true);
  });

  it('handles simultaneous Promise.all double-click, multiple occurrences, and feature-gate rollback without affecting legacy approvals', async () => {
    const { daemon, session, binding, router } = await createAgyTestEnv();
    const wireWrites: Array<{ rpcId: string | number; result: unknown }> = [];

    // Two distinct occurrences for the same toolCallId on the same session
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 40,
      channel: 'live',
      wireRequestId: 'occ-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_repeat', kind: 'execute', title: 'Repeat shell' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireWrites.push({ rpcId: 'occ-1', result });
        return true;
      },
      respondError: () => true,
    });
    router.onIncomingRequest({
      binding,
      connectionId: 'conn_1',
      ingressOrdinal: 41,
      channel: 'live',
      wireRequestId: 'occ-2',
      method: 'session/request_permission',
      params: {
        sessionId: 'nat_root_1',
        toolCall: { toolCallId: 'tc_repeat', kind: 'execute', title: 'Repeat shell' },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
      respond: (result) => {
        wireWrites.push({ rpcId: 'occ-2', result });
        return true;
      },
      respondError: () => true,
    });

    const pending = router.listPendingRequests(binding);
    expect(pending).toHaveLength(2);
    const p1 = pending.find((p) => p.wireRequestId === 'occ-1')!;
    const p2 = pending.find((p) => p.wireRequestId === 'occ-2')!;
    expect(p1.occurrence).toBe(1);
    expect(p2.occurrence).toBe(2);
    expect(p1.approvalId).not.toBe(p2.approvalId);

    // Simultaneous Promise.all double-click on occurrence 1 -> exactly one 200 and one 409, one wire write!
    const [clickA, clickB] = await Promise.all([
      daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/native/requests/${p1.approvalId}/resolve`,
        payload: { generation: binding.generation, outcome: 'selected', optionId: 'allow_once' },
      }),
      daemon.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/native/requests/${p1.approvalId}/resolve`,
        payload: { generation: binding.generation, outcome: 'selected', optionId: 'reject_once' },
      }),
    ]);
    const codes = [clickA.statusCode, clickB.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([200, 409]);
    expect(wireWrites).toHaveLength(1);
    expect(wireWrites[0]!.rpcId).toBe('occ-1');

    // Occurrence 2 remains independently pending!
    expect(router.listPendingRequests(binding).map((p) => p.approvalId)).toEqual([p2.approvalId]);

    // Rollback feature gate (nativePermissions: false) -> native endpoint closes with 503 while legacy /api/v1/approvals stays readable!
    daemon.nativeRegistry.setFeatureFlags({ nativePermissions: false });
    const gatedRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${p2.approvalId}/resolve`,
      payload: { generation: binding.generation, outcome: 'cancelled' },
    });
    expect(gatedRes.statusCode).toBe(503);
    expect(gatedRes.json().code).toBe('NATIVE_RUNTIME_DISABLED');

    const legacyApprovals = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/approvals?sessionId=${session.id}`,
    });
    expect(legacyApprovals.statusCode).toBe(200);
    expect(Array.isArray(legacyApprovals.json().approvals)).toBe(true);
  });
});

describe('NP-07 End-to-End Real AcpSessionHandle + AgyAdapter + Stdio JSON-RPC Peer (synthetic + E05 replay shapes)', () => {
  it('routes post-turn detached permission (number ID), interaction_* question (string ID), elicitation form, and unknown method (-32601) over real stdio JSON-RPC', async () => {
    const tmp = makeTempDir('hm-np07-e2e-');
    const peerLogPath = path.join(tmp, 'peer-responses.ndjson');
    const peerScript = path.join(tmp, 'mock-acp-np07.mjs');

    fs.writeFileSync(
      peerScript,
      `
import fs from 'node:fs';
import readline from 'node:readline';

const logPath = ${JSON.stringify(peerLogPath)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'antigravity-cli', version: '1.5.16' },
        agentCapabilities: { promptCapabilities: { embeddedContext: false } },
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'agy-e2e-sess-1',
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'accept-edits', name: 'Accept Edits' },
          ],
        },
        configOptions: [],
      },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    // Finish prompt immediately to simulate detached post-turn requests!
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    setTimeout(() => {
      // 1. Detached permission with NUMERIC id (8101)
      send({
        jsonrpc: '2.0',
        id: 8101,
        method: 'session/request_permission',
        params: {
          sessionId: 'agy-e2e-sess-1',
          toolCall: {
            toolCallId: 'tc-shell-detached-1',
            title: 'Write migration script',
            kind: 'execute',
            rawInput: { command: 'node migrate.mjs' },
          },
          options: [
            {
              optionId: 'allow_once',
              kind: 'allow_once',
              name: 'Allow once',
              _meta: { 'agy.security.warning': 'Touches workspace root' },
            },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      // 2. AGY interaction_* question with STRING id ("str-q-8102")
      send({
        jsonrpc: '2.0',
        id: 'str-q-8102',
        method: 'session/request_permission',
        params: {
          sessionId: 'agy-e2e-sess-1',
          toolCall: {
            toolCallId: 'interaction_001',
            title: 'Select target environment',
            rawInput: { question: 'Which target should run after verification?' },
          },
          options: [
            { optionId: 'staging', name: 'Staging' },
            { optionId: 'production', name: 'Production' },
          ],
        },
      });
      // 3. ACP v1 elicitation/create form with STRING id ("str-elicit-8103")
      send({
        jsonrpc: '2.0',
        id: 'str-elicit-8103',
        method: 'elicitation/create',
        params: {
          sessionId: 'agy-e2e-sess-1',
          mode: 'form',
          message: 'Provide release metadata',
          requestedSchema: {
            type: 'object',
            required: ['channel', 'canaryPct'],
            additionalProperties: false,
            properties: {
              channel: { type: 'string', enum: ['beta', 'stable'] },
              canaryPct: { type: 'integer', minimum: 5, maximum: 100 },
            },
          },
        },
      });
      // 4. Unknown method -> must receive -32601 with exact numeric id 8104
      send({
        jsonrpc: '2.0',
        id: 8104,
        method: 'vendor/unsupported_callback',
        params: { sessionId: 'agy-e2e-sess-1' },
      });
    }, 30);
    return;
  }
  // Record all client responses to server requests with exact typeof id!
  if (msg.id !== undefined && !msg.method) {
    fs.appendFileSync(
      logPath,
      JSON.stringify({ id: msg.id, idType: typeof msg.id, result: msg.result, error: msg.error }) + '\\n',
      'utf8',
    );
  }
});
`,
      'utf8',
    );

    class ScriptAgyAdapter extends AgyAdapter {
      protected override buildLaunchArgs(): string[] {
        return [peerScript];
      }
    }

    const daemon = createDaemon({
      dataDir: path.join(tmp, 'data'),
      port: 0,
      webDistDir: null,
    });
    activeDaemons.push(daemon);
    await daemon.app.ready();

    const adapter = new ScriptAgyAdapter({
      profile: {
        instanceId: 'agy-e2e',
        displayName: 'AGY E2E',
        isolationMode: 'profile_isolated',
        authMethod: 'oauth-personal',
        appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
        defaults: { linkGlobalSkills: false, syncGlobalRules: false, additionalDirectories: [] },
        enabled: true,
      },
      profilesRootDir: path.join(tmp, 'profiles'),
      binaryOverride: process.execPath,
      applyWindowsAcl: false,
    });
    daemon.registry.register(adapter);

    const ws = daemon.store.createWorkspace({
      id: 'ws_e2e',
      name: 'E2E WS',
      rootPath: tmp,
      isGitRepo: false,
      gitBranch: null,
      createdAt: Date.now(),
    });
    const session = daemon.store.createSession({
      id: 'sess_e2e',
      workspaceId: ws.id,
      harnessId: 'agy-e2e',
      harnessKind: 'agy',
      nativeSessionId: null,
      cwd: tmp,
      worktreeBranch: null,
      title: 'E2E NP-07',
      status: 'idle',
      model: null,
      reasoningEffort: null,
      permissionMode: 'manual',
      lastSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    daemon.nativeRegistry.setFeatureFlags({
      enabled: true,
      nativeLifecycle: false,
      nativePermissions: true,
      nativeCommands: false,
      observatoryTap: false,
      acpV2Preview: false,
    });

    const resolver = new StubNativeRequestTargetResolver();
    const router = new NativePermissionRouter(daemon.nativeRegistry, {
      targetResolver: resolver,
    });
    activeRouters.push(router);
    daemon.nativeRegistry.registerModules({ permissions: router });

    // Send a user turn so SessionManager creates the real AcpSessionHandle & binding
    await daemon.sessionManager.sendTurn(session.id, 'Run background workflow');

    const binding = daemon.nativeRegistry.getActiveBinding(session.id, 'agy-e2e');
    expect(binding).not.toBeNull();
    resolver.registerRootSession(binding!, 'any', 'agy-e2e-sess-1');
    resolver.setRootActivity(binding!, {
      activityId: asActivityId('act_e2e_detached'),
      turnId: null,
      isDetached: true,
    });

    // Wait for the 3 live requests to arrive after prompt settled
    const deadlineAt = Date.now() + 5_000;
    while (router.listPendingRequests(binding!).length < 3 && Date.now() < deadlineAt) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const pending = router.listPendingRequests(binding!);
    expect(pending).toHaveLength(3);

    const permReq = pending.find((p) => p.wireRequestId === 8101)!;
    const qReq = pending.find((p) => p.wireRequestId === 'str-q-8102')!;
    const elicitReq = pending.find((p) => p.wireRequestId === 'str-elicit-8103')!;

    expect(permReq.kind).toBe('permission');
    expect(qReq.kind).toBe('question');
    expect(elicitReq.kind).toBe('elicitation');

    // Resolve all 3 via real Fastify HTTP endpoints!
    const rPerm = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${permReq.approvalId}/resolve`,
      payload: { generation: binding!.generation, outcome: 'selected', optionId: 'allow_once' },
    });
    expect(rPerm.statusCode).toBe(200);

    const rQ = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${qReq.approvalId}/resolve`,
      payload: { generation: binding!.generation, outcome: 'selected', optionId: 'production' },
    });
    expect(rQ.statusCode).toBe(200);

    const rElicit = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/native/requests/${elicitReq.approvalId}/resolve`,
      payload: {
        generation: binding!.generation,
        outcome: 'form_submitted',
        formPayload: { channel: 'stable', canaryPct: 25 },
      },
    });
    expect(rElicit.statusCode).toBe(200);

    // Wait for child peer to flush all 4 responses (3 user + 1 immediate -32601)
    const flushDeadline = Date.now() + 3_000;
    let lines: Array<{ id: string | number; idType: string; result?: unknown; error?: { code: number } }> = [];
    while (Date.now() < flushDeadline) {
      if (fs.existsSync(peerLogPath)) {
        lines = fs
          .readFileSync(peerLogPath, 'utf8')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        if (lines.length >= 4) break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(lines).toHaveLength(4);
    const byId = new Map(lines.map((l) => [`${l.idType}:${String(l.id)}`, l]));

    expect(byId.get('number:8104')?.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    expect(byId.get('number:8101')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(byId.get('string:str-q-8102')?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'production' },
    });
    expect(byId.get('string:str-elicit-8103')?.result).toEqual({
      action: 'accept',
      content: { channel: 'stable', canaryPct: 25 },
    });
  }, 20_000);
});
