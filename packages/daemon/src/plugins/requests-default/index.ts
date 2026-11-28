import crypto from 'node:crypto';
import { PluginApiError, RUNTIME_REQUESTS_CONTRACT, REQUEST_DELIVERY_CONTRACT, type RequestDeliveryServiceV1, type RuntimeRequestsServiceV1, type RuntimeRequestDto, type RequestCreateDto, type RequestResolveDto, type RequestPolicyInputDto, type RequestPolicyDecisionDto, type RequestModeReceiptDto } from '@harnessmate/plugin-api';
import { ApprovalRequestSchema, type ApprovalRequest, type Session } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginManager } from '../plugin-manager.js';
import type { HostPlugin } from '../../plugin-host/runtime/lifecycle.js';
import type { DaemonEventBus } from '../../core/event-bus.js';
import { initializeApprovalSchema } from './persistence.js';
import { ApprovalCenterService, type ExternalApprovalAnnotator } from './rules.js';

export const REQUESTS_PLUGIN_ID = 'hm.plugin.approval-center'; // preserve installed instance and rule KV
export const REQUESTS_INTERNAL = 'runtime.requests.internal';
type Delivery = (input: RequestResolveDto) => Promise<RuntimeRequestDto['delivery']>;
type Resource = { deliver: Delivery; validate?: (input: RequestResolveDto) => void | Promise<void>; release?: () => void };
export interface RequestPluginDeps { store: HarnessMateStore; eventBus: DaemonEventBus; getPluginManager: () => PluginManager; config?: Readonly<Record<string, unknown>> }
const ok = <T>(value: T) => ({ ok: true as const, value });

/** All decisions and outbox transitions are committed on this plugin's database connection.
 * Native protocol receipts remain the driver's execution ledger, never a second decision store. */
