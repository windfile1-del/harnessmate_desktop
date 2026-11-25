import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGY_NATIVE_CONTRACT_REVISION,
  AGY_NATIVE_CONTRACT_VERSION,
  ActivitySchema,
  AgentIdentitySchema,
  BindingGenerationSchema,
  CapabilityDescriptorSchema,
  NativeCanonicalEventSchema,
  NativeRelationshipSchema,
  NativeRuntimeProjectionSchema,
  NativeWorkSchema,
  NativeWorkflowSchema,
  RuntimeIdSchema,
  asBindingGeneration,
  asNativeAgentId,
  asRuntimeId,
  sanitizeAgentIdentityForPublic,
  sanitizeNativeRelationshipForPublic,
  sanitizeNativeWorkForPublic,
  sanitizeNativeWorkflowForPublic,
  type Activity,
  type AgentIdentity,
  type BindingGeneration,
  type CapabilityDescriptor,
  type NativeAgentId,
  type NativeCanonicalEvent,
  type NativeRelationship,
  type NativeRequestReceiptState,
  type NativeRuntimeProjection,
  type NativeRuntimeStatus,
  type NativeWork,
  type NativeWorkflow,
  type RuntimeBinding,
  type RuntimeId,
} from '@harnessmate/protocol';
import type { HarnessMateStore, NativeRuntimeSchemaStatus } from '../../../../db/sqlite.js';
import type { NativeCommitMutation, NativeEventDraft } from './types.js';