export class RequestBroker {
  readonly rules: ApprovalCenterService;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private resources = new Map<string, Resource>();
  private publicRefs = new Map<string, NonNullable<RequestCreateDto['deliveryResource']>>();
  private committedEvents: import('@harnessmate/protocol').CanonicalEvent[] = [];
  private publish?: (payload: Record<string, unknown>) => void;
  private active = true;
  private seenPolicies = new Set<string>();
  private unsubscribePolicy?: () => void;
  private readonly db;
  constructor(private deps: RequestPluginDeps, readonly instanceId: string, publish?: (payload: Record<string, unknown>) => void) {
    this.db = deps.store.getDatabaseSync();
    initializeApprovalSchema(this.db);
    this.rules = new ApprovalCenterService(deps.store, instanceId, deps.config);
    this.publish = publish;
    this.db.exec(`CREATE TABLE IF NOT EXISTS request_facts (
      request_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, workspace_id TEXT NOT NULL, origin_json TEXT NOT NULL,
      version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, deadline INTEGER NOT NULL,
      delivery TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
      policy_instance TEXT, policy_revision TEXT, terminal_reason TEXT, presentation_json TEXT,
      UNIQUE(owner, idempotency_key));
      CREATE TABLE IF NOT EXISTS request_commits (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_modes (session_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_delivery_attempts (request_id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER, finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS request_tool_results (request_id TEXT PRIMARY KEY, state TEXT NOT NULL, finished_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_mode_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, receipt_json TEXT NOT NULL);`);
    // Idempotent adoption retains legacy IDs and all terminal records. Never resend recovered requests.
    if (!(this.db.prepare('PRAGMA table_info(request_facts)').all() as { name: string }[]).some(c => c.name === 'presentation_json')) this.db.exec('ALTER TABLE request_facts ADD COLUMN presentation_json TEXT');
    if (!(this.db.prepare('PRAGMA table_info(request_facts)').all() as { name: string }[]).some(c => c.name === 'decision_receipt_json')) this.db.exec('ALTER TABLE request_facts ADD COLUMN decision_receipt_json TEXT');
    this.db.prepare(`INSERT OR IGNORE INTO request_facts
      (request_id, owner, workspace_id, origin_json, version, idempotency_key, deadline, delivery)
      SELECT a.id, ?, s.workspace_id, json_object('providerInstanceId', COALESCE(a.instance_id,s.harness_id),
      'driverGeneration','legacy-disconnected','nativeRequestId',a.native_request_id,'turnId',NULL),
      1, 'legacy:' || a.id, a.created_at + 120000, 'unavailable' FROM approvals a JOIN sessions s ON s.id=a.session_id`).run(instanceId);
    this.db.prepare("UPDATE request_facts SET delivery='unknown' WHERE owner=? AND delivery='sending'").run(instanceId);
    this.db.prepare("UPDATE request_delivery_attempts SET state='unknown' WHERE state='sending' AND request_id IN (SELECT request_id FROM request_facts WHERE owner=?)").run(instanceId);
    this.db.prepare("UPDATE request_facts SET delivery='unavailable' WHERE owner=? AND delivery='pending' AND request_id IN (SELECT id FROM approvals WHERE status<>'pending')").run(instanceId);
    for (const fact of this.list(undefined, true)) {
      if (fact.status === 'pending') this.terminate(fact.requestId, fact.deadlineAtMs <= Date.now() ? 'expired' : 'cancelled', 'restart_connection_lost', false);
    }
    // Replay missing approval.resolved events for legacy pre-expired approvals adopted on startup
    const missingResolved = this.db.prepare(
      `SELECT a.id FROM approvals a
       WHERE a.status = 'expired'
         AND NOT EXISTS (
           SELECT 1 FROM session_events e
           WHERE e.session_id = a.session_id
             AND e.type = 'approval.resolved'
             AND json_extract(e.payload_json, '$.approvalId') = a.id
         )`,
    ).all() as Array<{ id: string }>;
    for (const row of missingResolved) {
      const a = deps.store.getApproval(row.id);
      if (a) {
        this.event(a, 'approval.resolved');
        this.committedEvents.splice(0);
      }
    }
    for (const session of deps.store.listSessions({ includeArchived: true })) this.project(session.id);
    const pm = deps.getPluginManager();
    this.unsubscribePolicy = pm.host?.onServicesChanged(() => {
      if (!this.active) return;
      for (const [id, ref] of this.publicRefs) {
        if (pm.host.getServiceRecordByInstance(ref.instanceId, REQUEST_DELIVERY_CONTRACT)?.runId !== ref.runId) this.terminate(id, 'cancelled', 'origin_resource_stopped', false);
      }
      for (const f of this.list()) {
        if (!f.policyInstanceId) continue;
        const policyRecord = pm.host.listServiceProviders('approval.policy.v1').find(p => p.instanceId === f.policyInstanceId);
        const isolated = pm.isolated?.getActive(f.policyInstanceId);
        const revision = policyRecord?.runId ?? policyRecord?.version ?? isolated?.runId;
        const alive = !!pm.host.getServiceByInstance(f.policyInstanceId, 'approval.policy.v1') || !!isolated?.process.alive;
        if (alive) this.seenPolicies.add(f.policyInstanceId);
        if ((!alive && this.seenPolicies.has(f.policyInstanceId)) || (f.policyRevision && revision && f.policyRevision !== revision)) {
          this.terminate(f.requestId, 'cancelled', 'policy_provider_stopped');
        }
      }
    });
  }
  get(id: string): RuntimeRequestDto | null {
    const row = this.db.prepare('SELECT * FROM request_facts WHERE request_id=? AND owner=?').get(id, this.instanceId) as Record<string, any> | undefined;
    const approval = row && this.deps.store.getApproval(id);
    return row && approval ? { requestId: id, workspaceId: row.workspace_id, sessionId: approval.sessionId,
      origin: JSON.parse(row.origin_json), execution: this.db.prepare('SELECT state,finished_at AS finishedAtMs FROM request_tool_results WHERE request_id=?').get(id) as RuntimeRequestDto['execution'], version: row.version, idempotencyKey: row.idempotency_key,
      deadlineAtMs: row.deadline, status: approval.status, delivery: row.delivery, closed: !!row.closed,
      approval: approval as unknown as Record<string, unknown>, policyInstanceId: row.policy_instance ?? undefined,
      policyRevision: row.policy_revision ?? undefined, decisionReceipt: row.decision_receipt_json ? JSON.parse(row.decision_receipt_json) : undefined,
      presentation: row.presentation_json ? { ...JSON.parse(row.presentation_json), requestId: id, requestVersion: row.version } : undefined } : null;
  }
  list(sessionId?: string, history = false): RuntimeRequestDto[] {
    const rows = this.db.prepare(`SELECT request_id FROM request_facts f JOIN approvals a ON a.id=f.request_id
      WHERE owner=? ${sessionId ? 'AND a.session_id=?' : ''} ${history ? '' : "AND a.status='pending' AND f.closed=0"} ORDER BY a.created_at`).all(...(sessionId ? [this.instanceId, sessionId] : [this.instanceId])) as { request_id: string }[];
    return rows.map(row => this.get(row.request_id)!).filter(Boolean);
  }
  register(input: RequestCreateDto, resource?: Resource): RuntimeRequestDto {
    if (!this.active) throw new PluginApiError('E_PLUGIN_DISABLED', '请求提供方已停止');
    const prior = this.db.prepare('SELECT request_id FROM request_facts WHERE owner=? AND idempotency_key=?').get(this.instanceId, input.idempotencyKey) as { request_id: string } | undefined;
    if (prior) return this.get(prior.request_id)!;
    if (!resource && input.deliveryResource) resource = this.publicResource(input.deliveryResource);
    const approval = ApprovalRequestSchema.parse(input.approval);
    if (approval.status !== 'pending') throw new PluginApiError('E_INVALID_INPUT', '新请求必须处于待处理状态');
    const session = this.deps.store.getSession(approval.sessionId);
    if (session && approval.kind !== 'secret_request') {
      const notes = this.rules.evaluateLocalRules({ approvalId: approval.id, sessionId: session.id, workspaceId: session.workspaceId, cwd: session.cwd,
        kind: approval.kind ?? 'command_approval', toolName: approval.toolName, toolKind: approval.toolKind, summary: approval.summary,
        input: approval.input, diffPreview: approval.diffPreview, riskLevel: approval.riskLevel });
      approval.annotations = [...(approval.annotations ?? []), ...notes];
      const ranks = { low: 0, medium: 1, high: 2, critical: 3 };
      for (const n of notes) if (n.risk && ranks[n.risk] > ranks[approval.riskLevel]) approval.riskLevel = n.risk;
    }
    if (!approval.id || !approval.sessionId || !input.origin.driverGeneration) throw new Error('请求缺少稳定身份');
    if (approval.kind === 'secret_request') { approval.input = {}; approval.comment = null; approval.questionAnswer = null; }
    this.transaction(() => {
      this.deps.store.createApproval(approval);
      this.db.prepare(`INSERT INTO request_facts(request_id, owner, workspace_id, origin_json, version, idempotency_key, deadline, delivery)
        VALUES(?,?,?,?,1,?,?,?)`).run(approval.id, this.instanceId, input.workspaceId, JSON.stringify(input.origin), input.idempotencyKey, input.deadlineAtMs, resource ? 'pending' : 'unavailable');
      if (input.presentation) this.db.prepare('UPDATE request_facts SET presentation_json=? WHERE request_id=?').run(JSON.stringify(input.presentation), approval.id);
      const policy = this.deps.getPluginManager().resolveCapabilityBinding('approval.policy.v1', { sessionId: approval.sessionId, workspaceId: input.workspaceId });
      const pm = this.deps.getPluginManager();
      const policyRecord = pm.host?.listServiceProviders?.('approval.policy.v1').find(p => p.instanceId === policy.instanceId);
      const isolatedPolicy = policy.instanceId ? pm.isolated?.getActive(policy.instanceId) : undefined;
      const revision = policyRecord?.runId ?? policyRecord?.version ?? isolatedPolicy?.runId;
      if (policy.instanceId && (policyRecord || isolatedPolicy?.process.alive)) this.seenPolicies.add(policy.instanceId);
      this.db.prepare('UPDATE request_facts SET policy_instance=?,policy_revision=? WHERE request_id=?').run(policy.instanceId ?? null, revision ?? null, approval.id);
      this.commit(approval.id);
      this.project(approval.sessionId);
      this.event(approval, 'approval.requested');
    });
    if (resource) this.resources.set(approval.id, resource);
    if (input.deliveryResource) this.publicRefs.set(approval.id, input.deliveryResource);
    const timer = setTimeout(() => this.terminate(approval.id, 'expired', 'deadline_expired'), Math.max(0, input.deadlineAtMs - Date.now()));
    timer.unref(); this.timers.set(approval.id, timer);
    this.changed(approval.id);
    if (session) this.deps.eventBus.publishAttention({ kind: 'approval_needed', sessionId: session.id,
      sessionTitle: session.title, harnessId: session.harnessId, approvalId: approval.id,
      summary: approval.summary, timestamp: Date.now() });
    if (input.deadlineAtMs <= Date.now()) this.terminate(approval.id, 'expired', 'deadline_expired');
    else queueMicrotask(() => { void this.applyPolicy(approval.id).catch(() => { /* unavailable policy leaves visible pending; no fallback */ }); });
    return this.get(approval.id)!;
  }
  private publicResource(ref: NonNullable<RequestCreateDto['deliveryResource']>): Resource {
    const locate = () => {
      const pm = this.deps.getPluginManager();
      const record = pm.host.getServiceRecordByInstance(ref.instanceId, REQUEST_DELIVERY_CONTRACT);
      if (!record || record.runId !== ref.runId) throw new PluginApiError('E_STALE_RUN', '原请求执行资源已失效');
      const service = pm.host.getServiceByInstance<RequestDeliveryServiceV1>(ref.instanceId, REQUEST_DELIVERY_CONTRACT);
      if (!service) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '原请求执行提供方不可用');
      return service;
    };
    locate();
    return {
      validate: async response => { const result = await locate().validate({resourceId:ref.resourceId,response});
        if (!result.ok || !result.value.valid) throw new PluginApiError('E_INVALID_INPUT','原请求执行提供方拒绝此回复'); },
      deliver: async response => { let service: RequestDeliveryServiceV1;
        try { service = locate(); } catch { return 'unavailable'; }
        const result = await service.deliver({resourceId:ref.resourceId,response});
        return result.ok ? result.value.delivery : 'unknown'; },
      release: () => { try { void locate().release?.({resourceId:ref.resourceId}).catch(() => {}); } catch {} },
    };
  }
  createCli(params: Parameters<import('../../core/runtime-ports.js').RuntimeRequestPort['createAndEmitApproval']>[0]) {
      const { session, harnessId, nativeRequestId, kind, onTimeoutDeny, deliver, driverGeneration, providerInstanceId, ...fields } = params;
      const approval: ApprovalRequest = { ...fields, id: `appr_${crypto.randomBytes(8).toString('hex')}`, sessionId: session.id,
        parentSessionId: session.parentSessionId ?? null, instanceId: harnessId, nativeRequestId, kind,
        input: kind === 'secret_request' ? {} : fields.input ?? {}, diffPreview: fields.diffPreview ?? null,
        status: 'pending', resolvedBy: null, decision: null, comment: null, createdAt: Date.now(), resolvedAt: null };
      const fact = this.register({ approval: approval as unknown as Record<string, unknown>,
        workspaceId: session.workspaceId, origin: { providerInstanceId: providerInstanceId ?? harnessId, driverGeneration,
          nativeRequestId, turnId: params.turnId }, deadlineAtMs: Date.now() + (typeof this.deps.config?.timeoutMs === 'number' ? Math.max(1, this.deps.config.timeoutMs) : 120_000),
        idempotencyKey: `${session.id}:${driverGeneration}:${nativeRequestId}` }, { deliver });
      return fact.approval as unknown as ApprovalRequest;
    }
  private transaction(fn: () => void) {
    const queued = this.committedEvents.length;
    try { this.deps.store.runInImmediateTransaction(fn); }
    catch (error) { this.committedEvents.splice(queued); throw error; }
  }
  private commit(id: string) { const f = this.get(id)!; this.db.prepare('INSERT INTO request_commits(request_id,version) VALUES(?,?)').run(id, f.version); }
  private event(a: ApprovalRequest, type: 'approval.requested' | 'approval.resolved') {
    const event = this.deps.store.appendEvent(a.sessionId, type, type === 'approval.requested' ? { approval: a } : { approvalId: a.id, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, receipt: this.rules.buildReceiptSummary(a) }, this.get(a.id)?.origin.turnId);
    this.committedEvents.push(event);
    if (a.status !== 'pending') {
      const receipt = this.rules.buildReceiptSummary(a);
      const session = this.deps.store.getSession(a.sessionId);
      if (session) this.deps.store.upsertTurnItem({ itemId: `rtreq:${a.id}`, schemaVersion: 2, sessionId: a.sessionId,
        turnId: this.get(a.id)?.origin.turnId ?? `rtreq_${event.seq}`, seq: event.seq, instanceId: a.instanceId ?? session.harnessId,
        driverId: session.harnessKind, blockType: 'runtime_request', status: a.status === 'expired' || a.status === 'cancelled' ? 'cancelled' : 'completed',
        title: receipt.title, textBody: receipt.textBody, payload: receipt.payload, outputOmitted: false, omittedBytes: 0,
        createdAt: a.createdAt, updatedAt: event.createdAt });
    }
  }
  private project(sessionId: string) {
    const s = this.deps.store.getSession(sessionId); if (!s) return;
    const pending = this.deps.store.listPendingApprovals(sessionId).length; // fact query, no mutable counter
    const status = pending ? 'awaiting_approval' : s.status === 'awaiting_approval' ? (this.deps.store.listSessionRuns(sessionId).some(r => r.status === 'running') ? 'running' : 'idle') : s.status;
    if (status !== s.status) this.deps.store.updateSession(sessionId, { status });
  }
  private changed(id: string) {
    const f = this.get(id); if (!f) return;
    for (const ev of this.committedEvents.splice(0)) this.deps.eventBus.publishEvent(ev);
    // Commit cursor/version makes the projection rebuildable after a missed publication.
    const ev = this.deps.store.appendEvent(f.sessionId, 'runtime_request.updated', { request: f.approval, fact: f, requestVersion: f.version });
    this.deps.eventBus.publishEvent(ev);
    const s = this.deps.store.getSession(f.sessionId);
    if (s) this.deps.eventBus.publishEvent(this.deps.store.appendEvent(f.sessionId, 'session.status', { status: s.status }));
    this.publish?.({ requestId: id, version: f.version, sessionId: f.sessionId });
  }
  async evaluate(input: RequestPolicyInputDto, pinnedPolicy?: string): Promise<RequestPolicyDecisionDto & { policyInstanceId: string; policyRevision: string }> {
    const pm = this.deps.getPluginManager();
    const binding = pinnedPolicy ? { instanceId: pinnedPolicy } : pm.resolveCapabilityBinding('approval.policy.v1', input);
    if (!binding.instanceId) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '未绑定审批策略');
    const record = pm.host.listServiceProviders('approval.policy.v1').find(p => p.instanceId === binding.instanceId);
    const policyRevision = record?.runId ?? record?.version ?? pm.isolated?.getActive(binding.instanceId)?.runId ?? 'unavailable';
    const host = pm.host.getServiceByInstance<import('@harnessmate/plugin-api').ApprovalPolicyServiceV1>(binding.instanceId, 'approval.policy.v1');
    let result: RequestPolicyDecisionDto;
    if (host) result = await (host.evaluateRequest ? host.evaluateRequest(input) : host.evaluateToolCall({ ...input }));
    else {
      const target = pm.isolated?.getActive(binding.instanceId);
      if (!target?.process.alive) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `策略实例 ${binding.instanceId} 不可用`);
      result = await pm.isolated!.invokeApprovalPolicy(binding.instanceId, { ...input, args: input.args ?? {}, pluginId: 'runtime.requests', instanceId: this.instanceId });
    }
    this.seenPolicies.add(binding.instanceId);
    if (!result || !['allow','deny','ask'].includes(result.decision)) throw new PluginApiError('E_INVALID_INPUT', '策略返回了无效决策');
    // Compatibility policy that only knows tools must never answer typed questions or credentials.
    if (input.kind === 'user_question' || input.kind === 'secret_request') result = { decision: 'ask' };
    return { ...result, policyInstanceId: binding.instanceId, policyRevision };
  }
  private async applyPolicy(id: string) {
    let fact = this.get(id); if (!fact || fact.status !== 'pending') return;
    const external = this.legacyAnnotators(fact.workspaceId);
    if (external.length && fact.approval.kind !== 'secret_request') {
      const session = this.deps.store.getSession(fact.sessionId);
      if (session) await this.annotate(session, fact.approval as unknown as ApprovalRequest, external);
      fact = this.get(id); if (!fact || fact.status !== 'pending') return;
    }
    const a = fact.approval as unknown as ApprovalRequest;
    const s = this.deps.store.getSession(a.sessionId); if (!s) return;
    const result = await this.evaluate({ requestId: id, sessionId: a.sessionId, workspaceId: s.workspaceId,
      mode: s.permissionMode, kind: a.kind ?? 'command_approval', toolName: a.toolName, toolKind: a.toolKind,
      readOnly: a.toolKind === 'file_read', riskLevel: a.riskLevel, supportedDecisions: a.supportedDecisions ?? ['allow_once','deny'],
      source: fact.origin.runtimeId ? 'native' : fact.origin.connectionId === 'model_tool' ? 'model_tool' : 'cli', args: a.kind === 'secret_request' ? undefined : a.input as Record<string, unknown> }, fact.policyInstanceId);
    const current = this.get(id);
    if (!current || current.status !== 'pending' || current.version !== fact.version) return;
    this.transaction(() => {
      this.db.prepare('UPDATE request_facts SET policy_instance=?, policy_revision=?,version=version+1 WHERE request_id=? AND owner=?').run(result.policyInstanceId, result.policyRevision, id, this.instanceId);
      this.commit(id);
    });
    this.changed(id);
    if (result.decision === 'ask') return;
    const decision = result.decision === 'deny' ? 'deny' : result.scope === 'session' ? 'allow_session' : 'allow_once';
    if (!(a.supportedDecisions ?? ['allow_once','deny']).includes(decision)) return;
    await this.resolve({ requestId: id, expectedVersion: this.get(id)!.version, actor: 'auto', decision, comment: result.reason });
  }
  async resolve(input: RequestResolveDto) {
    let fact = this.get(input.requestId); if (!fact) throw new Error('Request not found');
    if (fact.status !== 'pending' || (input.expectedVersion !== undefined && fact.version !== input.expectedVersion)) return { accepted: false, conflict: true, request: fact };
    if (Date.now() >= fact.deadlineAtMs) { this.terminate(fact.requestId, 'expired', 'late_reply'); return { accepted: false, conflict: true, request: this.get(fact.requestId)! }; }
    const a = fact.approval as unknown as ApprovalRequest;
    const secret = a.kind === 'secret_request';
    if (input.actor === 'auto' && (secret || a.kind === 'user_question')) throw new Error('问题与凭据要求用户输入');
    const native = input.native;
    const selectedOption = native?.outcome === 'selected' ? (fact.presentation?.options as { optionId: string; kind: string; scope?: 'once' | 'session' | 'persistent' | 'unknown' }[] | undefined)?.find(o => o.optionId === native.optionId) : undefined;
    const nativeDecision = native?.outcome === 'cancelled' || selectedOption?.kind?.startsWith('reject') || selectedOption?.kind === 'decline' ? 'deny'
      : selectedOption?.kind === 'allow_always' && selectedOption.scope === 'session' ? 'allow_session' : selectedOption?.kind === 'allow_once' ? 'allow_once' : null;
    const decision = native ? nativeDecision : input.decision ?? (secret || a.kind === 'user_question' ? 'allow_once' : undefined);
    if (!decision && !native) throw new Error('缺少审批决策');
    if ((secret || a.kind === 'user_question') && decision === 'allow_session') throw new Error('输入请求不支持会话授权范围');
    if (!input.native && decision && a.kind !== 'user_question' && a.kind !== 'secret_request' && a.supportedDecisions && !a.supportedDecisions.includes(decision)) throw new Error('驱动不支持该授权范围');
    if (secret && decision !== 'deny' && !input.secretValue) throw new Error('请提供凭据内容或选择拒绝');
    if (native && String(native.generation) !== String(fact.origin.driverGeneration)) throw new Error('STALE_BINDING');
    const resource = this.resources.get(a.id);
    await resource?.validate?.(input); // preflight before decision CAS; recheck the version after await
    if (Date.now() >= fact.deadlineAtMs) { this.terminate(fact.requestId, 'expired', 'late_reply'); return {accepted:false,conflict:true,request:this.get(fact.requestId)!}; }
    let accepted = false;
    this.transaction(() => {
      const current = this.get(a.id)!;
      if (current.status !== 'pending' || current.version !== fact!.version) return;
      accepted = this.deps.store.resolveApprovalIfPending(a.id, decision ?? null, input.actor, secret ? undefined : input.comment,
        { statusOverride: (secret || a.kind === 'user_question') && decision !== 'deny' ? 'resolved' : undefined,
          secretProvided: secret && decision !== 'deny', questionAnswer: secret ? undefined : input.questionAnswer }).updated;
      if (!accepted) return;
      const receipt: RuntimeRequestDto['decisionReceipt'] = { actor: input.actor, decision: decision ?? undefined,
        ...(native ? { nativeOutcome: String(native.outcome), optionId: selectedOption?.optionId, scope: selectedOption?.scope ?? (selectedOption?.kind === 'allow_once' ? 'once' : 'unknown') } : { scope: decision === 'allow_session' ? 'session' : 'once' }) };
      this.db.prepare("UPDATE request_facts SET version=version+1, delivery=?,decision_receipt_json=? WHERE request_id=? AND owner=?").run(resource ? 'pending' : 'unavailable', JSON.stringify(receipt), a.id, this.instanceId);
      this.event(this.deps.store.getApproval(a.id)!, 'approval.resolved'); this.commit(a.id); this.project(a.sessionId);
    });
    if (!accepted) return { accepted: false, conflict: true, request: this.get(a.id)! };
    this.clearTimer(a.id); this.changed(a.id);
    await this.deliver(a.id, { ...input, decision: decision ?? undefined });
    // Do not retain secrets in closures/resources or persistent outbox payloads.
    input.secretValue = undefined;
    fact = this.get(a.id)!;
    return { accepted: true, conflict: false, request: fact };
  }
  private async deliver(id: string, input: RequestResolveDto) {
    const resource = this.resources.get(id); if (!resource) return;
    this.transaction(() => {
      this.db.prepare("UPDATE request_facts SET delivery='sending',version=version+1 WHERE request_id=? AND owner=?").run(id, this.instanceId);
      this.db.prepare("INSERT INTO request_delivery_attempts VALUES(?,'sending',?,NULL) ON CONFLICT(request_id) DO UPDATE SET state='sending',started_at=excluded.started_at").run(id, Date.now());
      this.commit(id);
    });
    this.changed(id);
    let result: RuntimeRequestDto['delivery'] = 'unknown';
    try { result = await resource.deliver(input); } catch { /* bytes may have reached driver: never retry */ }
    finally { this.resources.delete(id); this.publicRefs.delete(id); resource.release?.(); input.secretValue = undefined; }
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.db.prepare('UPDATE request_facts SET delivery=?,version=version+1 WHERE request_id=? AND owner=?').run(result, id, this.instanceId);
      this.db.prepare('UPDATE request_delivery_attempts SET state=?,finished_at=? WHERE request_id=?').run(result, Date.now(), id);
      this.commit(id);
    });
    this.changed(id);
  }
  terminate(id: string, status: 'expired' | 'cancelled', reason: string, send = true) {
    const f = this.get(id); if (!f || f.status !== 'pending') return false;
    let accepted = false;
    this.transaction(() => {
      const current = this.get(id);
      if (!current || current.status !== 'pending' || current.version !== f.version) return;
      accepted = this.deps.store.resolveApprovalIfPending(id, 'deny', 'auto', reason, { statusOverride: status }).updated;
      if (!accepted) return;
      this.db.prepare('UPDATE request_facts SET version=version+1,terminal_reason=?,delivery=? WHERE request_id=? AND owner=?').run(reason, send && this.resources.has(id) ? 'pending' : 'unavailable', id, this.instanceId);
      this.event(this.deps.store.getApproval(id)!, 'approval.resolved'); this.commit(id); this.project(f.sessionId);
    });
    if (!accepted) return false;
    this.clearTimer(id); this.changed(id);
    if (send) void this.deliver(id, { requestId: id, actor: 'auto', decision: 'deny', comment: reason });
    else { this.resources.get(id)?.release?.(); this.resources.delete(id); this.publicRefs.delete(id); }
    return true;
  }
  cancelSession(sessionId: string | undefined, reason: string, generation?: string) { let count = 0; for (const f of this.list(sessionId)) if ((!generation || f.origin.driverGeneration === generation) && this.terminate(f.requestId, 'cancelled', reason)) count++; return count; }
  private clearTimer(id: string) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  close(id: string) { const f = this.get(id); if (!f || f.status === 'pending') return false; if (f.closed) return true; this.db.prepare('UPDATE request_facts SET closed=1,version=version+1 WHERE request_id=? AND owner=?').run(id, this.instanceId); this.commit(id); this.changed(id); return true; }
  async annotate(session: Session, approval: ApprovalRequest, extra: readonly ExternalApprovalAnnotator[] = this.legacyAnnotators(session.workspaceId)) {
    if (approval.kind === 'secret_request') return approval;
    const result = await this.rules.evaluateWithPlugins({ approvalId: approval.id, sessionId: session.id, workspaceId: session.workspaceId, cwd: session.cwd, kind: approval.kind ?? 'command_approval', toolName: approval.toolName, toolKind: approval.toolKind, summary: approval.summary, input: approval.input, diffPreview: approval.diffPreview, riskLevel: approval.riskLevel }, extra);
    this.transaction(() => {
      this.deps.store.setApprovalAnnotationsAndRisk(approval.id, result.annotations, result.highestRisk);
      this.db.prepare('UPDATE request_facts SET version=version+1 WHERE request_id=? AND owner=?').run(approval.id, this.instanceId);
      this.commit(approval.id);
    });
    this.changed(approval.id); return this.deps.store.getApproval(approval.id);
  }
  private legacyAnnotators(workspaceId: string): ExternalApprovalAnnotator[] {
    const pm = this.deps.getPluginManager();
    return (pm.listInstalled?.() ?? []).flatMap(info => {
      const entry = pm.isolated?.getActive(info.instanceId ?? info.id);
      if (!entry?.hasApprovalAnnotate || !entry.process.alive || !pm.permissions?.isGranted(info, 'approvals:annotate', workspaceId)) return [];
      return [{pluginId:entry.pluginId,annotate:async (context: Parameters<ExternalApprovalAnnotator['annotate']>[0]) => {
        const result = await entry.process.call<{annotations?: import('@harnessmate/protocol').ApprovalAnnotationDto[]}>(
          'host.approval.annotate', {event:{approvalId:context.approvalId,sessionId:context.sessionId,workspaceId,
            toolName:context.toolName,toolKind:context.toolKind,summary:context.summary,riskLevel:context.riskLevel}},
          typeof this.deps.config?.annotatorTimeoutMs === 'number' ? Math.max(1,this.deps.config.annotatorTimeoutMs) : 300, entry.runId);
        return (result.annotations ?? []).map(note=>({...note,pluginId:entry.pluginId}));
      }}];
    });
  }
  addAnnotation(id: string, pluginId: string, note: {label?: unknown; detail?: unknown; risk?: unknown}) {
    const fact = this.get(id); if (!fact) throw new PluginApiError('E_INVALID_INPUT','请求不存在');
    if (fact.approval.kind === 'secret_request') return;
    if (typeof note.label !== 'string' || !note.label.trim()) throw new PluginApiError('E_INVALID_INPUT','审批标注缺少 label');
    const risk = ['low','medium','high','critical'].includes(String(note.risk)) ? note.risk as ApprovalRequest['riskLevel'] : undefined;
    this.transaction(() => {
      this.deps.store.addApprovalAnnotation(id,{pluginId,risk,label:String(note.label).trim().slice(0,120),detail:typeof note.detail === 'string' ? note.detail.slice(0,500) : undefined});
      this.db.prepare('UPDATE request_facts SET version=version+1 WHERE request_id=? AND owner=?').run(id,this.instanceId); this.commit(id);
    });
    this.changed(id);
  }
  recordExecution(id: string, state: 'succeeded' | 'failed') {
    if (!this.db.isOpen) return;
    if (!this.get(id)) return;
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO request_tool_results VALUES(?,?,?)').run(id, state, Date.now());
      this.db.prepare('UPDATE request_facts SET version=version+1 WHERE request_id=? AND owner=?').run(id, this.instanceId);
      this.commit(id);
    });
    this.changed(id);
  }
  stop() { this.active = false; this.publish = undefined; this.unsubscribePolicy?.(); this.cancelSession(undefined, 'request_provider_stopped'); for (const id of this.timers.keys()) this.clearTimer(id); }
  service: RuntimeRequestsServiceV1 = {
    create: async input => ok(this.register(input)),
    snapshot: async input => { for (const f of this.list(input.sessionId)) if (f.deadlineAtMs <= Date.now()) this.terminate(f.requestId, 'expired', 'deadline_expired'); return ok({ requests: this.list(input.sessionId, input.includeHistory), version: Number((this.db.prepare('SELECT MAX(seq) AS seq FROM request_commits').get() as any)?.seq ?? 0) }); },
    resolve: async input => ok(await this.resolve(input)),
    cancel: async input => ok({ cancelled: this.cancelSession(input.sessionId, input.reason) }),
    close: async input => ok({ closed: this.close(input.requestId) }),
    evaluate: async input => ok(await this.evaluate(input)),
    recordMode: async input => {
      const providers = this.deps.getPluginManager().host?.listServiceProviders('approval.policy.v1') ?? [];
      const policy = providers.find(p => p.instanceId === input.policyInstanceId);
      const receipt = { ...input, policyRevision: input.policyRevision ?? policy?.runId ?? policy?.version ?? null };
      this.transaction(() => {
        this.db.prepare('INSERT OR REPLACE INTO request_modes VALUES(?,?)').run(input.sessionId, JSON.stringify(receipt));
        this.db.prepare('INSERT INTO request_mode_history(session_id,receipt_json) VALUES(?,?)').run(input.sessionId, JSON.stringify(receipt));
      });
      this.publish?.({ sessionId: input.sessionId, mode: receipt }); return ok(receipt);
    },
    listRules: async () => ok({ rules: this.rules.listRules() }),
    addRule: async input => { this.rules.addCustomRule(input as unknown as Parameters<ApprovalCenterService['addCustomRule']>[0]); return ok({ rules: this.rules.listRules() }); },
    deleteRule: async input => { this.rules.deleteCustomRule(input.id); return ok({ rules: this.rules.listRules() }); },
    getMode: async input => { const row = this.db.prepare('SELECT receipt_json FROM request_modes WHERE session_id=?').get(input.sessionId) as any; return ok(row ? JSON.parse(row.receipt_json) as RequestModeReceiptDto : null); },
  };
}
export function activeRequestBrokers(pm: PluginManager): RequestBroker[] {
  return pm.host.listServiceProviders(REQUESTS_INTERNAL).map(p => pm.host.getServiceByInstance<RequestBroker>(p.instanceId, REQUESTS_INTERNAL)).filter((v): v is RequestBroker => !!v);
}
export function getRequestBroker(pm: PluginManager, sessionId?: string, requestId?: string): RequestBroker {

  // Existing requests stay pinned to their owning instance across binding edits.
  const providers = pm.host.listServiceProviders(REQUESTS_INTERNAL);
  if (requestId) {
    for (const provider of providers) {
      const broker = pm.host.getServiceByInstance<RequestBroker>(provider.instanceId, REQUESTS_INTERNAL);
      if (broker?.get(requestId)) return broker;
    }
    throw new PluginApiError('E_PLUGIN_DISABLED', '原请求提供方不可用或请求不存在');
  }
  const selected = pm.resolveCapabilityBinding(RUNTIME_REQUESTS_CONTRACT, { sessionId });
  const broker = selected.instanceId ? pm.host.getServiceByInstance<RequestBroker>(selected.instanceId, REQUESTS_INTERNAL) : undefined;
  if (!broker) throw new PluginApiError('E_PLUGIN_DISABLED', '所选请求提供方未启用');
  return broker;
}
export function createRequestsPlugin(deps: RequestPluginDeps): Omit<HostPlugin, 'id' | 'enabled'> {
  return { provides: [RUNTIME_REQUESTS_CONTRACT, REQUESTS_INTERNAL, 'approval-center'], apply(ctx, config) {
    const broker = new RequestBroker({ ...deps, config }, ctx.instanceId ?? REQUESTS_PLUGIN_ID, payload => ctx.services?.publish(RUNTIME_REQUESTS_CONTRACT, payload));
    ctx.provide(RUNTIME_REQUESTS_CONTRACT, broker.service, { version: '1.0.0' });
    ctx.provide(REQUESTS_INTERNAL, broker); ctx.provide('approval-center', broker.rules);
    ctx.effect(() => () => broker.stop());
  } };
}