export interface StoredNativeBinding {
  runtimeId: RuntimeId;
  sessionId: string;
  instanceId: string;
  bindingRevision: number;
  profileRef: string;
  sourceRef: string;
  generation: BindingGeneration;
  status: NativeRuntimeStatus;
  asOfSeq: number;
  capabilitiesRevision: number;
  retentionReasons: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredNativeReceipt {
  receiptId: string;
  runtimeId: RuntimeId;
  sessionId: string;
  generation: BindingGeneration;
  kind: 'command' | 'control' | 'approval';
  idempotencyKey: string | null;
  payloadDigest: string | null;
  approvalId: string | null;
  state: string;
  responseJson: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface DecodedNativeCursor {
  v: 1;
  runtimeId: RuntimeId;
  generation: BindingGeneration;
  seq: number;
}

export type NativeEventsReadResult =
  | {
      resyncRequired: false;
      runtimeId: RuntimeId;
      generation: BindingGeneration;
      events: NativeCanonicalEvent[];
      nextSeq: number;
      nextCursor: string;
      hasMore: boolean;
    }
  | {
      resyncRequired: true;
      reason: string;
      latestSeq: number;
      currentGeneration: BindingGeneration | null;
    };

export class NativePersistenceError extends Error {
  constructor(
    readonly code:
      | 'NATIVE_SCHEMA_NEWER_THAN_READER'
      | 'IDEMPOTENCY_CONFLICT'
      | 'RELATION_CYCLE_DETECTED'
      | 'RELATION_PARENT_CONFLICT'
      | 'BINDING_NOT_FOUND'
      | 'IMMUTABLE_PROFILE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'NativePersistenceError';
  }
}

export function computePayloadDigest(payload: unknown): string {
  const canonical = stableJsonStringify(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonStringify(v)}`).join(',')}}`;
}

export function encodeNativeCursor(
  runtimeId: RuntimeId,
  generation: BindingGeneration,
  seq: number,
): string {
  const payload = JSON.stringify({ v: 1, r: runtimeId, g: generation, s: seq });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeNativeCursor(cursor: string): DecodedNativeCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { v?: unknown; r?: unknown; g?: unknown; s?: unknown };
    if (parsed.v !== 1 || typeof parsed.s !== 'number' || !Number.isSafeInteger(parsed.s) || parsed.s < 0) {
      return null;
    }
    const runtimeId = RuntimeIdSchema.safeParse(parsed.r);
    const generation = BindingGenerationSchema.safeParse(parsed.g);
    if (!runtimeId.success || !generation.success) {
      return null;
    }
    return {
      v: 1,
      runtimeId: runtimeId.data,
      generation: generation.data,
      seq: parsed.s,
    };
  } catch {
    return null;
  }
}

interface BindingRow {
  runtime_id: string;
  session_id: string;
  instance_id: string;
  binding_revision: number;
  profile_ref: string;
  source_ref: string;
  current_generation: string;
  status: string;
  as_of_seq: number;
  capabilities_revision: number;
  retention_reasons_json: string;
  created_at: number;
  updated_at: number;
}

interface EntityRow {
  runtime_id: string;
  entity_kind: string;
  entity_id: string;
  schema_version: number;
  revision: number;
  generation: string;
  session_id: string;
  lineage_scope: string | null;
  payload_json: string;
  updated_at: number;
}

interface RelationRow {
  runtime_id: string;
  parent_agent_id: string;
  child_agent_id: string;
  generation: string;
  confidence: string;
  launch_work_id: string | null;
  evidence_json: string;
  revoked_at: number | null;
  updated_at: number;
}

interface NativeEventRow {
  runtime_id: string;
  seq: number;
  generation: string;
  session_id: string;
  turn_id: string | null;
  hm_anchor_seq: number | null;
  type: string;
  mutation_key: string | null;
  payload_json: string;
  created_at: number;
}

interface ReceiptRow {
  receipt_id: string;
  runtime_id: string;
  session_id: string;
  generation: string;
  kind: string;
  idempotency_key: string | null;
  payload_digest: string | null;
  approval_id: string | null;
  state: string;
  response_json: string | null;
  created_at: number;
  updated_at: number;
}

function mapBindingRow(row: BindingRow): StoredNativeBinding {
  return {
    runtimeId: asRuntimeId(row.runtime_id),
    sessionId: row.session_id,
    instanceId: row.instance_id,
    bindingRevision: row.binding_revision,
    profileRef: row.profile_ref,
    sourceRef: row.source_ref,
    generation: asBindingGeneration(row.current_generation),
    status: row.status as NativeRuntimeStatus,
    asOfSeq: row.as_of_seq,
    capabilitiesRevision: row.capabilities_revision,
    retentionReasons: safeJsonParse<string[]>(row.retention_reasons_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRow(row: NativeEventRow): NativeCanonicalEvent {
  return NativeCanonicalEventSchema.parse({
    schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
    runtimeId: row.runtime_id,
    sessionId: row.session_id,
    generation: row.generation,
    seq: row.seq,
    turnId: row.turn_id,
    ...(row.hm_anchor_seq !== null ? { hmAnchorSeq: row.hm_anchor_seq } : {}),
    createdAt: row.created_at,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

function mapReceiptRow(row: ReceiptRow): StoredNativeReceipt {
  return {
    receiptId: row.receipt_id,
    runtimeId: asRuntimeId(row.runtime_id),
    sessionId: row.session_id,
    generation: asBindingGeneration(row.generation),
    kind: row.kind as StoredNativeReceipt['kind'],
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest,
    approvalId: row.approval_id,
    state: row.state,
    responseJson: row.response_json ? safeJsonParse(row.response_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class NativeRuntimeStore {
  constructor(private readonly store: HarnessMateStore) {}

  getSchemaStatus(): NativeRuntimeSchemaStatus {
    return this.store.getNativeRuntimeSchemaStatus();
  }

  private assertSchemaCompatible(): void {
    const status = this.store.getNativeRuntimeSchemaStatus();
    if (!status.compatible) {
      throw new NativePersistenceError(
        'NATIVE_SCHEMA_NEWER_THAN_READER',
        `Stored agy-native-runtime schema version ${status.storedVersion} is newer than supported version ${status.supportedVersion}`,
      );
    }
  }

  ensureBinding(params: {
    sessionId: string;
    instanceId: string;
    profileRef: string;
    sourceRef?: string;
    generation?: BindingGeneration;
    status?: NativeRuntimeStatus;
  }): StoredNativeBinding {
    this.assertSchemaCompatible();
    const sourceRef = params.sourceRef ?? 'acp';
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare(
          `SELECT * FROM native_runtime_bindings
           WHERE session_id = ? AND instance_id = ?
           ORDER BY binding_revision DESC LIMIT 1`,
        )
        .get(params.sessionId, params.instanceId) as unknown as BindingRow | undefined;

      if (existing) {
        if (existing.profile_ref !== params.profileRef || existing.source_ref !== sourceRef) {
          // Immutable profile/source ref changed: allocate a new binding_revision and fresh runtimeId/generation
          const nextRev = existing.binding_revision + 1;
          const now = Date.now();
          const runtimeId = asRuntimeId(`nrt_${crypto.randomBytes(6).toString('hex')}`);
          const generation =
            params.generation ?? asBindingGeneration(`gen_${crypto.randomBytes(5).toString('hex')}`);
          db.prepare(
            `INSERT INTO native_runtime_bindings (
              runtime_id, session_id, instance_id, binding_revision, profile_ref, source_ref,
              current_generation, status, as_of_seq, capabilities_revision, retention_reasons_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', ?, ?)`,
          ).run(
            runtimeId,
            params.sessionId,
            params.instanceId,
            nextRev,
            params.profileRef,
            sourceRef,
            generation,
            params.status ?? 'disconnected',
            now,
            now,
          );
          const created = db
            .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
            .get(runtimeId) as unknown as BindingRow;
          return mapBindingRow(created);
        }
        return mapBindingRow(existing);
      }

      const now = Date.now();
      const runtimeId = asRuntimeId(`nrt_${crypto.randomBytes(6).toString('hex')}`);
      const generation =
        params.generation ?? asBindingGeneration(`gen_${crypto.randomBytes(5).toString('hex')}`);
      db.prepare(
        `INSERT INTO native_runtime_bindings (
          runtime_id, session_id, instance_id, binding_revision, profile_ref, source_ref,
          current_generation, status, as_of_seq, capabilities_revision, retention_reasons_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, 0, '[]', ?, ?)`,
      ).run(
        runtimeId,
        params.sessionId,
        params.instanceId,
        params.profileRef,
        sourceRef,
        generation,
        params.status ?? 'disconnected',
        now,
        now,
      );
      const created = db
        .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
        .get(runtimeId) as unknown as BindingRow;
      return mapBindingRow(created);
    });
  }

  getBinding(runtimeId: RuntimeId): StoredNativeBinding | null {
    this.assertSchemaCompatible();
    const row = this.store
      .getDatabaseSync()
      .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
      .get(runtimeId) as unknown as BindingRow | undefined;
    return row ? mapBindingRow(row) : null;
  }

  getLatestBindingForSession(sessionId: string, instanceId?: string): StoredNativeBinding | null {
    this.assertSchemaCompatible();
    const db = this.store.getDatabaseSync();
    const row = instanceId
      ? (db
          .prepare(
            `SELECT * FROM native_runtime_bindings
             WHERE session_id = ? AND instance_id = ?
             ORDER BY binding_revision DESC LIMIT 1`,
          )
          .get(sessionId, instanceId) as unknown as BindingRow | undefined)
      : (db
          .prepare(
            `SELECT * FROM native_runtime_bindings
             WHERE session_id = ?
             ORDER BY updated_at DESC, binding_revision DESC LIMIT 1`,
          )
          .get(sessionId) as unknown as BindingRow | undefined);
    return row ? mapBindingRow(row) : null;
  }

  advanceGeneration(
    runtimeId: RuntimeId,
    opts?: { generation?: BindingGeneration; status?: NativeRuntimeStatus },
  ): StoredNativeBinding {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
        .get(runtimeId) as unknown as BindingRow | undefined;
      if (!existing) {
        throw new NativePersistenceError('BINDING_NOT_FOUND', `Native runtime binding not found: ${runtimeId}`);
      }
      const nextGen =
        opts?.generation ?? asBindingGeneration(`gen_${crypto.randomBytes(5).toString('hex')}`);
      const now = Date.now();
      db.prepare(
        `UPDATE native_runtime_bindings
         SET current_generation = ?, status = COALESCE(?, status), updated_at = ?
         WHERE runtime_id = ?`,
      ).run(nextGen, opts?.status ?? null, now, runtimeId);
      const updated = db
        .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
        .get(runtimeId) as unknown as BindingRow;
      return mapBindingRow(updated);
    });
  }

  /**
   * Atomically applies snapshot mutations (entities, aliases, acyclic single-parent relations,
   * binding status/cursor) AND appends the durable NativeCanonicalEvent inside a single
   * BEGIN IMMEDIATE transaction.
   *
   * If `eventDraft.mutationKey` already exists for this runtime, returns the existing event
   * without duplicating writes or advancing seq.
   *
   * Callers MUST only publish the returned event to live subscribers AFTER this method commits.
   */
  commitSnapshotAndEvent(
    binding: RuntimeBinding,
    mutation: NativeCommitMutation,
    eventDraft: NativeEventDraft,
    opts?: { beforeCommitHookForTest?: (db: DatabaseSync) => void },
  ): { deduplicated: boolean; event: NativeCanonicalEvent; binding: StoredNativeBinding } {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const bindingRow = db
        .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
        .get(binding.runtimeId) as unknown as BindingRow | undefined;
      if (!bindingRow) {
        throw new NativePersistenceError(
          'BINDING_NOT_FOUND',
          `Native runtime binding not found: ${binding.runtimeId}`,
        );
      }

      if (eventDraft.mutationKey) {
        const existingEventRow = db
          .prepare(
            'SELECT * FROM native_runtime_events WHERE runtime_id = ? AND mutation_key = ?',
          )
          .get(binding.runtimeId, eventDraft.mutationKey) as unknown as NativeEventRow | undefined;
        if (existingEventRow) {
          return {
            deduplicated: true,
            event: mapEventRow(existingEventRow),
            binding: mapBindingRow(bindingRow),
          };
        }
      }

      const now = eventDraft.createdAt ?? Date.now();

      // 1. Upsert activities
      const upsertEntity = db.prepare(
        `INSERT INTO native_runtime_entities (
          runtime_id, entity_kind, entity_id, schema_version, revision, generation,
          session_id, lineage_scope, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runtime_id, entity_kind, entity_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          revision = excluded.revision,
          generation = excluded.generation,
          lineage_scope = excluded.lineage_scope,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      );

      for (const act of mutation.activities ?? []) {
        const parsed = ActivitySchema.parse(act);
        upsertEntity.run(
          binding.runtimeId,
          'activity',
          parsed.id,
          AGY_NATIVE_CONTRACT_VERSION,
          1,
          binding.generation,
          binding.sessionId,
          parsed.agentId ?? parsed.workId ?? null,
          JSON.stringify(parsed),
          now,
        );
      }

      for (const work of mutation.work ?? []) {
        const parsed = NativeWorkSchema.parse(work);
        upsertEntity.run(
          binding.runtimeId,
          'work',
          parsed.id,
          AGY_NATIVE_CONTRACT_VERSION,
          parsed.revision,
          binding.generation,
          binding.sessionId,
          parsed.workflowId ?? parsed.ownerAgentId ?? parsed.originActivityId ?? null,
          JSON.stringify(parsed),
          now,
        );
      }

      for (const agent of mutation.agents ?? []) {
        const parsed = AgentIdentitySchema.parse(agent);
        upsertEntity.run(
          binding.runtimeId,
          'agent',
          parsed.id,
          AGY_NATIVE_CONTRACT_VERSION,
          parsed.revision,
          binding.generation,
          binding.sessionId,
          parsed.lineage,
          JSON.stringify(parsed),
          now,
        );
      }

      for (const workflow of mutation.workflows ?? []) {
        const parsed = NativeWorkflowSchema.parse(workflow);
        upsertEntity.run(
          binding.runtimeId,
          'workflow',
          parsed.id,
          AGY_NATIVE_CONTRACT_VERSION,
          parsed.revision,
          binding.generation,
          binding.sessionId,
          parsed.originActivityId,
          JSON.stringify(parsed),
          now,
        );
      }

      if (mutation.capabilityDescriptors) {
        const validated = mutation.capabilityDescriptors.map((d) =>
          CapabilityDescriptorSchema.parse(d),
        );
        upsertEntity.run(
          binding.runtimeId,
          'capability_snapshot',
          'default',
          AGY_NATIVE_CONTRACT_VERSION,
          mutation.capabilitiesRevision ?? bindingRow.capabilities_revision,
          binding.generation,
          binding.sessionId,
          null,
          JSON.stringify(validated),
          now,
        );
      }

      // 2. Upsert aliases (server-only, scoped by runtimeId + namespace + generation + originSessionId + nativeValue)
      const upsertAlias = db.prepare(
        `INSERT INTO native_runtime_aliases (
          runtime_id, namespace, generation, origin_session_id, native_value,
          target_entity_kind, target_entity_id, incarnation, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runtime_id, namespace, generation, origin_session_id, native_value) DO UPDATE SET
          target_entity_kind = excluded.target_entity_kind,
          target_entity_id = excluded.target_entity_id,
          incarnation = excluded.incarnation,
          evidence_json = excluded.evidence_json`,
      );
      for (const item of mutation.aliases ?? []) {
        upsertAlias.run(
          binding.runtimeId,
          item.alias.namespace,
          binding.generation,
          item.alias.originSessionId ?? '',
          item.alias.nativeValue,
          item.targetEntityKind,
          item.targetEntityId,
          item.alias.incarnation ?? null,
          JSON.stringify(item.alias.evidence),
          now,
        );
      }

      // 3. Upsert / revoke relations enforcing single-parent and acyclicity invariants
      for (const rel of mutation.relationsUpsert ?? []) {
        const parsed = NativeRelationshipSchema.parse(rel);
        if (parsed.parentAgentId === parsed.childAgentId) {
          throw new NativePersistenceError(
            'RELATION_CYCLE_DETECTED',
            `Agent ${parsed.childAgentId} cannot be its own parent`,
          );
        }
        this.assertNoAncestorCycle(db, binding.runtimeId, parsed.parentAgentId, parsed.childAgentId);

        const existingRel = db
          .prepare(
            `SELECT parent_agent_id, revoked_at FROM native_runtime_relations
             WHERE runtime_id = ? AND child_agent_id = ?`,
          )
          .get(binding.runtimeId, parsed.childAgentId) as
          | { parent_agent_id: string; revoked_at: number | null }
          | undefined;

        if (
          existingRel &&
          existingRel.revoked_at === null &&
          existingRel.parent_agent_id !== parsed.parentAgentId
        ) {
          throw new NativePersistenceError(
            'RELATION_PARENT_CONFLICT',
            `Child agent ${parsed.childAgentId} already has active parent ${existingRel.parent_agent_id}`,
          );
        }

        db.prepare(
          `INSERT INTO native_runtime_relations (
            runtime_id, parent_agent_id, child_agent_id, generation, confidence,
            launch_work_id, evidence_json, revoked_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(runtime_id, child_agent_id) DO UPDATE SET
            parent_agent_id = excluded.parent_agent_id,
            generation = excluded.generation,
            confidence = excluded.confidence,
            launch_work_id = excluded.launch_work_id,
            evidence_json = excluded.evidence_json,
            revoked_at = NULL,
            updated_at = excluded.updated_at`,
        ).run(
          binding.runtimeId,
          parsed.parentAgentId,
          parsed.childAgentId,
          binding.generation,
          parsed.confidence,
          parsed.launchWorkId ?? null,
          JSON.stringify(parsed.evidence),
          now,
        );
      }

      for (const rev of mutation.relationsRevoke ?? []) {
        db.prepare(
          `UPDATE native_runtime_relations
           SET revoked_at = ?, updated_at = ?
           WHERE runtime_id = ? AND child_agent_id = ?`,
        ).run(rev.revokedAt, now, binding.runtimeId, rev.childAgentId);
      }

      // 4. Allocate next monotonic seq and persist durable event
      const nextSeq = bindingRow.as_of_seq + 1;
      const event = NativeCanonicalEventSchema.parse({
        schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
        runtimeId: binding.runtimeId,
        sessionId: binding.sessionId,
        generation: binding.generation,
        seq: nextSeq,
        turnId: eventDraft.turnId,
        ...(eventDraft.hmAnchorSeq !== undefined ? { hmAnchorSeq: eventDraft.hmAnchorSeq } : {}),
        createdAt: now,
        type: eventDraft.type,
        payload: eventDraft.payload,
      });

      db.prepare(
        `INSERT INTO native_runtime_events (
          runtime_id, seq, generation, session_id, turn_id, hm_anchor_seq,
          type, mutation_key, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.runtimeId,
        event.seq,
        event.generation,
        event.sessionId,
        event.turnId,
        event.hmAnchorSeq ?? null,
        event.type,
        eventDraft.mutationKey ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      );

      // 5. Advance binding cursor and metadata in the same transaction
      const nextStatus = mutation.status ?? (bindingRow.status as NativeRuntimeStatus);
      const nextRetention = mutation.retentionReasons
        ? JSON.stringify([...mutation.retentionReasons])
        : bindingRow.retention_reasons_json;
      const nextCapRev =
        mutation.capabilitiesRevision !== undefined
          ? mutation.capabilitiesRevision
          : bindingRow.capabilities_revision;

      db.prepare(
        `UPDATE native_runtime_bindings
         SET current_generation = ?,
             status = ?,
             as_of_seq = ?,
             capabilities_revision = ?,
             retention_reasons_json = ?,
             updated_at = ?
         WHERE runtime_id = ?`,
      ).run(
        binding.generation,
        nextStatus,
        nextSeq,
        nextCapRev,
        nextRetention,
        now,
        binding.runtimeId,
      );

      opts?.beforeCommitHookForTest?.(db);

      const updatedBinding = db
        .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
        .get(binding.runtimeId) as unknown as BindingRow;

      return {
        deduplicated: false,
        event,
        binding: mapBindingRow(updatedBinding),
      };
    });
  }

  private assertNoAncestorCycle(
    db: DatabaseSync,
    runtimeId: RuntimeId,
    parentAgentId: NativeAgentId,
    childAgentId: NativeAgentId,
  ): void {
    let cursor: string | null = parentAgentId;
    const visited = new Set<string>([childAgentId]);
    const stmt = db.prepare(
      `SELECT parent_agent_id FROM native_runtime_relations
       WHERE runtime_id = ? AND child_agent_id = ? AND revoked_at IS NULL`,
    );
    while (cursor) {
      if (visited.has(cursor)) {
        throw new NativePersistenceError(
          'RELATION_CYCLE_DETECTED',
          `Relation ${parentAgentId} -> ${childAgentId} would introduce an ancestor cycle`,
        );
      }
      visited.add(cursor);
      const row = stmt.get(runtimeId, cursor) as { parent_agent_id?: string } | undefined;
      cursor = row?.parent_agent_id ?? null;
    }
  }

  readProjection(
    runtimeId: RuntimeId,
    opts: { enabled: boolean; nowMs?: number },
  ): NativeRuntimeProjection | null {
    this.assertSchemaCompatible();
    const db = this.store.getDatabaseSync();
    const bindingRow = db
      .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
      .get(runtimeId) as unknown as BindingRow | undefined;
    if (!bindingRow) return null;

    const binding = mapBindingRow(bindingRow);
    const nowMs = opts.nowMs ?? Date.now();
    const entityRows = db
      .prepare('SELECT * FROM native_runtime_entities WHERE runtime_id = ? ORDER BY updated_at ASC')
      .all(runtimeId) as unknown as EntityRow[];

    const activities: Activity[] = [];
    const work = [];
    const agents = [];
    const workflows = [];

    for (const row of entityRows) {
      const parsedJson = safeJsonParse<unknown>(row.payload_json, null);
      if (!parsedJson) continue;
      if (row.entity_kind === 'activity') {
        const res = ActivitySchema.safeParse(parsedJson);
        if (res.success) activities.push(res.data);
      } else if (row.entity_kind === 'work') {
        const res = NativeWorkSchema.safeParse(parsedJson);
        if (res.success) work.push(sanitizeNativeWorkForPublic(res.data, nowMs));
      } else if (row.entity_kind === 'agent') {
        const res = AgentIdentitySchema.safeParse(parsedJson);
        if (res.success) agents.push(sanitizeAgentIdentityForPublic(res.data, nowMs));
      } else if (row.entity_kind === 'workflow') {
        const res = NativeWorkflowSchema.safeParse(parsedJson);
        if (res.success) workflows.push(sanitizeNativeWorkflowForPublic(res.data, nowMs));
      }
    }

    const relRows = db
      .prepare(
        `SELECT * FROM native_runtime_relations
         WHERE runtime_id = ? AND revoked_at IS NULL
         ORDER BY updated_at ASC`,
      )
      .all(runtimeId) as unknown as RelationRow[];

    const relations = [];
    for (const row of relRows) {
      const parsed = NativeRelationshipSchema.safeParse({
        parentAgentId: asNativeAgentId(row.parent_agent_id),
        childAgentId: asNativeAgentId(row.child_agent_id),
        confidence: row.confidence,
        ...(row.launch_work_id ? { launchWorkId: row.launch_work_id } : {}),
        evidence: safeJsonParse(row.evidence_json, null),
      });
      if (parsed.success) {
        relations.push(sanitizeNativeRelationshipForPublic(parsed.data, nowMs));
      }
    }

    const pendingReceiptRows = db
      .prepare(
        `SELECT approval_id FROM native_runtime_receipts
         WHERE runtime_id = ? AND kind = 'approval' AND state = 'pending' AND approval_id IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all(runtimeId) as unknown as Array<{ approval_id: string }>;

    const requestIds = pendingReceiptRows.map((r) => r.approval_id);

    return NativeRuntimeProjectionSchema.parse({
      schemaVersion: AGY_NATIVE_CONTRACT_VERSION,
      contractRevision: AGY_NATIVE_CONTRACT_REVISION,
      enabled: opts.enabled,
      binding: {
        runtimeId: binding.runtimeId,
        sessionId: binding.sessionId,
        instanceId: binding.instanceId,
        generation: binding.generation,
      },
      asOfSeq: binding.asOfSeq,
      status: binding.status,
      capabilitiesRevision: binding.capabilitiesRevision,
      retentionReasons: binding.retentionReasons,
      activities,
      work,
      agents,
      relations,
      workflows,
      requestIds,
    });
  }

  readCapabilitySnapshot(runtimeId: RuntimeId): {
    capabilitiesRevision: number;
    descriptors: CapabilityDescriptor[];
  } | null {
    this.assertSchemaCompatible();
    const db = this.store.getDatabaseSync();
    const row = db
      .prepare(
        `SELECT revision, payload_json FROM native_runtime_entities
         WHERE runtime_id = ? AND entity_kind = 'capability_snapshot' AND entity_id = 'default'`,
      )
      .get(runtimeId) as { revision?: number; payload_json?: string } | undefined;
    if (!row?.payload_json) return null;
    const raw = safeJsonParse<unknown[]>(row.payload_json, []);
    const descriptors: CapabilityDescriptor[] = [];
    for (const item of raw) {
      const parsed = CapabilityDescriptorSchema.safeParse(item);
      if (parsed.success) descriptors.push(parsed.data);
    }
    return {
      capabilitiesRevision: row.revision ?? 0,
      descriptors,
    };
  }

  listEvents(
    runtimeId: RuntimeId,
    opts: {
      afterSeq: number;
      limit: number;
      cursor?: string;
      expectedGeneration?: BindingGeneration;
    },
  ): NativeEventsReadResult {
    this.assertSchemaCompatible();
    const db = this.store.getDatabaseSync();
    const bindingRow = db
      .prepare('SELECT * FROM native_runtime_bindings WHERE runtime_id = ?')
      .get(runtimeId) as unknown as BindingRow | undefined;
    if (!bindingRow) {
      return {
        resyncRequired: true,
        reason: 'binding_not_found',
        latestSeq: 0,
        currentGeneration: null,
      };
    }

    const currentGeneration = asBindingGeneration(bindingRow.current_generation);
    let effectiveAfterSeq = opts.afterSeq;

    if (opts.cursor) {
      const decoded = decodeNativeCursor(opts.cursor);
      if (!decoded) {
        return {
          resyncRequired: true,
          reason: 'invalid_cursor',
          latestSeq: bindingRow.as_of_seq,
          currentGeneration,
        };
      }
      if (decoded.runtimeId !== runtimeId || decoded.generation !== currentGeneration) {
        return {
          resyncRequired: true,
          reason: 'stale_cursor_generation',
          latestSeq: bindingRow.as_of_seq,
          currentGeneration,
        };
      }
      effectiveAfterSeq = decoded.seq;
    }

    if (opts.expectedGeneration && opts.expectedGeneration !== currentGeneration) {
      return {
        resyncRequired: true,
        reason: 'generation_changed',
        latestSeq: bindingRow.as_of_seq,
        currentGeneration,
      };
    }

    if (effectiveAfterSeq > bindingRow.as_of_seq) {
      return {
        resyncRequired: true,
        reason: 'cursor_ahead_of_head',
        latestSeq: bindingRow.as_of_seq,
        currentGeneration,
      };
    }

    // Detect pruned event log gap when caller asks for an older sequence than oldest retained row
    const minRow = db
      .prepare('SELECT MIN(seq) AS min_seq FROM native_runtime_events WHERE runtime_id = ?')
      .get(runtimeId) as { min_seq: number | null } | undefined;
    if (
      minRow?.min_seq !== null &&
      minRow?.min_seq !== undefined &&
      effectiveAfterSeq > 0 &&
      effectiveAfterSeq < minRow.min_seq - 1
    ) {
      return {
        resyncRequired: true,
        reason: 'cursor_pruned',
        latestSeq: bindingRow.as_of_seq,
        currentGeneration,
      };
    }

    const cappedLimit = Math.min(Math.max(1, opts.limit), 500);
    const rows = db
      .prepare(
        `SELECT * FROM native_runtime_events
         WHERE runtime_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(runtimeId, effectiveAfterSeq, cappedLimit + 1) as unknown as NativeEventRow[];

    const hasMore = rows.length > cappedLimit;
    const sliced = hasMore ? rows.slice(0, cappedLimit) : rows;
    const events = sliced.map(mapEventRow);
    const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : effectiveAfterSeq;

    return {
      resyncRequired: false,
      runtimeId,
      generation: currentGeneration,
      events,
      nextSeq,
      nextCursor: encodeNativeCursor(runtimeId, currentGeneration, nextSeq),
      hasMore,
    };
  }

  /**
   * Idempotency key + payload digest check for POST /commands and POST /control.
   * Same key + same digest -> returns existing receipt (`replayed: true`).
   * Same key + different digest -> throws `IDEMPOTENCY_CONFLICT`.
   */
  claimIdempotentReceipt(params: {
    binding: RuntimeBinding;
    kind: 'command' | 'control';
    idempotencyKey: string;
    payloadDigest: string;
  }): { replayed: boolean; receipt: StoredNativeReceipt } {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare(
          `SELECT * FROM native_runtime_receipts
           WHERE runtime_id = ? AND kind = ? AND idempotency_key = ?`,
        )
        .get(params.binding.runtimeId, params.kind, params.idempotencyKey) as unknown as
        | ReceiptRow
        | undefined;

      if (existing) {
        if (existing.payload_digest !== params.payloadDigest) {
          throw new NativePersistenceError(
            'IDEMPOTENCY_CONFLICT',
            `Idempotency key "${params.idempotencyKey}" already used with a different request payload`,
          );
        }
        return { replayed: true, receipt: mapReceiptRow(existing) };
      }

      const now = Date.now();
      const receiptId = `nrcpt_${crypto.randomBytes(6).toString('hex')}`;
      db.prepare(
        `INSERT INTO native_runtime_receipts (
          receipt_id, runtime_id, session_id, generation, kind, idempotency_key,
          payload_digest, approval_id, state, response_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'claimed', NULL, ?, ?)`,
      ).run(
        receiptId,
        params.binding.runtimeId,
        params.binding.sessionId,
        params.binding.generation,
        params.kind,
        params.idempotencyKey,
        params.payloadDigest,
        now,
        now,
      );
      const inserted = db
        .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
        .get(receiptId) as unknown as ReceiptRow;
      return { replayed: false, receipt: mapReceiptRow(inserted) };
    });
  }

  completeIdempotentReceipt(
    receiptId: string,
    state: string,
    responseJson: unknown,
  ): StoredNativeReceipt | null {
    this.assertSchemaCompatible();
    const now = Date.now();
    const db = this.store.getDatabaseSync();
    db.prepare(
      `UPDATE native_runtime_receipts
       SET state = ?, response_json = ?, updated_at = ?
       WHERE receipt_id = ?`,
    ).run(state, JSON.stringify(responseJson), now, receiptId);
    const updated = db
      .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
      .get(receiptId) as unknown as ReceiptRow | undefined;
    return updated ? mapReceiptRow(updated) : null;
  }

  createPendingApprovalReceipt(params: {
    binding: RuntimeBinding;
    approvalId: string;
  }): StoredNativeReceipt {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare(
          `SELECT * FROM native_runtime_receipts
           WHERE runtime_id = ? AND kind = 'approval' AND approval_id = ?`,
        )
        .get(params.binding.runtimeId, params.approvalId) as unknown as ReceiptRow | undefined;
      if (existing) return mapReceiptRow(existing);

      const now = Date.now();
      const receiptId = `nrcpt_${crypto.randomBytes(6).toString('hex')}`;
      db.prepare(
        `INSERT INTO native_runtime_receipts (
          receipt_id, runtime_id, session_id, generation, kind, idempotency_key,
          payload_digest, approval_id, state, response_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'approval', NULL, NULL, ?, 'pending', NULL, ?, ?)`,
      ).run(
        receiptId,
        params.binding.runtimeId,
        params.binding.sessionId,
        params.binding.generation,
        params.approvalId,
        now,
        now,
      );
      const inserted = db
        .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
        .get(receiptId) as unknown as ReceiptRow;
      return mapReceiptRow(inserted);
    });
  }

  /**
   * Database CAS claim preventing double-click vs auto-expiry races on native approvals.
   */
  claimApprovalReceiptCas(params: {
    approvalId: string;
    expectedGeneration: BindingGeneration;
    idempotencyKey?: string;
  }): { claimed: boolean; receipt: StoredNativeReceipt | null } {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare(
          `SELECT * FROM native_runtime_receipts
           WHERE kind = 'approval' AND approval_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(params.approvalId) as unknown as ReceiptRow | undefined;
      if (!existing) return { claimed: false, receipt: null };

      if (existing.generation !== params.expectedGeneration || existing.state !== 'pending') {
        return { claimed: false, receipt: mapReceiptRow(existing) };
      }

      const now = Date.now();
      const res = db
        .prepare(
          `UPDATE native_runtime_receipts
           SET state = 'claimed',
               idempotency_key = COALESCE(idempotency_key, ?),
               updated_at = ?
           WHERE receipt_id = ? AND generation = ? AND state = 'pending'`,
        )
        .run(
          params.idempotencyKey ?? null,
          now,
          existing.receipt_id,
          params.expectedGeneration,
        );

      const updated = db
        .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
        .get(existing.receipt_id) as unknown as ReceiptRow;
      return {
        claimed: Number(res.changes) === 1,
        receipt: mapReceiptRow(updated),
      };
    });
  }

  transitionApprovalReceiptState(
    receiptId: string,
    fromStates: readonly NativeRequestReceiptState[],
    toState: NativeRequestReceiptState,
    responseMetadata?: Record<string, unknown>,
  ): { transitioned: boolean; receipt: StoredNativeReceipt | null } {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const existing = db
        .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
        .get(receiptId) as unknown as ReceiptRow | undefined;
      if (!existing) return { transitioned: false, receipt: null };

      if (!fromStates.includes(existing.state as NativeRequestReceiptState)) {
        return { transitioned: false, receipt: mapReceiptRow(existing) };
      }
      const now = Date.now();
      db.prepare(
        `UPDATE native_runtime_receipts
         SET state = ?,
             response_json = COALESCE(?, response_json),
             updated_at = ?
         WHERE receipt_id = ?`,
      ).run(
        toState,
        responseMetadata ? JSON.stringify(responseMetadata) : null,
        now,
        receiptId,
      );
      const updated = db
        .prepare('SELECT * FROM native_runtime_receipts WHERE receipt_id = ?')
        .get(receiptId) as unknown as ReceiptRow;
      return { transitioned: true, receipt: mapReceiptRow(updated) };
    });
  }

  /**
   * Marks live pending/claimed native approval receipts as connection_lost / delivery_unknown
   * on disconnect or crash recovery. Old authorizations are NEVER replayed on reconnect.
   */
  invalidateApprovalReceiptsForRuntime(
    runtimeId: RuntimeId,
    generation?: BindingGeneration,
  ): { lostCount: number; unknownCount: number } {
    this.assertSchemaCompatible();
    return this.store.runInImmediateTransaction((db) => {
      const now = Date.now();
      const lostRes = generation
        ? db
            .prepare(
              `UPDATE native_runtime_receipts
               SET state = 'connection_lost', updated_at = ?
               WHERE runtime_id = ? AND generation = ? AND kind = 'approval' AND state = 'pending'`,
            )
            .run(now, runtimeId, generation)
        : db
            .prepare(
              `UPDATE native_runtime_receipts
               SET state = 'connection_lost', updated_at = ?
               WHERE runtime_id = ? AND kind = 'approval' AND state = 'pending'`,
            )
            .run(now, runtimeId);

      const unknownRes = generation
        ? db
            .prepare(
              `UPDATE native_runtime_receipts
               SET state = 'delivery_unknown', updated_at = ?
               WHERE runtime_id = ? AND generation = ? AND kind = 'approval' AND state = 'claimed'`,
            )
            .run(now, runtimeId, generation)
        : db
            .prepare(
              `UPDATE native_runtime_receipts
               SET state = 'delivery_unknown', updated_at = ?
               WHERE runtime_id = ? AND kind = 'approval' AND state = 'claimed'`,
            )
            .run(now, runtimeId);

      return {
        lostCount: Number(lostRes.changes),
        unknownCount: Number(unknownRes.changes),
      };
    });
  }

  markAttachedBindingsReconcilingOnStartup(): number {
    const status = this.store.getNativeRuntimeSchemaStatus();
    if (!status.compatible) return 0;
    return this.store.runInImmediateTransaction((db) => {
      const now = Date.now();
      const changed = db
        .prepare(
          `UPDATE native_runtime_bindings
           SET status = 'reconciling', updated_at = ?
           WHERE status = 'attached'`,
        )
        .run(now).changes;
      db.prepare(
        `UPDATE native_runtime_receipts
         SET state = 'connection_lost', updated_at = ?
         WHERE kind = 'approval' AND state = 'pending'`,
      ).run(now);
      db.prepare(
        `UPDATE native_runtime_receipts
         SET state = 'delivery_unknown', updated_at = ?
         WHERE kind = 'approval' AND state = 'claimed'`,
      ).run(now);
      return Number(changed);
    });
  }
}
