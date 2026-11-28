import { ApprovalRepository, initializeApprovalSchema } from '../plugins/requests-default/persistence.js';
import { DatabaseSync } from 'node:sqlite';
import {
  AGY_NATIVE_MIGRATION_COMPONENT,
  AGY_NATIVE_MIGRATION_VERSION,
  type ApprovalAnnotationDto,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  CanonicalEvent,
  CanonicalEventType,
  ContextInjectionDriver,
  ContextSyncMode,
  DailyTokenBucket,
  DiscoveredCliSession,
  EffectOutboxDurability,
  EffectOutboxRecord,
  EffectOutboxStatus,
  HandoffDeliveryStatus,
  HarnessKind,
  PairedDevice,
  PluginPanelQuery,
  PluginProjection,
  PluginTurnRow,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  RuntimeRequestKind,
  SecretRequestSpec,
  Session,
  SessionCheckpointRecord,
  SessionHandoffRecord,
  SessionHarnessBinding,
  SessionRunRecord,
  SessionRunStatus,
  SessionSearchHit,
  SessionStatus,
  SessionTaskState,
  SubagentDiffStat,
  SubagentIsolation,
  SubagentRunRecord,
  SubagentStatus,
  TaskFailedAttempt,
  TaskStep,
  TaskVerification,
  TokenUsage,
  ToolKind,
  TurnBlockRecord,
  TurnBlockStatus,
  UserQuestionAnswer,
  UserQuestionSpec,
  Workspace,
} from '@harnessmate/protocol';

export interface ResourceOwnerRecord {
  resourceType: 'workspace' | 'session';
  resourceId: string;
  contract: string;
  instanceId: string;
  workspaceId: string | null;
  updatedAt: number;
}

export interface SessionTurnReceiptRecord {
  sessionId: string;
  requestId: string;
  requestHash: string;
  turnId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  runtimeInstanceId: string;
  runtimeRunId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SqlTransactionContext {
  exec(sql: string): void;
  prepare(sql: string): ReturnType<DatabaseSync['prepare']>;
  markCommittedSeq(seq: number): void;
}

export interface SqlTransactionAccess {
  runImmediate<T>(fn: (tx: SqlTransactionContext) => T): T;
  runRead<T>(fn: (tx: { prepare(sql: string): ReturnType<DatabaseSync['prepare']> }) => T): T;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  is_git_repo: number;
  git_branch: string | null;
  created_at: number;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  harness_id: string;
  harness_kind: string;
  native_session_id: string | null;
  parent_session_id?: string | null;
  forked_from_turn_seq?: number | null;
  fork_mode?: string | null;
  import_mode?: string | null;
  import_source?: string | null;
  participating_harnesses_json: string | null;
  context_sync_mode: string | null;
  cwd: string;
  worktree_branch: string | null;
  title: string;
  status: string;
  model: string | null;
  actual_model: string | null;
  model_rerouted_reason: string | null;
  reasoning_effort: string | null;
  permission_mode: string;
  last_seq: number;
  usage_json: string | null;
  created_at: number;
  updated_at: number;
  pending_approval_count?: number;
}

interface BindingRow {
  session_id: string;
  harness_id: string;
  harness_kind: string;
  native_session_id: string | null;
  last_model: string | null;
  last_actual_model: string | null;
  last_effort: string | null;
  synced_up_to_seq: number;
  driver_used: string | null;
  updated_at: number;
}

interface TaskStateRow {
  session_id: string;
  objective: string;
  steps_json: string;
  decisions_json: string;
  touched_files_json: string;
  verifications_json: string;
  blockers_json: string;
  pinned_facts_json: string;
  failed_attempts_json?: string | null;
  rolling_summary: string;
  summarized_up_to_seq: number;
  version: number;
  ledger_file_path: string | null;
  updated_at: number;
}

interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  turn_id: string | null;
  payload_json: string;
  created_at: number;
}


export interface StoredPluginPermission {
  pluginId: string;
  digest: string;
  capability: string;
  coverFuture: boolean;
  declaredPermissions: string[];
}

interface DeviceRow {
  id: string;
  device_name: string;
  platform: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

interface SubagentRunRow {
  subagent_id: string;
  cohort_id: string;
  parent_session_id: string;
  child_session_id: string;
  target_instance_id: string;
  target_driver_id: string | null;
  role_title: string;
  prompt: string;
  isolation: string;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  effective_approval_policy: string;
  requested_approval_policy: string | null;
  depth: number;
  timeout_ms: number;
  fail_fast: number;
  status: string;
  diff_stat_json: string | null;
  summary: string | null;
  error: string | null;
  merged_at: number | null;
  merged_into_branch: string | null;
  worktree_cleaned: number;
  created_at: number;
  finished_at: number | null;
}

export interface LocalHarnessUsageAggregate {
  harnessId: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface LocalInstanceUsageAggregate extends LocalHarnessUsageAggregate {
  instanceId: string;
  dailyBuckets: DailyTokenBucket[];
}

export interface NativeRuntimeSchemaStatus {
  component: typeof AGY_NATIVE_MIGRATION_COMPONENT;
  supportedVersion: number;
  storedVersion: number;
  compatible: boolean;
  newerThanReader: boolean;
}

export type SessionChangeKind = 'upsert_item' | 'upsert_session' | 'delete_session' | 'delete_item';

export interface HistoryImportMappingRecord {
  sourceId: string;
  nativeSessionId: string;
  sessionId: string;
  legacySource?: string | null;
  sourceInstanceId?: string | null;
  sourcePath?: string | null;
  harnessKind?: string | null;
  createdAt: number;
}

export interface HistoryImportReceiptRecord {
  requestId: string;
  requestHash: string;
  sessionId: string;
  disposition: 'created' | 'reused';
  partial: boolean;
  warnings: string[];
  createdAt: number;
}

export interface SnapshotTurnItemRow {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  itemId: string;
  turnId: string;
  turnSeq: number;
  driverId: string;
  blockType: string;
  textBody: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommittedChangeRawRow {
  changeSeq: number;
  kind: SessionChangeKind;
  sessionId: string;
  workspaceId: string;
  itemId: string | null;
  committedAt: number;
  payloadJson: string | null;
  turnId: string | null;
  turnSeq: number | null;
  driverId: string | null;
  blockType: string | null;
  textBody: string | null;
  itemPayloadJson: string | null;
  itemCreatedAt: number | null;
  itemUpdatedAt: number | null;
  sessionTitle: string | null;
  harnessId: string | null;
  harnessKind: string | null;
  sessionStatus: string | null;
  sessionUpdatedAt: number | null;
}

export class HarnessMateStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private txDepth = 0;
  private pendingCommitSeq: number | null = null;
  private readonly commitListeners = new Set<(latestSeq: number) => void>();
  private nativeSchemaStatus: NativeRuntimeSchemaStatus = {
    component: AGY_NATIVE_MIGRATION_COMPONENT,
    supportedVersion: AGY_NATIVE_MIGRATION_VERSION,
    storedVersion: 0,
    compatible: true,
    newerThanReader: false,
  };

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        is_git_repo INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        native_session_id TEXT,
        cwd TEXT NOT NULL,
        worktree_branch TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        actual_model TEXT,
        model_rerouted_reason TEXT,
        reasoning_effort TEXT,
        permission_mode TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated
        ON sessions(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS native_history_imports (
        source TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_path TEXT,
        PRIMARY KEY (source, native_session_id)
      );

      CREATE TABLE IF NOT EXISTS session_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        turn_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_plugin_turn_events ON session_events(session_id, turn_id, seq)
        WHERE type IN ('turn.completed', 'turn.failed', 'turn.cancelled');
      CREATE INDEX IF NOT EXISTS idx_plugin_tool_events ON session_events(session_id, turn_id, seq)
        WHERE type IN ('tool.call.started', 'tool.call.completed');
      CREATE INDEX IF NOT EXISTS idx_approval_resolution_events
        ON session_events(session_id, json_extract(payload_json, '$.approvalId')) WHERE type = 'approval.resolved';

      CREATE TABLE IF NOT EXISTS plugin_permissions (
        workspace_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        capability TEXT NOT NULL,
        cover_future INTEGER NOT NULL DEFAULT 0,
        declared_permissions_json TEXT,
        PRIMARY KEY (workspace_id, plugin_id, capability)
      );

      CREATE TABLE IF NOT EXISTS plugin_global_permissions (
        plugin_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        capability TEXT NOT NULL,
        cover_future INTEGER NOT NULL DEFAULT 0,
        declared_permissions_json TEXT,
        PRIMARY KEY (plugin_id, capability)
      );

      CREATE TABLE IF NOT EXISTS plugin_kv_storage (
        scope TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS capability_bindings (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        contract TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_id, contract)
      );

      CREATE TABLE IF NOT EXISTS paired_devices (
        id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS session_harness_bindings (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        native_session_id TEXT,
        last_model TEXT,
        last_actual_model TEXT,
        last_effort TEXT,
        synced_up_to_seq INTEGER NOT NULL DEFAULT 0,
        driver_used TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, harness_id)
      );

      CREATE INDEX IF NOT EXISTS idx_bindings_session
        ON session_harness_bindings(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_task_state (
        session_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[]',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        touched_files_json TEXT NOT NULL DEFAULT '[]',
        verifications_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        pinned_facts_json TEXT NOT NULL DEFAULT '[]',
        failed_attempts_json TEXT NOT NULL DEFAULT '[]',
        rolling_summary TEXT NOT NULL DEFAULT '',
        summarized_up_to_seq INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        ledger_file_path TEXT,
        updated_at INTEGER NOT NULL
      );

      -- ── Phase 0 V2 Materialized Projection, Runs, Outbox, Handoff, Checkpoints & FTS5 ──

      CREATE TABLE IF NOT EXISTS session_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        failure_class TEXT,
        usage_json TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_session_runs_session_started
        ON session_runs(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS session_turn_items (
        item_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        seq INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        block_type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        text_body TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        output_omitted INTEGER NOT NULL DEFAULT 0,
        omitted_bytes INTEGER NOT NULL DEFAULT 0,
        raw_ref_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_items_session_seq
        ON session_turn_items(session_id, seq ASC);
      CREATE INDEX IF NOT EXISTS idx_turn_items_session_turn
        ON session_turn_items(session_id, turn_id, seq ASC);

      CREATE TABLE IF NOT EXISTS command_receipts (
        receipt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        command_type TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS effect_outbox (
        effect_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        effect_type TEXT NOT NULL,
        durability TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_effect_outbox_status
        ON effect_outbox(status, durability, created_at ASC);

      CREATE TABLE IF NOT EXISTS session_handoffs (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        from_instance_id TEXT,
        to_instance_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        delivery_channel TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        covered_up_to_seq INTEGER NOT NULL DEFAULT 0,
        estimated_chars INTEGER NOT NULL DEFAULT 0,
        redacted_count INTEGER NOT NULL DEFAULT 0,
        force_fresh_reason TEXT,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_session_handoffs_session_target
        ON session_handoffs(session_id, to_instance_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL,
        phase TEXT NOT NULL,
        git_ref TEXT NOT NULL,
        tree_sha TEXT NOT NULL,
        base_head_sha TEXT,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        skipped_large_files_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session_turn
        ON session_checkpoints(session_id, turn_seq DESC);

      CREATE TABLE IF NOT EXISTS subagent_runs (
        subagent_id TEXT PRIMARY KEY,
        cohort_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        target_instance_id TEXT NOT NULL,
        target_driver_id TEXT,
        role_title TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        isolation TEXT NOT NULL,
        worktree_path TEXT,
        branch_name TEXT,
        base_branch TEXT,
        effective_approval_policy TEXT NOT NULL,
        requested_approval_policy TEXT,
        depth INTEGER NOT NULL DEFAULT 1,
        timeout_ms INTEGER NOT NULL DEFAULT 900000,
        fail_fast INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        diff_stat_json TEXT,
        summary TEXT,
        error TEXT,
        merged_at INTEGER,
        merged_into_branch TEXT,
        worktree_cleaned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
        ON subagent_runs(parent_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_cohort
        ON subagent_runs(cohort_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_child
        ON subagent_runs(child_session_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
        session_id UNINDEXED,
        item_id UNINDEXED,
        turn_id UNINDEXED,
        driver_id UNINDEXED,
        title,
        body
      );

      CREATE TABLE IF NOT EXISTS history_import_mappings (
        source_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        legacy_source TEXT,
        source_instance_id TEXT,
        source_path TEXT,
        harness_kind TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, native_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_history_import_mappings_session
        ON history_import_mappings(session_id);

      CREATE TABLE IF NOT EXISTS history_import_receipts (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        disposition TEXT NOT NULL,
        partial INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_change_log (
        change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        item_id TEXT,
        payload_json TEXT,
        committed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_change_log_ws_seq
        ON session_change_log(workspace_id, change_seq ASC);
      CREATE INDEX IF NOT EXISTS idx_session_change_log_session
        ON session_change_log(session_id, change_seq ASC);

      CREATE TABLE IF NOT EXISTS resource_owners (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        contract TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        workspace_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (resource_type, resource_id, contract)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_owners_instance
        ON resource_owners(instance_id, contract);

      CREATE TABLE IF NOT EXISTS session_turn_receipts (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL DEFAULT '',
        turn_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        runtime_run_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_turn_receipts_status
        ON session_turn_receipts(status, runtime_instance_id);
    `);

    // Safe additive column migrations for existing user databases
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('actual_model')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN actual_model TEXT;');
    }
    if (!colNames.has('model_rerouted_reason')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN model_rerouted_reason TEXT;');
    }
    if (!colNames.has('participating_harnesses_json')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN participating_harnesses_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!colNames.has('context_sync_mode')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN context_sync_mode TEXT NOT NULL DEFAULT 'auto';");
    }
    if (!colNames.has('parent_session_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;');
    }
    if (!colNames.has('forked_from_turn_seq')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN forked_from_turn_seq INTEGER;');
    }
    if (!colNames.has('fork_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN fork_mode TEXT;');
    }
    if (!colNames.has('import_mode')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN import_mode TEXT;');
    }
    if (!colNames.has('import_source')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN import_source TEXT;');
    }

    const permCols = new Set((this.db.prepare('PRAGMA table_info(plugin_permissions)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!permCols.has('cover_future')) {
      this.db.exec('ALTER TABLE plugin_permissions ADD COLUMN cover_future INTEGER NOT NULL DEFAULT 0;');
    }
    if (!permCols.has('declared_permissions_json')) {
      this.db.exec('ALTER TABLE plugin_permissions ADD COLUMN declared_permissions_json TEXT;');
    }
    const permTableSql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plugin_permissions'").get() as { sql?: string } | undefined
    )?.sql;
    if (permTableSql && /REFERENCES\s+workspaces/i.test(permTableSql)) {
      this.db.exec(`
        CREATE TABLE plugin_permissions_v2 (
          workspace_id TEXT NOT NULL,
          plugin_id TEXT NOT NULL,
          digest TEXT NOT NULL,
          capability TEXT NOT NULL,
          cover_future INTEGER NOT NULL DEFAULT 0,
          declared_permissions_json TEXT,
          PRIMARY KEY (workspace_id, plugin_id, capability)
        );
        INSERT INTO plugin_permissions_v2 (workspace_id, plugin_id, digest, capability, cover_future, declared_permissions_json)
        SELECT workspace_id, plugin_id, digest, capability, cover_future, declared_permissions_json FROM plugin_permissions;
        DROP TABLE plugin_permissions;
        ALTER TABLE plugin_permissions_v2 RENAME TO plugin_permissions;
      `);
    }
    initializeApprovalSchema(this.db);
    const taskCols = new Set((this.db.prepare('PRAGMA table_info(session_task_state)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!taskCols.has('failed_attempts_json')) {
      this.db.exec("ALTER TABLE session_task_state ADD COLUMN failed_attempts_json TEXT NOT NULL DEFAULT '[]';");
    }
    const taskTableSql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_task_state'").get() as { sql?: string } | undefined
    )?.sql;
    if (taskTableSql && /REFERENCES\s+sessions/i.test(taskTableSql)) {
      this.db.exec(`
        CREATE TABLE session_task_state_v2 (
          session_id TEXT PRIMARY KEY,
          objective TEXT NOT NULL DEFAULT '',
          steps_json TEXT NOT NULL DEFAULT '[]',
          decisions_json TEXT NOT NULL DEFAULT '[]',
          touched_files_json TEXT NOT NULL DEFAULT '[]',
          verifications_json TEXT NOT NULL DEFAULT '[]',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          pinned_facts_json TEXT NOT NULL DEFAULT '[]',
          failed_attempts_json TEXT NOT NULL DEFAULT '[]',
          rolling_summary TEXT NOT NULL DEFAULT '',
          summarized_up_to_seq INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          ledger_file_path TEXT,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_task_state_v2 (
          session_id, objective, steps_json, decisions_json, touched_files_json,
          verifications_json, blockers_json, pinned_facts_json, failed_attempts_json,
          rolling_summary, summarized_up_to_seq, version, ledger_file_path, updated_at
        )
        SELECT
          session_id, objective, steps_json, decisions_json, touched_files_json,
          verifications_json, blockers_json, pinned_facts_json, failed_attempts_json,
          rolling_summary, summarized_up_to_seq, version, ledger_file_path, updated_at
        FROM session_task_state;
        DROP TABLE session_task_state;
        ALTER TABLE session_task_state_v2 RENAME TO session_task_state;
      `);
    }
    const bindingCols = new Set((this.db.prepare('PRAGMA table_info(session_harness_bindings)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!bindingCols.has('continuation_key')) {
      this.db.exec('ALTER TABLE session_harness_bindings ADD COLUMN continuation_key TEXT;');
    }
    if (!bindingCols.has('last_handoff_id')) {
      this.db.exec('ALTER TABLE session_harness_bindings ADD COLUMN last_handoff_id TEXT;');
    }
    if (!bindingCols.has('last_delivery_status')) {
      this.db.exec('ALTER TABLE session_harness_bindings ADD COLUMN last_delivery_status TEXT;');
    }

    const handoffTableSql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_handoffs'").get() as { sql?: string } | undefined
    )?.sql;
    if (handoffTableSql && /REFERENCES\s+sessions/i.test(handoffTableSql)) {
      this.db.exec(`
        CREATE TABLE session_handoffs_v2 (
          handoff_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_id TEXT,
          from_instance_id TEXT,
          to_instance_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          delivery_channel TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          covered_up_to_seq INTEGER NOT NULL DEFAULT 0,
          estimated_chars INTEGER NOT NULL DEFAULT 0,
          redacted_count INTEGER NOT NULL DEFAULT 0,
          force_fresh_reason TEXT,
          snapshot_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          confirmed_at INTEGER
        );
        INSERT INTO session_handoffs_v2 (
          handoff_id, session_id, turn_id, from_instance_id, to_instance_id,
          mode, delivery_channel, delivery_status, covered_up_to_seq,
          estimated_chars, redacted_count, force_fresh_reason, snapshot_json,
          created_at, confirmed_at
        )
        SELECT
          handoff_id, session_id, turn_id, from_instance_id, to_instance_id,
          mode, delivery_channel, delivery_status, covered_up_to_seq,
          estimated_chars, redacted_count, force_fresh_reason, snapshot_json,
          created_at, confirmed_at
        FROM session_handoffs;
        DROP TABLE session_handoffs;
        ALTER TABLE session_handoffs_v2 RENAME TO session_handoffs;
        CREATE INDEX IF NOT EXISTS idx_session_handoffs_session_target
          ON session_handoffs(session_id, to_instance_id, created_at DESC);
      `);
    }

    const subagentTableSql = (
      this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'").get() as { sql?: string } | undefined
    )?.sql;
    if (subagentTableSql && /REFERENCES\s+sessions/i.test(subagentTableSql)) {
      this.db.exec(`
        CREATE TABLE subagent_runs_v2 (
          subagent_id TEXT PRIMARY KEY,
          cohort_id TEXT NOT NULL,
          parent_session_id TEXT NOT NULL,
          child_session_id TEXT NOT NULL,
          target_instance_id TEXT NOT NULL,
          target_driver_id TEXT,
          role_title TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          isolation TEXT NOT NULL,
          worktree_path TEXT,
          branch_name TEXT,
          base_branch TEXT,
          effective_approval_policy TEXT NOT NULL,
          requested_approval_policy TEXT,
          depth INTEGER NOT NULL DEFAULT 1,
          timeout_ms INTEGER NOT NULL DEFAULT 900000,
          fail_fast INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          diff_stat_json TEXT,
          summary TEXT,
          error TEXT,
          merged_at INTEGER,
          merged_into_branch TEXT,
          worktree_cleaned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        INSERT INTO subagent_runs_v2 (
          subagent_id, cohort_id, parent_session_id, child_session_id,
          target_instance_id, target_driver_id, role_title, prompt,
          isolation, worktree_path, branch_name, base_branch,
          effective_approval_policy, requested_approval_policy, depth,
          timeout_ms, fail_fast, status, diff_stat_json, summary, error,
          merged_at, merged_into_branch, worktree_cleaned, created_at, finished_at
        )
        SELECT
          subagent_id, cohort_id, parent_session_id, child_session_id,
          target_instance_id, target_driver_id, role_title, prompt,
          isolation, worktree_path, branch_name, base_branch,
          effective_approval_policy, requested_approval_policy, depth,
          timeout_ms, fail_fast, status, diff_stat_json, summary, error,
          merged_at, merged_into_branch, worktree_cleaned, created_at, finished_at
        FROM subagent_runs;
        DROP TABLE subagent_runs;
        ALTER TABLE subagent_runs_v2 RENAME TO subagent_runs;
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
          ON subagent_runs(parent_session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_cohort
          ON subagent_runs(cohort_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_child
          ON subagent_runs(child_session_id);
      `);
    }

    // Idempotent backfill for existing v0.1/v0.2 sessions -> unified multi-harness bindings + task ledger
    this.backfillLegacySessions();

    // Additive component migration for AGY Native Parity (component='agy-native-runtime', version 1)
    this.migrateAgyNativeRuntimeComponent();
  }

  /**
   * Additive, retryable BEGIN IMMEDIATE component migration for `agy-native-runtime`.
   * - Preserves all legacy tables and rows untouched.
   * - If stored version is newer than this reader supports, marks incompatible without failing startup
   *   so legacy HM sessions remain readable while native routes fail closed.
   */
  private migrateAgyNativeRuntimeComponent(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS component_schema_migrations (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      const row = this.db
        .prepare('SELECT version FROM component_schema_migrations WHERE component = ?')
        .get(AGY_NATIVE_MIGRATION_COMPONENT) as { version?: number } | undefined;
      const storedVersion = typeof row?.version === 'number' ? row.version : 0;

      if (storedVersion > AGY_NATIVE_MIGRATION_VERSION) {
        this.db.exec('COMMIT');
        this.nativeSchemaStatus = {
          component: AGY_NATIVE_MIGRATION_COMPONENT,
          supportedVersion: AGY_NATIVE_MIGRATION_VERSION,
          storedVersion,
          compatible: false,
          newerThanReader: true,
        };
        return;
      }

      if (storedVersion < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS native_runtime_bindings (
            runtime_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            instance_id TEXT NOT NULL,
            binding_revision INTEGER NOT NULL DEFAULT 1,
            profile_ref TEXT NOT NULL,
            source_ref TEXT NOT NULL DEFAULT 'acp',
            current_generation TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disconnected',
            as_of_seq INTEGER NOT NULL DEFAULT 0,
            capabilities_revision INTEGER NOT NULL DEFAULT 0,
            retention_reasons_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (session_id, instance_id, binding_revision)
          );

          CREATE INDEX IF NOT EXISTS idx_native_bindings_session_updated
            ON native_runtime_bindings(session_id, updated_at DESC);

          CREATE TABLE IF NOT EXISTS native_runtime_entities (
            runtime_id TEXT NOT NULL REFERENCES native_runtime_bindings(runtime_id) ON DELETE CASCADE,
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            revision INTEGER NOT NULL DEFAULT 1,
            generation TEXT NOT NULL,
            session_id TEXT NOT NULL,
            lineage_scope TEXT,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (runtime_id, entity_kind, entity_id)
          );

          CREATE INDEX IF NOT EXISTS idx_native_entities_session_kind_rev
            ON native_runtime_entities(session_id, entity_kind, revision);
          CREATE INDEX IF NOT EXISTS idx_native_entities_runtime_lineage
            ON native_runtime_entities(runtime_id, lineage_scope);

          CREATE TABLE IF NOT EXISTS native_runtime_aliases (
            runtime_id TEXT NOT NULL REFERENCES native_runtime_bindings(runtime_id) ON DELETE CASCADE,
            namespace TEXT NOT NULL,
            generation TEXT NOT NULL,
            origin_session_id TEXT NOT NULL DEFAULT '',
            native_value TEXT NOT NULL,
            target_entity_kind TEXT NOT NULL,
            target_entity_id TEXT NOT NULL,
            incarnation TEXT,
            evidence_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (runtime_id, namespace, generation, origin_session_id, native_value)
          );

          CREATE INDEX IF NOT EXISTS idx_native_aliases_target
            ON native_runtime_aliases(runtime_id, target_entity_kind, target_entity_id);

          CREATE TABLE IF NOT EXISTS native_runtime_relations (
            runtime_id TEXT NOT NULL REFERENCES native_runtime_bindings(runtime_id) ON DELETE CASCADE,
            parent_agent_id TEXT NOT NULL,
            child_agent_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            confidence TEXT NOT NULL,
            launch_work_id TEXT,
            evidence_json TEXT NOT NULL,
            revoked_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (runtime_id, child_agent_id)
          );

          CREATE INDEX IF NOT EXISTS idx_native_relations_parent
            ON native_runtime_relations(runtime_id, parent_agent_id);

          CREATE TABLE IF NOT EXISTS native_runtime_events (
            runtime_id TEXT NOT NULL REFERENCES native_runtime_bindings(runtime_id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            generation TEXT NOT NULL,
            session_id TEXT NOT NULL,
            turn_id TEXT,
            hm_anchor_seq INTEGER,
            type TEXT NOT NULL,
            mutation_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (runtime_id, seq),
            UNIQUE (runtime_id, mutation_key)
          );

          CREATE INDEX IF NOT EXISTS idx_native_events_session_runtime_seq
            ON native_runtime_events(session_id, runtime_id, seq);

          CREATE TABLE IF NOT EXISTS native_runtime_receipts (
            receipt_id TEXT PRIMARY KEY,
            runtime_id TEXT NOT NULL REFERENCES native_runtime_bindings(runtime_id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            kind TEXT NOT NULL,
            idempotency_key TEXT,
            payload_digest TEXT,
            approval_id TEXT,
            state TEXT NOT NULL,
            response_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (runtime_id, kind, idempotency_key)
          );

          CREATE INDEX IF NOT EXISTS idx_native_receipts_approval
            ON native_runtime_receipts(approval_id);
          CREATE INDEX IF NOT EXISTS idx_native_receipts_session_kind_state
            ON native_runtime_receipts(session_id, kind, state);
        `);

        this.db
          .prepare(
            `INSERT INTO component_schema_migrations (component, version, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(component) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
          )
          .run(AGY_NATIVE_MIGRATION_COMPONENT, AGY_NATIVE_MIGRATION_VERSION, Date.now());
      }

      this.db.exec('COMMIT');
      this.nativeSchemaStatus = {
        component: AGY_NATIVE_MIGRATION_COMPONENT,
        supportedVersion: AGY_NATIVE_MIGRATION_VERSION,
        storedVersion: Math.max(storedVersion, AGY_NATIVE_MIGRATION_VERSION),
        compatible: true,
        newerThanReader: false,
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure if transaction never started
      }
      throw err;
    }
  }

  private backfillLegacySessions(): void {
    const legacyRows = this.db
      .prepare('SELECT * FROM sessions')
      .all() as unknown as SessionRow[];

    const checkBinding = this.db.prepare(
      'SELECT 1 FROM session_harness_bindings WHERE session_id = ? AND harness_id = ?',
    );
    const insertBinding = this.db.prepare(
      `INSERT INTO session_harness_bindings (
        session_id, harness_id, harness_kind, native_session_id,
        last_model, last_actual_model, last_effort, synced_up_to_seq, driver_used, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const checkTaskState = this.db.prepare(
      'SELECT 1 FROM session_task_state WHERE session_id = ?',
    );
    const insertTaskState = this.db.prepare(
      `INSERT INTO session_task_state (
        session_id, objective, steps_json, decisions_json, touched_files_json,
        verifications_json, blockers_json, pinned_facts_json,
        rolling_summary, summarized_up_to_seq, version, ledger_file_path, updated_at
      ) VALUES (?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '', 0, 1, NULL, ?)`,
    );
    const updateParticipating = this.db.prepare(
      'UPDATE sessions SET participating_harnesses_json = ? WHERE id = ?',
    );

    for (const s of legacyRows) {
      const hasBinding = checkBinding.get(s.id, s.harness_id);
      if (!hasBinding) {
        insertBinding.run(
          s.id,
          s.harness_id,
          s.harness_kind,
          s.native_session_id ?? null,
          s.model ?? null,
          s.actual_model ?? null,
          s.reasoning_effort ?? null,
          s.last_seq ?? 0,
          s.updated_at || Date.now(),
        );
      }

      const existingParticipating = safeJsonParse<string[]>(s.participating_harnesses_json, []);
      if (existingParticipating.length === 0 && s.harness_id) {
        updateParticipating.run(JSON.stringify([s.harness_id]), s.id);
      }

      const hasTask = checkTaskState.get(s.id);
      if (!hasTask) {
        insertTaskState.run(s.id, s.title || '', s.updated_at || Date.now());
      }
    }
  }

  isOpen(): boolean {
    return !this.closed;
  }

  getNativeRuntimeSchemaStatus(): NativeRuntimeSchemaStatus {
    return { ...this.nativeSchemaStatus };
  }

  onSessionChangeCommitted(listener: (latestSeq: number) => void): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  private isSecretTurnBlock(blockType: string, payload?: Record<string, unknown>): boolean {
    return blockType === 'secret_request' || (blockType === 'runtime_request' && payload?.kind === 'secret_request');
  }

  private appendSessionChangeInTx(
    kind: SessionChangeKind,
    sessionId: string,
    workspaceId: string,
    itemId: string | null = null,
    payload?: Record<string, unknown>,
    committedAt = Date.now(),
  ): number {
    const res = this.db
      .prepare(
        `INSERT INTO session_change_log (kind, session_id, workspace_id, item_id, payload_json, committed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, sessionId, workspaceId, itemId, payload ? JSON.stringify(payload) : null, committedAt);
    const seq = Number(res.lastInsertRowid);
    this.pendingCommitSeq = this.pendingCommitSeq === null ? seq : Math.max(this.pendingCommitSeq, seq);
    return seq;
  }

  runInImmediateTransaction<T>(fn: (db: DatabaseSync) => T): T {
    if (this.txDepth > 0) {
      return fn(this.db);
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth += 1;
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT');
      this.txDepth -= 1;
      const committedSeq = this.pendingCommitSeq;
      this.pendingCommitSeq = null;
      if (committedSeq !== null) {
        for (const listener of [...this.commitListeners]) {
          try {
            listener(committedSeq);
          } catch {
            // Isolate listener errors from committed DB mutations
          }
        }
      }
      return result;
    } catch (err) {
      this.pendingCommitSeq = null;
      this.txDepth -= 1;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  runInReadTransaction<T>(fn: (db: DatabaseSync) => T): T {
    if (this.txDepth > 0) {
      return fn(this.db);
    }
    this.db.exec('BEGIN');
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /** Internal database handle exposed exclusively to co-owned persistence modules (e.g. AGY native runtime store). */
  getDatabaseSync(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── Workspaces ───────────────────────────────────────────────────────

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
      .all() as unknown as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as unknown as WorkspaceRow | undefined;
    return row ? mapWorkspace(row) : null;
  }

  getWorkspaceByPath(rootPath: string): Workspace | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE root_path = ?')
      .get(rootPath) as unknown as WorkspaceRow | undefined;
    return row ? mapWorkspace(row) : null;
  }

  createWorkspace(ws: Workspace): Workspace {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, is_git_repo, git_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ws.id, ws.name, ws.rootPath, ws.isGitRepo ? 1 : 0, ws.gitBranch ?? null, ws.createdAt);
    return ws;
  }

  updateWorkspaceGit(id: string, isGitRepo: boolean, gitBranch: string | null): void {
    this.db
      .prepare('UPDATE workspaces SET is_git_repo = ?, git_branch = ? WHERE id = ?')
      .run(isGitRepo ? 1 : 0, gitBranch, id);
  }

  deleteWorkspace(id: string): boolean {
    return this.runInImmediateTransaction(() => {
      const sessions = this.db
        .prepare('SELECT id FROM sessions WHERE workspace_id = ?')
        .all(id) as unknown as Array<{ id: string }>;
      const res = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
      const deleted = Number(res.changes) > 0;
      if (deleted) {
        const now = Date.now();
        for (const s of sessions) {
          this.appendSessionChangeInTx('delete_session', s.id, id, null, undefined, now);
        }
      }
      return deleted;
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  listSessions(filter?: {
    workspaceId?: string;
    harnessId?: string;
    includeArchived?: boolean;
  }): Session[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.workspaceId) {
      clauses.push('s.workspace_id = ?');
      params.push(filter.workspaceId);
    }
    if (filter?.harnessId) {
      clauses.push(
        '(s.harness_id = ? OR EXISTS (SELECT 1 FROM session_harness_bindings b WHERE b.session_id = s.id AND b.harness_id = ?))',
      );
      params.push(filter.harnessId, filter.harnessId);
    }
    if (!filter?.includeArchived) {
      clauses.push("s.status != 'archived'");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM approvals a WHERE a.session_id = s.id AND a.status = 'pending') AS pending_approval_count
         FROM sessions s
         ${where}
         ORDER BY s.updated_at DESC`,
      )
      .all(...params) as unknown as SessionRow[];

    const allBindings = this.db
      .prepare('SELECT * FROM session_harness_bindings ORDER BY updated_at DESC')
      .all() as unknown as BindingRow[];
    const bindingsBySession = new Map<string, SessionHarnessBinding[]>();
    for (const b of allBindings) {
      const list = bindingsBySession.get(b.session_id) ?? [];
      list.push(mapBinding(b));
      bindingsBySession.set(b.session_id, list);
    }

    return rows.map((row) => mapSession(row, bindingsBySession.get(row.id) ?? []));
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM approvals a WHERE a.session_id = s.id AND a.status = 'pending') AS pending_approval_count
         FROM sessions s
         WHERE s.id = ?`,
      )
      .get(id) as unknown as SessionRow | undefined;
    return row ? mapSession(row, this.listSessionBindings(id)) : null;
  }

  createSession(session: Session): Session {
    return this.runInImmediateTransaction(() => {
      const participating =
        session.participatingHarnesses && session.participatingHarnesses.length > 0
          ? session.participatingHarnesses
          : [session.harnessId];
      this.db
        .prepare(
          `INSERT INTO sessions (
            id, workspace_id, harness_id, harness_kind, native_session_id,
            parent_session_id, forked_from_turn_seq, fork_mode, import_mode, import_source,
            participating_harnesses_json, context_sync_mode,
            cwd, worktree_branch,
            title, status, model, actual_model, model_rerouted_reason, reasoning_effort, permission_mode,
            last_seq, usage_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.workspaceId,
          session.harnessId,
          session.harnessKind,
          session.nativeSessionId,
          session.parentSessionId ?? null,
          session.forkedFromTurnSeq ?? null,
          session.forkMode ?? null,
          session.importMode ?? null,
          session.importSource ?? null,
          JSON.stringify(participating),
          session.contextSyncMode ?? 'auto',
          session.cwd,
          session.worktreeBranch ?? null,
          session.title,
          session.status,
          session.model,
          session.actualModel ?? null,
          session.modelReroutedReason ?? null,
          session.reasoningEffort,
          session.permissionMode,
          session.lastSeq,
          session.usage ? JSON.stringify(session.usage) : null,
          session.createdAt,
          session.updatedAt,
        );

      this.upsertSessionBinding({
        sessionId: session.id,
        harnessId: session.harnessId,
        harnessKind: session.harnessKind,
        nativeSessionId: session.nativeSessionId,
        lastModel: session.model,
        lastActualModel: session.actualModel ?? null,
        lastEffort: session.reasoningEffort,
        syncedUpToSeq: session.lastSeq,
        driverUsed: null,
        updatedAt: session.updatedAt,
      });

      this.upsertTaskState({
        sessionId: session.id,
        objective: '',
        steps: [],
        decisions: [],
        touchedFiles: [],
        verifications: [],
        blockers: [],
        pinnedFacts: [],
        rollingSummary: '',
        summarizedUpToSeq: 0,
        version: 1,
        ledgerFilePath: null,
        updatedAt: session.updatedAt,
      });

      this.appendSessionChangeInTx('upsert_session', session.id, session.workspaceId, null, {
        title: session.title,
        status: session.status,
        harnessId: session.harnessId,
        harnessKind: session.harnessKind,
      });

      return this.getSession(session.id)!;
    });
  }

  getImportedSession(
    source: NonNullable<DiscoveredCliSession['source']>, nativeSessionId: string,
  ): Session | null {
    const row = this.db.prepare(
      'SELECT session_id FROM native_history_imports WHERE source = ? AND native_session_id = ?',
    ).get(source, nativeSessionId);
    return typeof row?.session_id === 'string' ? this.getSession(row.session_id) : null;
  }

  getImportedSessionBySourceId(
    sourceId: string,
    nativeSessionId: string,
    compatLegacySources: readonly string[] = [],
  ): { session: Session; matchedVia: 'mapping' | 'legacy' } | null {
    const mapped = this.db
      .prepare('SELECT session_id FROM history_import_mappings WHERE source_id = ? AND native_session_id = ?')
      .get(sourceId, nativeSessionId) as { session_id?: string } | undefined;
    if (typeof mapped?.session_id === 'string') {
      const session = this.getSession(mapped.session_id);
      if (session) return { session, matchedVia: 'mapping' };
    }
    for (const legacySource of compatLegacySources) {
      const legacy = this.db
        .prepare('SELECT session_id FROM native_history_imports WHERE source = ? AND native_session_id = ?')
        .get(legacySource, nativeSessionId) as { session_id?: string } | undefined;
      if (typeof legacy?.session_id === 'string') {
        const session = this.getSession(legacy.session_id);
        if (session) return { session, matchedVia: 'legacy' };
      }
    }
    return null;
  }

  getHistoryImportReceipt(requestId: string): HistoryImportReceiptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM history_import_receipts WHERE request_id = ?')
      .get(requestId) as
      | {
          request_id: string;
          request_hash: string;
          session_id: string;
          disposition: string;
          partial: number;
          warnings_json: string;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      requestId: row.request_id,
      requestHash: row.request_hash,
      sessionId: row.session_id,
      disposition: row.disposition === 'created' ? 'created' : 'reused',
      partial: row.partial === 1,
      warnings: safeJsonParse<string[]>(row.warnings_json, []),
      createdAt: row.created_at,
    };
  }

  recordHistoryImportReceipt(receipt: HistoryImportReceiptRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO history_import_receipts (
          request_id, request_hash, session_id, disposition, partial, warnings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.requestId,
        receipt.requestHash,
        receipt.sessionId,
        receipt.disposition,
        receipt.partial ? 1 : 0,
        JSON.stringify(receipt.warnings ?? []),
        receipt.createdAt,
      );
  }

  upsertHistoryImportMapping(mapping: HistoryImportMappingRecord): void {
    this.db
      .prepare(
        `INSERT INTO history_import_mappings (
          source_id, native_session_id, session_id, legacy_source, source_instance_id, source_path, harness_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, native_session_id) DO NOTHING`,
      )
      .run(
        mapping.sourceId,
        mapping.nativeSessionId,
        mapping.sessionId,
        mapping.legacySource ?? null,
        mapping.sourceInstanceId ?? null,
        mapping.sourcePath ?? null,
        mapping.harnessKind ?? null,
        mapping.createdAt,
      );
  }

  getNativeHistory(sessionId: string, nativeSessionId: string): {
    source: DiscoveredCliSession['source']; sourcePath?: string;
  } | undefined {
    const row = this.db.prepare(
      'SELECT source, source_path FROM native_history_imports WHERE session_id = ? AND native_session_id = ?',
    ).get(sessionId, nativeSessionId);
    if (row) {
      return { source: row.source as DiscoveredCliSession['source'],
        sourcePath: typeof row.source_path === 'string' ? row.source_path : undefined };
    }
    const mapped = this.db.prepare(
      'SELECT legacy_source, source_id, source_path FROM history_import_mappings WHERE session_id = ? AND native_session_id = ?',
    ).get(sessionId, nativeSessionId) as { legacy_source?: string | null; source_id?: string; source_path?: string | null } | undefined;
    if (!mapped) return undefined;
    return {
      source: (mapped.legacy_source || mapped.source_id || 'custom') as DiscoveredCliSession['source'],
      sourcePath: typeof mapped.source_path === 'string' ? mapped.source_path : undefined,
    };
  }

  importSession(
    session: Session,
    source: NonNullable<DiscoveredCliSession['source']>,
    sourcePath: string | undefined,
    events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>>,
  ): Session {
    return this.runInImmediateTransaction(() => {
      const existing = this.getImportedSession(source, session.nativeSessionId!);
      if (existing) {
        return existing;
      }
      const imported = this.createSession({ ...session, lastSeq: events.length });
      const insert = this.db.prepare(`INSERT INTO session_events
        (session_id, seq, type, turn_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const [index, event] of events.entries()) {
        insert.run(session.id, index + 1, event.type, event.turnId, JSON.stringify(event.payload), event.createdAt);
      }
      this.db.prepare(`INSERT INTO native_history_imports (source, native_session_id, session_id, source_path)
        VALUES (?, ?, ?, ?)`).run(source, session.nativeSessionId, session.id, sourcePath ?? null);
      this.upsertHistoryImportMapping({
        sourceId: source,
        nativeSessionId: session.nativeSessionId!,
        sessionId: session.id,
        legacySource: source,
        sourcePath: sourcePath ?? null,
        harnessKind: session.harnessKind,
        createdAt: session.createdAt,
      });
      return imported;
    });
  }

  updateSession(
    id: string,
    patch: Partial<{
      harnessId: string;
      harnessKind: HarnessKind;
      nativeSessionId: string | null;
      participatingHarnesses: string[];
      contextSyncMode: ContextSyncMode;
      title: string;
      status: SessionStatus;
      model: string | null;
      actualModel: string | null;
      modelReroutedReason: string | null;
      reasoningEffort: ReasoningEffort | null;
      permissionMode: PermissionMode;
      usage: TokenUsage | null;
      updatedAt: number;
    }>,
  ): Session | null {
    return this.runInImmediateTransaction(() => {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (patch.harnessId !== undefined) {
        sets.push('harness_id = ?');
        params.push(patch.harnessId);
      }
      if (patch.harnessKind !== undefined) {
        sets.push('harness_kind = ?');
        params.push(patch.harnessKind);
      }
      if (patch.nativeSessionId !== undefined) {
        sets.push('native_session_id = ?');
        params.push(patch.nativeSessionId);
      }
      if (patch.participatingHarnesses !== undefined) {
        sets.push('participating_harnesses_json = ?');
        params.push(JSON.stringify(patch.participatingHarnesses));
      }
      if (patch.contextSyncMode !== undefined) {
        sets.push('context_sync_mode = ?');
        params.push(patch.contextSyncMode);
      }
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.model !== undefined) {
        sets.push('model = ?');
        params.push(patch.model);
      }
      if (patch.actualModel !== undefined) {
        sets.push('actual_model = ?');
        params.push(patch.actualModel);
      }
      if (patch.modelReroutedReason !== undefined) {
        sets.push('model_rerouted_reason = ?');
        params.push(patch.modelReroutedReason);
      }
      if (patch.reasoningEffort !== undefined) {
        sets.push('reasoning_effort = ?');
        params.push(patch.reasoningEffort);
      }
      if (patch.permissionMode !== undefined) {
        sets.push('permission_mode = ?');
        params.push(patch.permissionMode);
      }
      if (patch.usage !== undefined) {
        sets.push('usage_json = ?');
        params.push(patch.usage ? JSON.stringify(patch.usage) : null);
      }

      const updatedAt = patch.updatedAt ?? Date.now();
      sets.push('updated_at = ?');
      params.push(updatedAt);
      params.push(id);

      const res = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const updated = this.getSession(id);
      if (Number(res.changes) > 0 && updated) {
        this.appendSessionChangeInTx(
          'upsert_session',
          updated.id,
          updated.workspaceId,
          null,
          {
            title: updated.title,
            status: updated.status,
            harnessId: updated.harnessId,
            harnessKind: updated.harnessKind,
          },
          updatedAt,
        );
      }
      return updated;
    });
  }

  deleteSession(id: string): boolean {
    return this.runInImmediateTransaction(() => {
      const existing = this.db
        .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
        .get(id) as { workspace_id?: string } | undefined;
      try {
        this.db.prepare('DELETE FROM session_search_fts WHERE session_id = ?').run(id);
      } catch {
        // ignore if FTS table is unavailable
      }
      const res = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      const deleted = Number(res.changes) > 0;
      if (deleted && existing?.workspace_id) {
        this.appendSessionChangeInTx('delete_session', id, existing.workspace_id, null);
      }
      return deleted;
    });
  }

  updateSessionForkMeta(
    id: string,
    meta: { parentSessionId?: string | null; forkedFromTurnSeq?: number | null; forkMode?: 'native' | 'portable' | null },
  ): Session | null {
    this.db
      .prepare(
        `UPDATE sessions
         SET parent_session_id = ?, forked_from_turn_seq = ?, fork_mode = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        meta.parentSessionId ?? null,
        meta.forkedFromTurnSeq ?? null,
        meta.forkMode ?? null,
        Date.now(),
        id,
      );
    return this.getSession(id);
  }

  getUsageAggregatesByHarness(): Map<string, LocalHarnessUsageAggregate> {
    const rows = this.db
      .prepare('SELECT harness_id, usage_json FROM sessions')
      .all() as unknown as Array<{ harness_id: string; usage_json: string | null }>;

    const map = new Map<string, LocalHarnessUsageAggregate>();
    for (const row of rows) {
      let agg = map.get(row.harness_id);
      if (!agg) {
        agg = {
          harnessId: row.harness_id,
          sessionCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
        };
        map.set(row.harness_id, agg);
      }
      agg.sessionCount += 1;
      const usage = safeJsonParse<TokenUsage | null>(row.usage_json, null);
      if (usage) {
        agg.inputTokens += usage.inputTokens || 0;
        agg.outputTokens += usage.outputTokens || 0;
        agg.cachedTokens += usage.cachedTokens || 0;
        agg.costUsd += usage.costUsd || 0;
      }
    }
    return map;
  }

  /**
   * Multi-instance usage aggregation backed primarily by `session_runs` (per `instance_id`),
   * with 14-day daily token buckets and seamless merge of historical `sessions` rows that
   * predate `session_runs`.
   */
  getUsageAggregatesByInstance(): Map<string, LocalInstanceUsageAggregate> {
    const runRows = this.db
      .prepare('SELECT session_id, instance_id, usage_json, started_at FROM session_runs')
      .all() as unknown as Array<{
      session_id: string;
      instance_id: string;
      usage_json: string | null;
      started_at: number;
    }>;

    const map = new Map<
      string,
      LocalInstanceUsageAggregate & { _sessions: Set<string>; _daily: Map<string, number> }
    >();
    const sessionsCoveredByRuns = new Set<string>();

    const ensure = (instanceId: string) => {
      let agg = map.get(instanceId);
      if (!agg) {
        agg = {
          instanceId,
          harnessId: instanceId,
          sessionCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          dailyBuckets: [],
          _sessions: new Set<string>(),
          _daily: new Map<string, number>(),
        };
        map.set(instanceId, agg);
      }
      return agg;
    };

    const cutoffMs = Date.now() - 14 * 86_400_000;
    for (const row of runRows) {
      const agg = ensure(row.instance_id);
      agg._sessions.add(row.session_id);
      sessionsCoveredByRuns.add(`${row.instance_id}::${row.session_id}`);
      const usage = safeJsonParse<TokenUsage | null>(row.usage_json, null);
      if (usage) {
        agg.inputTokens += usage.inputTokens || 0;
        agg.outputTokens += usage.outputTokens || 0;
        agg.cachedTokens += usage.cachedTokens || usage.cacheReadTokens || 0;
        agg.costUsd += usage.costUsd || 0;
        if (row.started_at >= cutoffMs) {
          const day = new Date(row.started_at).toISOString().slice(0, 10);
          agg._daily.set(
            day,
            (agg._daily.get(day) ?? 0) + (usage.inputTokens || 0) + (usage.outputTokens || 0),
          );
        }
      }
    }

    // Merge sessions without corresponding session_runs rows (legacy / imported sessions)
    const sessionRows = this.db
      .prepare('SELECT id, harness_id, usage_json, updated_at FROM sessions')
      .all() as unknown as Array<{
      id: string;
      harness_id: string;
      usage_json: string | null;
      updated_at: number;
    }>;

    for (const row of sessionRows) {
      const agg = ensure(row.harness_id);
      agg._sessions.add(row.id);
      if (sessionsCoveredByRuns.has(`${row.harness_id}::${row.id}`)) continue;
      const usage = safeJsonParse<TokenUsage | null>(row.usage_json, null);
      if (usage) {
        agg.inputTokens += usage.inputTokens || 0;
        agg.outputTokens += usage.outputTokens || 0;
        agg.cachedTokens += usage.cachedTokens || usage.cacheReadTokens || 0;
        agg.costUsd += usage.costUsd || 0;
        if (row.updated_at >= cutoffMs) {
          const day = new Date(row.updated_at).toISOString().slice(0, 10);
          agg._daily.set(
            day,
            (agg._daily.get(day) ?? 0) + (usage.inputTokens || 0) + (usage.outputTokens || 0),
          );
        }
      }
    }

    const result = new Map<string, LocalInstanceUsageAggregate>();
    for (const [instanceId, agg] of map.entries()) {
      const dailyBuckets: DailyTokenBucket[] = [...agg._daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-14)
        .map(([date, tokens]) => ({ date, tokens }));
      result.set(instanceId, {
        instanceId,
        harnessId: instanceId,
        sessionCount: agg._sessions.size,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cachedTokens: agg.cachedTokens,
        costUsd: agg.costUsd,
        dailyBuckets,
      });
    }
    return result;
  }

  // ── Canonical Events ─────────────────────────────────────────────────

  appendEvent(
    sessionId: string,
    type: CanonicalEventType,
    payload: Record<string, unknown>,
    turnId: string | null = null,
    createdAt: number = Date.now(),
  ): CanonicalEvent {
    return this.runInImmediateTransaction(() => {
      const row = this.db
        .prepare('SELECT last_seq FROM sessions WHERE id = ?')
        .get(sessionId) as unknown as { last_seq: number } | undefined;
      if (!row) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const nextSeq = row.last_seq + 1;
      this.db
        .prepare(
          `INSERT INTO session_events (session_id, seq, type, turn_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, nextSeq, type, turnId, JSON.stringify(payload), createdAt);
      this.db
        .prepare('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?')
        .run(nextSeq, createdAt, sessionId);

      return {
        sessionId,
        seq: nextSeq,
        type,
        turnId,
        createdAt,
        payload,
      };
    });
  }

  insertEventsBatchInTx(
    sessionId: string,
    events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>>,
    startingSeq = 0,
  ): number {
    const insert = this.db.prepare(
      `INSERT INTO session_events (session_id, seq, type, turn_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let seq = startingSeq;
    for (const ev of events) {
      seq += 1;
      insert.run(sessionId, seq, ev.type, ev.turnId ?? null, JSON.stringify(ev.payload), ev.createdAt);
    }
    this.db.prepare('UPDATE sessions SET last_seq = ? WHERE id = ?').run(seq, sessionId);
    return seq;
  }

  insertLegacyNativeImportIgnore(
    source: string,
    nativeSessionId: string,
    sessionId: string,
    sourcePath?: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO native_history_imports (source, native_session_id, session_id, source_path)
         VALUES (?, ?, ?, ?)`,
      )
      .run(source, nativeSessionId, sessionId, sourcePath ?? null);
  }

  getEventsAfter(sessionId: string, afterSeq = 0, limit = 1000): CanonicalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as unknown as EventRow[];

    return rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as CanonicalEventType,
      turnId: r.turn_id,
      createdAt: r.created_at,
      payload: safeJsonParse<Record<string, unknown>>(r.payload_json, {}),
    }));
  }

  getLastHandoffReceipt(sessionId: string, harnessId: string, nativeSessionId: string) {
    const row = this.db.prepare(`SELECT receipt.payload_json FROM session_events AS receipt
      WHERE receipt.session_id = ? AND receipt.type = 'handoff.snapshot_delivered'
        AND json_extract(receipt.payload_json, '$.targetHarnessId') = ?
        AND json_extract(receipt.payload_json, '$.nativeSessionId') = ?
        AND NOT EXISTS (SELECT 1 FROM session_events AS terminal
          WHERE terminal.session_id = receipt.session_id AND terminal.turn_id = receipt.turn_id
            AND terminal.type IN ('turn.failed', 'turn.cancelled'))
      ORDER BY receipt.seq DESC LIMIT 1`).get(sessionId, harnessId, nativeSessionId) as { payload_json: string } | undefined;
    if (!row) return;
    const payload = safeJsonParse<{ snapshotId?: string; sectionHashes?: Record<string, string> }>(row.payload_json, {});
    if (payload.snapshotId && payload.sectionHashes) return { snapshotId: payload.snapshotId, sectionHashes: payload.sectionHashes };
  }

  getEventsInRange(
    sessionId: string,
    afterSeq = 0,
    upToSeq = Number.MAX_SAFE_INTEGER,
    limit = 4000,
  ): CanonicalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND seq > ? AND seq <= ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, upToSeq, limit) as unknown as EventRow[];

    return rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as CanonicalEventType,
      turnId: r.turn_id,
      createdAt: r.created_at,
      payload: safeJsonParse<Record<string, unknown>>(r.payload_json, {}),
    }));
  }

  getEventsBefore(
    sessionId: string,
    beforeSeq = Number.MAX_SAFE_INTEGER,
    limit = 400,
    afterSeq = 0,
    minTurnEvents = 0,
  ): CanonicalEvent[] {
    let rows = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND seq > ? AND seq < ?
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, beforeSeq, limit) as unknown as EventRow[];

    if (minTurnEvents > 0 && rows.length >= limit) {
      let turnEventCount = 0;
      for (const r of rows) {
        if (r.turn_id !== null) turnEventCount += 1;
      }
      if (turnEventCount < minTurnEvents) {
        const anchorRows = this.db
          .prepare(
            `SELECT seq FROM session_events
             WHERE session_id = ? AND seq > ? AND seq < ? AND turn_id IS NOT NULL
             ORDER BY seq DESC
             LIMIT ?`,
          )
          .all(sessionId, afterSeq, beforeSeq, minTurnEvents) as unknown as Array<{ seq: number }>;
        const anchorSeq = anchorRows.length > 0 ? anchorRows[anchorRows.length - 1]!.seq : undefined;
        const currentOldest = rows[rows.length - 1]!.seq;
        if (anchorSeq !== undefined && anchorSeq < currentOldest) {
          const maxSpan = Math.max(limit, 4000);
          rows = this.db
            .prepare(
              `SELECT * FROM session_events
               WHERE session_id = ? AND seq >= ? AND seq < ?
               ORDER BY seq DESC
               LIMIT ?`,
            )
            .all(sessionId, anchorSeq, beforeSeq, maxSpan) as unknown as EventRow[];
        }
      }
    }

    rows.reverse();
    return rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as CanonicalEventType,
      turnId: r.turn_id,
      createdAt: r.created_at,
      payload: safeJsonParse<Record<string, unknown>>(r.payload_json, {}),
    }));
  }

  hasEventsBefore(sessionId: string, beforeSeq: number, afterSeq = 0): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM session_events
         WHERE session_id = ? AND seq > ? AND seq < ?
         LIMIT 1`,
      )
      .get(sessionId, afterSeq, beforeSeq) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  }

  *iterateEvents(sessionId: string, afterSeq = 0, upToSeq = Number.MAX_SAFE_INTEGER): Generator<CanonicalEvent> {
    const pageSize = 1000;
    while (afterSeq < upToSeq) {
      const page = this.getEventsInRange(sessionId, afterSeq, upToSeq, pageSize);
      yield* page;
      if (page.length < pageSize) return;
      afterSeq = page.at(-1)!.seq;
    }
  }

  readCommittedLedgerEvents(
    sessionId: string,
    range: { afterSeq: number; throughSeq: number },
    turnId?: string,
  ): CanonicalEvent[] {
    const filter = turnId === undefined
      ? "type IN ('turn.completed', 'turn.failed', 'turn.cancelled', 'checkpoint.reverted', 'session.harness_switched')"
      : 'turn_id = ?';
    const args = [sessionId, range.afterSeq, range.throughSeq, ...(turnId === undefined ? [] : [turnId])];
    const rows = this.db.prepare(
      `SELECT * FROM session_events WHERE session_id = ? AND seq > ? AND seq <= ? AND ${filter} ORDER BY seq ASC`,
    ).all(...args) as unknown as EventRow[];
    return rows.map((row) => ({
      sessionId,
      seq: row.seq,
      type: row.type as CanonicalEventType,
      turnId: row.turn_id,
      createdAt: row.created_at,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    }));
  }

  readPluginTurns(session: Session, projection: PluginProjection, query: PluginPanelQuery, pageSize: number) {
    const scopeColumn = projection.scope === 'workspace' ? 's.workspace_id' : 's.id';
    const scopeId = projection.scope === 'workspace' ? session.workspaceId : session.id;
    const placeholders = projection.events.map(() => '?').join(', ');
    const source = `WITH ranked AS (
      SELECT e.seq, e.session_id AS sessionId, s.title AS sessionTitle, e.turn_id AS turnId,
             json_extract(e.payload_json, '$.harnessId') AS harnessId,
             COALESCE(json_extract(e.payload_json, '$.imported'), 0) AS imported,
             e.type AS event, e.created_at AS timestamp,
             ROW_NUMBER() OVER (PARTITION BY e.session_id, e.turn_id ORDER BY e.seq DESC) AS rank
        FROM sessions s JOIN session_events e ON e.session_id = s.id
       WHERE ${scopeColumn} = ? AND e.turn_id IS NOT NULL
         AND e.type IN ('turn.completed', 'turn.failed', 'turn.cancelled')
         AND COALESCE(json_extract(e.payload_json, '$.maintenance'), 0) != 1
    ), matching AS (
      SELECT * FROM ranked WHERE rank = 1 AND event IN (${placeholders})
    )`;
    const params = [scopeId, ...projection.events];
    const counts = this.db.prepare(`${source}
      SELECT event, harnessId, COUNT(*) AS count FROM matching GROUP BY event, harnessId
    `).all(...params) as unknown as Array<Pick<PluginTurnRow, 'event' | 'harnessId'> & { count: number }>;
    const total = counts.reduce((sum, row) => {
      const included = (!query.event || row.event === query.event) && (!query.harnessId || row.harnessId === query.harnessId);
      return sum + (included ? row.count : 0);
    }, 0);
    const rows = query.offset < total ? this.db.prepare(`${source}
      SELECT seq, sessionId, sessionTitle, turnId, harnessId, imported, event, timestamp FROM matching
      WHERE (? IS NULL OR event = ?) AND (? IS NULL OR harnessId = ?)
      ORDER BY timestamp DESC, sessionId DESC, seq DESC LIMIT ? OFFSET ?
    `).all(...params, query.event ?? null, query.event ?? null, query.harnessId ?? null, query.harnessId ?? null,
      pageSize, query.offset) as unknown as Array<Omit<PluginTurnRow, 'imported'> & { imported: number }> : [];
    return { counts, total, rows };
  }

  getPluginTurnToolEvents(sessionId: string, turnId: string, upToSeq: number): CanonicalEvent[] {
    const rows = this.db.prepare(`SELECT * FROM session_events
      WHERE session_id = ? AND turn_id = ? AND seq <= ? AND type IN ('tool.call.started', 'tool.call.completed')
      ORDER BY seq
    `).all(sessionId, turnId, upToSeq) as unknown as EventRow[];
    return rows.map((row) => ({
      sessionId, turnId, seq: row.seq, type: row.type as CanonicalEventType, createdAt: row.created_at,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    }));
  }

  getPluginPermissions(workspaceId: string): StoredPluginPermission[] {
    const rows = this.db.prepare(
      `SELECT plugin_id AS pluginId, digest, capability, cover_future AS coverFuture, declared_permissions_json AS declaredPermissionsJson
       FROM plugin_permissions WHERE workspace_id = ?`,
    ).all(workspaceId) as Array<{ pluginId: string; digest: string; capability: string; coverFuture?: number; declaredPermissionsJson?: string | null }>;
    return rows.map((row) => ({
      pluginId: row.pluginId,
      digest: row.digest,
      capability: row.capability,
      coverFuture: Boolean(row.coverFuture),
      declaredPermissions: safeJsonParse<string[]>(row.declaredPermissionsJson ?? null, []),
    }));
  }

  getGlobalPluginPermissions(): StoredPluginPermission[] {
    const rows = this.db.prepare(
      `SELECT plugin_id AS pluginId, digest, capability, cover_future AS coverFuture, declared_permissions_json AS declaredPermissionsJson
       FROM plugin_global_permissions`,
    ).all() as Array<{ pluginId: string; digest: string; capability: string; coverFuture?: number; declaredPermissionsJson?: string | null }>;
    return rows.map((row) => ({
      pluginId: row.pluginId,
      digest: row.digest,
      capability: row.capability,
      coverFuture: Boolean(row.coverFuture),
      declaredPermissions: safeJsonParse<string[]>(row.declaredPermissionsJson ?? null, []),
    }));
  }

  setPluginPermission(
    workspaceId: string,
    pluginId: string,
    digest: string,
    capability: string,
    granted: boolean,
    opts?: { coverFuture?: boolean; declaredPermissions?: readonly string[] },
  ): void {
    const coverFuture = opts?.coverFuture ? 1 : 0;
    const declaredJson = opts?.declaredPermissions ? JSON.stringify([...new Set(opts.declaredPermissions)].sort()) : null;
    if (granted) {
      this.db.prepare(`INSERT INTO plugin_permissions (workspace_id, plugin_id, digest, capability, cover_future, declared_permissions_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, plugin_id, capability) DO UPDATE SET
          digest = excluded.digest,
          cover_future = excluded.cover_future,
          declared_permissions_json = excluded.declared_permissions_json`)
        .run(workspaceId, pluginId, digest, capability, coverFuture, declaredJson);
    } else {
      this.db.prepare(`DELETE FROM plugin_permissions WHERE workspace_id = ? AND plugin_id = ? AND capability = ?`)
        .run(workspaceId, pluginId, capability);
    }
  }

  setGlobalPluginPermission(
    pluginId: string,
    digest: string,
    capability: string,
    granted: boolean,
    opts?: { coverFuture?: boolean; declaredPermissions?: readonly string[] },
  ): void {
    const coverFuture = opts?.coverFuture ? 1 : 0;
    const declaredJson = opts?.declaredPermissions ? JSON.stringify([...new Set(opts.declaredPermissions)].sort()) : null;
    if (granted) {
      this.db.prepare(`INSERT INTO plugin_global_permissions (plugin_id, digest, capability, cover_future, declared_permissions_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (plugin_id, capability) DO UPDATE SET
          digest = excluded.digest,
          cover_future = excluded.cover_future,
          declared_permissions_json = excluded.declared_permissions_json`)
        .run(pluginId, digest, capability, coverFuture, declaredJson);
    } else {
      this.db.prepare(`DELETE FROM plugin_global_permissions WHERE plugin_id = ? AND capability = ?`)
        .run(pluginId, capability);
    }
  }

  clearPluginPermissions(pluginId: string): void {
    this.db.prepare('DELETE FROM plugin_permissions WHERE plugin_id = ?').run(pluginId);
    this.db.prepare('DELETE FROM plugin_global_permissions WHERE plugin_id = ?').run(pluginId);
    this.db.prepare('DELETE FROM plugin_kv_storage WHERE plugin_id = ?').run(pluginId);
  }

  // ── Plugin Key-Value Storage ─────────────────────────────────────────

  getLatestCompletedTurnSeq(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT seq FROM session_events
       WHERE session_id = ? AND turn_id IS NOT NULL AND type = 'turn.completed'
         AND COALESCE(json_extract(payload_json, '$.maintenance'), 0) != 1
       ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  hasRunningSubagents(sessionId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM subagent_runs WHERE parent_session_id = ? AND status IN ('running', 'awaiting_approval') LIMIT 1",
    ).get(sessionId);
  }

  listSessionIds(): string[] {
    return (this.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>).map(({ id }) => id);
  }

  getPluginStorageValue(scope: string, pluginId: string, key: string): unknown {
    const row = this.db.prepare(
      'SELECT value_json FROM plugin_kv_storage WHERE scope = ? AND plugin_id = ? AND key = ?',
    ).get(scope, pluginId, key) as { value_json: string } | undefined;
    return row ? safeJsonParse<unknown>(row.value_json, undefined) : undefined;
  }

  setPluginStorageValue(scope: string, pluginId: string, key: string, value: unknown): void {
    this.db.prepare(
      `INSERT INTO plugin_kv_storage (scope, plugin_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, plugin_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run(scope, pluginId, key, JSON.stringify(value), Date.now());
  }

  deletePluginStorageValue(scope: string, pluginId: string, key: string): void {
    this.db.prepare('DELETE FROM plugin_kv_storage WHERE scope = ? AND plugin_id = ? AND key = ?')
      .run(scope, pluginId, key);
  }

  listPluginStorageKeys(scope: string, pluginId: string): string[] {
    const rows = this.db.prepare(
      'SELECT key FROM plugin_kv_storage WHERE scope = ? AND plugin_id = ? ORDER BY key ASC',
    ).all(scope, pluginId) as Array<{ key: string }>;
    return rows.map(({ key }) => key);
  }

  // ── Scoped Capability Bindings (Workspace / Session) ─────────────────

  getCapabilityBinding(
    scopeType: 'workspace' | 'session',
    scopeId: string,
    contract: string,
  ): { instanceId: string; updatedAt: number } | null {
    const row = this.db.prepare(
      'SELECT instance_id, updated_at FROM capability_bindings WHERE scope_type = ? AND scope_id = ? AND contract = ?',
    ).get(scopeType, scopeId, contract) as { instance_id: string; updated_at: number } | undefined;
    return row ? { instanceId: row.instance_id, updatedAt: row.updated_at } : null;
  }

  listCapabilityBindings(
    scopeType: 'workspace' | 'session',
    scopeId: string,
  ): Array<{ contract: string; instanceId: string; updatedAt: number }> {
    const rows = this.db.prepare(
      'SELECT contract, instance_id, updated_at FROM capability_bindings WHERE scope_type = ? AND scope_id = ? ORDER BY contract ASC',
    ).all(scopeType, scopeId) as Array<{ contract: string; instance_id: string; updated_at: number }>;
    return rows.map((row) => ({
      contract: row.contract,
      instanceId: row.instance_id,
      updatedAt: row.updated_at,
    }));
  }

  setCapabilityBinding(
    scopeType: 'workspace' | 'session',
    scopeId: string,
    contract: string,
    instanceId: string | null,
  ): void {
    if (!instanceId) {
      this.db.prepare(
        'DELETE FROM capability_bindings WHERE scope_type = ? AND scope_id = ? AND contract = ?',
      ).run(scopeType, scopeId, contract);
      return;
    }
    this.db.prepare(
      `INSERT INTO capability_bindings (scope_type, scope_id, contract, instance_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope_type, scope_id, contract) DO UPDATE SET
         instance_id = excluded.instance_id,
         updated_at = excluded.updated_at`,
    ).run(scopeType, scopeId, contract, instanceId, Date.now());
  }

  deleteCapabilityBindingsForScope(scopeType: 'workspace' | 'session', scopeId: string): void {
    this.db.prepare('DELETE FROM capability_bindings WHERE scope_type = ? AND scope_id = ?').run(scopeType, scopeId);
  }

  // ── Session Harness Bindings (Per-Harness Sync Watermarks) ───────────

  listSessionBindings(sessionId: string): SessionHarnessBinding[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM session_harness_bindings WHERE session_id = ? ORDER BY updated_at DESC',
      )
      .all(sessionId) as unknown as BindingRow[];
    return rows.map(mapBinding);
  }

  getSessionBinding(sessionId: string, harnessId: string): SessionHarnessBinding | null {
    const row = this.db
      .prepare(
        'SELECT * FROM session_harness_bindings WHERE session_id = ? AND harness_id = ?',
      )
      .get(sessionId, harnessId) as unknown as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  upsertSessionBinding(binding: SessionHarnessBinding): SessionHarnessBinding {
    this.db
      .prepare(
        `INSERT INTO session_harness_bindings (
          session_id, harness_id, harness_kind, native_session_id,
          last_model, last_actual_model, last_effort, synced_up_to_seq, driver_used, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, harness_id) DO UPDATE SET
          harness_kind = excluded.harness_kind,
          native_session_id = COALESCE(excluded.native_session_id, session_harness_bindings.native_session_id),
          last_model = CASE WHEN excluded.last_model IS NOT NULL THEN excluded.last_model ELSE session_harness_bindings.last_model END,
          last_actual_model = CASE WHEN excluded.last_actual_model IS NOT NULL THEN excluded.last_actual_model ELSE session_harness_bindings.last_actual_model END,
          last_effort = CASE WHEN excluded.last_effort IS NOT NULL THEN excluded.last_effort ELSE session_harness_bindings.last_effort END,
          synced_up_to_seq = MAX(session_harness_bindings.synced_up_to_seq, excluded.synced_up_to_seq),
          driver_used = COALESCE(excluded.driver_used, session_harness_bindings.driver_used),
          updated_at = excluded.updated_at`,
      )
      .run(
        binding.sessionId,
        binding.harnessId,
        binding.harnessKind,
        binding.nativeSessionId ?? null,
        binding.lastModel ?? null,
        binding.lastActualModel ?? null,
        binding.lastEffort ?? null,
        binding.syncedUpToSeq ?? 0,
        binding.driverUsed ?? null,
        binding.updatedAt ?? Date.now(),
      );
    return this.getSessionBinding(binding.sessionId, binding.harnessId)!;
  }

  setSessionBindingExact(
    sessionId: string,
    harnessId: string,
    patch: Partial<{
      nativeSessionId: string | null;
      lastModel: string | null;
      lastActualModel: string | null;
      lastEffort: ReasoningEffort | null;
      syncedUpToSeq: number;
      driverUsed: ContextInjectionDriver | null;
    }>,
  ): SessionHarnessBinding | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.nativeSessionId !== undefined) {
      sets.push('native_session_id = ?');
      params.push(patch.nativeSessionId);
    }
    if (patch.lastModel !== undefined) {
      sets.push('last_model = ?');
      params.push(patch.lastModel);
    }
    if (patch.lastActualModel !== undefined) {
      sets.push('last_actual_model = ?');
      params.push(patch.lastActualModel);
    }
    if (patch.lastEffort !== undefined) {
      sets.push('last_effort = ?');
      params.push(patch.lastEffort);
    }
    if (patch.syncedUpToSeq !== undefined) {
      sets.push('synced_up_to_seq = ?');
      params.push(patch.syncedUpToSeq);
    }
    if (patch.driverUsed !== undefined) {
      sets.push('driver_used = ?');
      params.push(patch.driverUsed);
    }
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(sessionId, harnessId);
    this.db
      .prepare(
        `UPDATE session_harness_bindings SET ${sets.join(', ')} WHERE session_id = ? AND harness_id = ?`,
      )
      .run(...params);
    return this.getSessionBinding(sessionId, harnessId);
  }

  // ── Externalized Task State Ledger ───────────────────────────────────

  getTaskState(sessionId: string): SessionTaskState | null {
    const row = this.db
      .prepare('SELECT * FROM session_task_state WHERE session_id = ?')
      .get(sessionId) as unknown as TaskStateRow | undefined;
    return row ? mapTaskState(row) : null;
  }

  upsertTaskState(state: SessionTaskState): SessionTaskState {
    this.db
      .prepare(
        `INSERT INTO session_task_state (
          session_id, objective, steps_json, decisions_json, touched_files_json,
          verifications_json, blockers_json, pinned_facts_json, failed_attempts_json,
          rolling_summary, summarized_up_to_seq, version, ledger_file_path, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          objective = excluded.objective,
          steps_json = excluded.steps_json,
          decisions_json = excluded.decisions_json,
          touched_files_json = excluded.touched_files_json,
          verifications_json = excluded.verifications_json,
          blockers_json = excluded.blockers_json,
          pinned_facts_json = excluded.pinned_facts_json,
          failed_attempts_json = excluded.failed_attempts_json,
          rolling_summary = excluded.rolling_summary,
          summarized_up_to_seq = excluded.summarized_up_to_seq,
          version = excluded.version,
          ledger_file_path = excluded.ledger_file_path,
          updated_at = excluded.updated_at`,
      )
      .run(
        state.sessionId,
        state.objective ?? '',
        JSON.stringify(state.steps ?? []),
        JSON.stringify(state.decisions ?? []),
        JSON.stringify(state.touchedFiles ?? []),
        JSON.stringify(state.verifications ?? []),
        JSON.stringify(state.blockers ?? []),
        JSON.stringify(state.pinnedFacts ?? []),
        JSON.stringify(state.failedAttempts ?? []),
        state.rollingSummary ?? '',
        state.summarizedUpToSeq ?? 0,
        state.version ?? 1,
        state.ledgerFilePath ?? null,
        state.updatedAt ?? Date.now(),
      );
    return this.getTaskState(state.sessionId)!;
  }

  // Compatibility delegates: request schema and queries belong to the request plugin.
  createApproval = (...args: Parameters<ApprovalRepository['createApproval']>) => new ApprovalRepository(this.db).createApproval(...args);
  getApproval = (...args: Parameters<ApprovalRepository['getApproval']>) => new ApprovalRepository(this.db).getApproval(...args);
  listPendingApprovals = (...args: Parameters<ApprovalRepository['listPendingApprovals']>) => new ApprovalRepository(this.db).listPendingApprovals(...args);
  listApprovals = (...args: Parameters<ApprovalRepository['listApprovals']>) => new ApprovalRepository(this.db).listApprovals(...args);
  addApprovalAnnotation = (...args: Parameters<ApprovalRepository['addApprovalAnnotation']>) => new ApprovalRepository(this.db).addApprovalAnnotation(...args);
  setApprovalAnnotationsAndRisk = (...args: Parameters<ApprovalRepository['setApprovalAnnotationsAndRisk']>) => new ApprovalRepository(this.db).setApprovalAnnotationsAndRisk(...args);
  resolveApprovalIfPending = (...args: Parameters<ApprovalRepository['resolveApprovalIfPending']>) => new ApprovalRepository(this.db).resolveApprovalIfPending(...args);
  cancelPendingApprovals = (...args: Parameters<ApprovalRepository['cancelPendingApprovals']>) => new ApprovalRepository(this.db).cancelPendingApprovals(...args);
  expirePendingApprovals = (...args: Parameters<ApprovalRepository['expirePendingApprovals']>) => new ApprovalRepository(this.db).expirePendingApprovals(...args);
  expireApprovalIfPending = (...args: Parameters<ApprovalRepository['expireApprovalIfPending']>) => new ApprovalRepository(this.db).expireApprovalIfPending(...args);
  listUnpublishedExpiredApprovals = (...args: Parameters<ApprovalRepository['listUnpublishedExpiredApprovals']>) => new ApprovalRepository(this.db).listUnpublishedExpiredApprovals(...args);

  // ── Paired Remote Devices ────────────────────────────────────────────

  createPairedDevice(device: {
    id: string;
    deviceName: string;
    platform: 'android' | 'ios' | 'web';
    tokenHash: string;
    createdAt: number;
  }): PairedDevice {
    this.db
      .prepare(
        `INSERT INTO paired_devices (id, device_name, platform, token_hash, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(device.id, device.deviceName, device.platform, device.tokenHash, device.createdAt, device.createdAt);
    return {
      id: device.id,
      deviceName: device.deviceName,
      platform: device.platform,
      createdAt: device.createdAt,
      lastSeenAt: device.createdAt,
      revokedAt: null,
    };
  }

  listPairedDevices(): PairedDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM paired_devices ORDER BY created_at DESC')
      .all() as unknown as DeviceRow[];
    return rows.map(mapDevice);
  }

  findActiveDeviceByTokenHash(tokenHash: string): PairedDevice | null {
    const row = this.db
      .prepare('SELECT * FROM paired_devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash) as unknown as DeviceRow | undefined;
    if (!row) return null;
    this.db
      .prepare('UPDATE paired_devices SET last_seen_at = ? WHERE id = ?')
      .run(Date.now(), row.id);
    return mapDevice(row);
  }

  revokePairedDevice(id: string): boolean {
    const res = this.db
      .prepare('UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), id);
    return Number(res.changes) > 0;
  }

  // ── Phase 0 V2 Materialized Turn Items, Runs, Outbox, Handoffs, Checkpoints & FTS5 ──

  upsertTurnItem(item: TurnBlockRecord): TurnBlockRecord {
    return this.runInImmediateTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO session_turn_items (
            item_id, session_id, turn_id, seq, instance_id, driver_id, block_type,
            status, title, text_body, payload_json, output_omitted, omitted_bytes,
            raw_ref_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            status = excluded.status,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE session_turn_items.title END,
            text_body = excluded.text_body,
            payload_json = excluded.payload_json,
            output_omitted = excluded.output_omitted,
            omitted_bytes = excluded.omitted_bytes,
            raw_ref_json = COALESCE(excluded.raw_ref_json, session_turn_items.raw_ref_json),
            updated_at = excluded.updated_at`,
        )
        .run(
          item.itemId,
          item.sessionId,
          item.turnId ?? null,
          item.seq,
          item.instanceId,
          item.driverId,
          item.blockType,
          item.status,
          item.title ?? '',
          item.textBody ?? '',
          JSON.stringify(item.payload ?? {}),
          item.outputOmitted ? 1 : 0,
          item.omittedBytes ?? 0,
          item.rawRef ? JSON.stringify(item.rawRef) : null,
          item.createdAt,
          item.updatedAt,
        );
      if (!this.isSecretTurnBlock(item.blockType, item.payload) && (item.textBody ?? '').trim()) {
        const row = this.db
          .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
          .get(item.sessionId) as { workspace_id?: string } | undefined;
        if (row?.workspace_id) {
          this.appendSessionChangeInTx(
            'upsert_item',
            item.sessionId,
            row.workspace_id,
            item.itemId,
            undefined,
            item.updatedAt,
          );
        }
      }
      return this.getTurnItem(item.itemId)!;
    });
  }

  deleteTurnItem(sessionId: string, itemId: string): boolean {
    return this.runInImmediateTransaction(() => {
      const row = this.db
        .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
        .get(sessionId) as { workspace_id?: string } | undefined;
      const res = this.db
        .prepare('DELETE FROM session_turn_items WHERE session_id = ? AND item_id = ?')
        .run(sessionId, itemId);
      const deleted = Number(res.changes) > 0;
      if (deleted && row?.workspace_id) {
        this.appendSessionChangeInTx('delete_item', sessionId, row.workspace_id, itemId);
      }
      return deleted;
    });
  }

  getLatestSessionChangeSeq(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(change_seq), 0) AS latest_seq FROM session_change_log')
      .get() as { latest_seq?: number } | undefined;
    return typeof row?.latest_seq === 'number' ? row.latest_seq : 0;
  }

  listSnapshotTurnItems(workspaceId?: string): { watermarkSeq: number; items: SnapshotTurnItemRow[] } {
    return this.runInReadTransaction(() => {
      const watermarkSeq = this.getLatestSessionChangeSeq();
      const sql = `SELECT ti.session_id, s.title AS session_title, s.workspace_id,
                          ti.item_id, COALESCE(ti.turn_id, '') AS turn_id, ti.seq AS turn_seq,
                          ti.driver_id, ti.block_type, ti.text_body, ti.payload_json,
                          ti.created_at, ti.updated_at
                   FROM session_turn_items ti
                   JOIN sessions s ON s.id = ti.session_id
                   WHERE ti.text_body != ''
                     AND ti.block_type != 'secret_request'
                     ${workspaceId ? 'AND s.workspace_id = ?' : ''}
                   ORDER BY ti.session_id ASC, ti.seq ASC, ti.item_id ASC`;
      const rows = (workspaceId
        ? this.db.prepare(sql).all(workspaceId)
        : this.db.prepare(sql).all()) as unknown as Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        item_id: string;
        turn_id: string;
        turn_seq: number;
        driver_id: string;
        block_type: string;
        text_body: string;
        payload_json: string;
        created_at: number;
        updated_at: number;
      }>;

      const items: SnapshotTurnItemRow[] = [];
      for (const row of rows) {
        if (!row.text_body.trim()) continue;
        const payload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
        if (this.isSecretTurnBlock(row.block_type, payload)) continue;
        items.push({
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          workspaceId: row.workspace_id,
          itemId: row.item_id,
          turnId: row.turn_id,
          turnSeq: row.turn_seq,
          driverId: row.driver_id,
          blockType: row.block_type,
          textBody: row.text_body,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }
      return { watermarkSeq, items };
    });
  }

  listCommittedSessionChanges(opts: {
    afterSeq: number;
    limit: number;
    workspaceId?: string;
  }): { latestSeq: number; rows: CommittedChangeRawRow[]; hasMore: boolean } {
    return this.runInReadTransaction(() => {
      const latestSeq = this.getLatestSessionChangeSeq();
      const safeAfter = Math.max(0, Math.floor(opts.afterSeq));
      const safeLimit = Math.min(1000, Math.max(1, Math.floor(opts.limit)));
      const sql = `SELECT l.change_seq, l.kind, l.session_id, l.workspace_id, l.item_id, l.payload_json, l.committed_at,
                          ti.turn_id, ti.seq AS turn_seq, ti.driver_id, ti.block_type, ti.text_body,
                          ti.payload_json AS item_payload_json, ti.created_at AS item_created_at, ti.updated_at AS item_updated_at,
                          s.title AS session_title, s.harness_id, s.harness_kind, s.status AS session_status, s.updated_at AS session_updated_at
                   FROM session_change_log l
                   LEFT JOIN session_turn_items ti ON ti.item_id = l.item_id
                   LEFT JOIN sessions s ON s.id = l.session_id
                   WHERE l.change_seq > ?
                     ${opts.workspaceId ? 'AND l.workspace_id = ?' : ''}
                   ORDER BY l.change_seq ASC
                   LIMIT ?`;
      const params: Array<string | number> = opts.workspaceId
        ? [safeAfter, opts.workspaceId, safeLimit + 1]
        : [safeAfter, safeLimit + 1];
      const raw = this.db.prepare(sql).all(...params) as unknown as Array<{
        change_seq: number;
        kind: string;
        session_id: string;
        workspace_id: string;
        item_id: string | null;
        payload_json: string | null;
        committed_at: number;
        turn_id: string | null;
        turn_seq: number | null;
        driver_id: string | null;
        block_type: string | null;
        text_body: string | null;
        item_payload_json: string | null;
        item_created_at: number | null;
        item_updated_at: number | null;
        session_title: string | null;
        harness_id: string | null;
        harness_kind: string | null;
        session_status: string | null;
        session_updated_at: number | null;
      }>;
      const hasMore = raw.length > safeLimit;
      const sliced = hasMore ? raw.slice(0, safeLimit) : raw;
      return {
        latestSeq,
        hasMore,
        rows: sliced.map((r) => ({
          changeSeq: r.change_seq,
          kind: r.kind as SessionChangeKind,
          sessionId: r.session_id,
          workspaceId: r.workspace_id,
          itemId: r.item_id,
          committedAt: r.committed_at,
          payloadJson: r.payload_json,
          turnId: r.turn_id,
          turnSeq: r.turn_seq,
          driverId: r.driver_id,
          blockType: r.block_type,
          textBody: r.text_body,
          itemPayloadJson: r.item_payload_json,
          itemCreatedAt: r.item_created_at,
          itemUpdatedAt: r.item_updated_at,
          sessionTitle: r.session_title,
          harnessId: r.harness_id,
          harnessKind: r.harness_kind,
          sessionStatus: r.session_status,
          sessionUpdatedAt: r.session_updated_at,
        })),
      };
    });
  }

  getTurnItem(itemId: string): TurnBlockRecord | null {
    const row = this.db
      .prepare('SELECT * FROM session_turn_items WHERE item_id = ?')
      .get(itemId) as unknown as TurnItemRow | undefined;
    return row ? mapTurnItem(row) : null;
  }

  listTurnItems(
    sessionId: string,
    opts?: { afterSeq?: number; turnId?: string; blockTypes?: string[]; limit?: number },
  ): TurnBlockRecord[] {
    const clauses = ['session_id = ?'];
    const params: (string | number)[] = [sessionId];
    if (opts?.afterSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(opts.afterSeq);
    }
    if (opts?.turnId) {
      clauses.push('turn_id = ?');
      params.push(opts.turnId);
    }
    if (opts?.blockTypes && opts.blockTypes.length > 0) {
      clauses.push(`block_type IN (${opts.blockTypes.map(() => '?').join(', ')})`);
      params.push(...opts.blockTypes);
    }
    const limit = Math.min(2000, Math.max(1, opts?.limit ?? 500));
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM session_turn_items
         WHERE ${clauses.join(' AND ')}
         ORDER BY seq ASC, created_at ASC
         LIMIT ?`,
      )
      .all(...params) as unknown as TurnItemRow[];
    return rows.map(mapTurnItem);
  }

  settleRunningTurnItems(sessionId?: string, status: TurnBlockStatus = 'interrupted'): number {
    const now = Date.now();
    const res = sessionId
      ? this.db
          .prepare(
            `UPDATE session_turn_items
             SET status = ?, updated_at = ?
             WHERE session_id = ? AND status IN ('pending', 'running')`,
          )
          .run(status, now, sessionId)
      : this.db
          .prepare(
            `UPDATE session_turn_items
             SET status = ?, updated_at = ?
             WHERE status IN ('pending', 'running')`,
          )
          .run(status, now);
    return Number(res.changes);
  }

  startSessionRun(run: SessionRunRecord): SessionRunRecord {
    this.db
      .prepare(
        `INSERT INTO session_runs (
          run_id, session_id, turn_id, instance_id, driver_id, model,
          status, failure_class, usage_json, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.sessionId,
        run.turnId,
        run.instanceId,
        run.driverId,
        run.model ?? null,
        run.status,
        run.failureClass ?? null,
        run.usage ? JSON.stringify(run.usage) : null,
        run.startedAt,
        run.endedAt ?? null,
      );
    return run;
  }

  finishSessionRun(
    runId: string,
    patch: { status: SessionRunStatus; failureClass?: string | null; usage?: TokenUsage | null; endedAt?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE session_runs
         SET status = ?, failure_class = COALESCE(?, failure_class),
             usage_json = COALESCE(?, usage_json), ended_at = ?
         WHERE run_id = ?`,
      )
      .run(
        patch.status,
        patch.failureClass ?? null,
        patch.usage ? JSON.stringify(patch.usage) : null,
        patch.endedAt ?? Date.now(),
        runId,
      );
  }

  listSessionRuns(sessionId: string, limit = 100): SessionRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM session_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as SessionRunRow[];
    return rows.map(mapSessionRun);
  }

  recordCommandReceipt(receipt: {
    receiptId: string;
    sessionId: string;
    idempotencyKey: string;
    commandType: string;
    status: string;
    result?: Record<string, unknown> | null;
  }): boolean {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts (
          receipt_id, session_id, idempotency_key, command_type, status, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.receiptId,
        receipt.sessionId,
        receipt.idempotencyKey,
        receipt.commandType,
        receipt.status,
        receipt.result ? JSON.stringify(receipt.result) : null,
        now,
        now,
      );
    return Number(res.changes) === 1;
  }

  getCommandReceiptByKey(idempotencyKey: string): {
    receiptId: string;
    sessionId: string;
    commandType: string;
    status: string;
    result: Record<string, unknown> | null;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM command_receipts WHERE idempotency_key = ?')
      .get(idempotencyKey) as
      | { receipt_id: string; session_id: string; command_type: string; status: string; result_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      receiptId: row.receipt_id,
      sessionId: row.session_id,
      commandType: row.command_type,
      status: row.status,
      result: safeJsonParse<Record<string, unknown> | null>(row.result_json, null),
    };
  }

  enqueueOutboxEffect(effect: {
    effectId: string;
    sessionId: string;
    effectType: string;
    durability: EffectOutboxDurability;
    payload: Record<string, unknown>;
  }): EffectOutboxRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO effect_outbox (
          effect_id, session_id, effect_type, durability, payload_json, status, attempts, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      )
      .run(
        effect.effectId,
        effect.sessionId,
        effect.effectType,
        effect.durability,
        JSON.stringify(effect.payload ?? {}),
        now,
        now,
      );
    return {
      ...effect,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  claimPendingOutboxEffects(limit = 32): EffectOutboxRecord[] {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM effect_outbox
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(limit) as unknown as EffectOutboxRow[];
      const mark = this.db.prepare(
        "UPDATE effect_outbox SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE effect_id = ?",
      );
      for (const row of rows) {
        mark.run(now, row.effect_id);
      }
      this.db.exec('COMMIT');
      return rows.map((row) => ({ ...mapOutboxRow(row), status: 'running', attempts: row.attempts + 1, updatedAt: now }));
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  completeOutboxEffect(effectId: string): void {
    this.db
      .prepare("UPDATE effect_outbox SET status = 'completed', updated_at = ? WHERE effect_id = ?")
      .run(Date.now(), effectId);
  }

  failOutboxEffect(effectId: string, error: string, retryable = false): void {
    const nextStatus: EffectOutboxStatus = retryable ? 'pending' : 'failed';
    this.db
      .prepare('UPDATE effect_outbox SET status = ?, last_error = ?, updated_at = ? WHERE effect_id = ?')
      .run(nextStatus, error.slice(0, 1000), Date.now(), effectId);
  }

  listOutboxEffects(status?: EffectOutboxStatus): EffectOutboxRecord[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM effect_outbox WHERE status = ? ORDER BY created_at ASC')
          .all(status) as unknown as EffectOutboxRow[])
      : (this.db
          .prepare('SELECT * FROM effect_outbox ORDER BY created_at ASC')
          .all() as unknown as EffectOutboxRow[]);
    return rows.map(mapOutboxRow);
  }

  /**
   * Atomic crash recovery on daemon startup:
   * - Settles any orphaned 'running' session_runs and 'pending'/'running' session_turn_items to 'interrupted'
   * - Cancels PROCESS_BOUND outbox effects (must NEVER replay across dead OS processes)
   * - Resets interrupted REPLAY_SAFE outbox effects back to 'pending' so EffectWorker resumes them
   * - Expires orphaned pending approvals
   */
  recoverCrashStateOnStartup(): {
    settledRuns: number;
    settledItems: number;
    cancelledProcessBoundEffects: number;
    requeuedReplaySafeEffects: number;
    expiredApprovals: number;
    settledSubagents: number;
  } {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const settledRuns = Number(
        this.db
          .prepare(
            `UPDATE session_runs
             SET status = 'interrupted', failure_class = COALESCE(failure_class, 'process_restart'), ended_at = ?
             WHERE status = 'running'`,
          )
          .run(now).changes,
      );
      const settledItems = Number(
        this.db
          .prepare(
            `UPDATE session_turn_items
             SET status = 'interrupted', updated_at = ?
             WHERE status IN ('pending', 'running')`,
          )
          .run(now).changes,
      );
      const cancelledProcessBoundEffects = Number(
        this.db
          .prepare(
            `UPDATE effect_outbox
             SET status = 'cancelled', last_error = 'Cancelled on restart (PROCESS_BOUND)', updated_at = ?
             WHERE durability = 'PROCESS_BOUND' AND status IN ('pending', 'running')`,
          )
          .run(now).changes,
      );
      const requeuedReplaySafeEffects = Number(
        this.db
          .prepare(
            `UPDATE effect_outbox
             SET status = 'pending', updated_at = ?
             WHERE durability = 'REPLAY_SAFE' AND status = 'running'`,
          )
          .run(now).changes,
      );
      const expiredApprovals = 0; // request provider performs its own recovery before snapshots
      // Converge orphaned running/queued/awaiting_approval subagent runs to stopped while preserving worktree_path & branch_name
      const settledSubagents = Number(
        this.db
          .prepare(
            `UPDATE subagent_runs
             SET status = 'stopped',
                 error = COALESCE(error, 'Daemon restarted; subagent stopped and worktree preserved'),
                 finished_at = COALESCE(finished_at, ?)
             WHERE status IN ('queued', 'running', 'awaiting_approval')`,
          )
          .run(now).changes,
      );
      this.db.exec('COMMIT');
      return {
        settledRuns,
        settledItems,
        cancelledProcessBoundEffects,
        requeuedReplaySafeEffects,
        expiredApprovals,
        settledSubagents,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createHandoffRecord(record: SessionHandoffRecord): SessionHandoffRecord {
    this.db
      .prepare(
        `INSERT INTO session_handoffs (
          handoff_id, session_id, turn_id, from_instance_id, to_instance_id, mode,
          delivery_channel, delivery_status, covered_up_to_seq, estimated_chars,
          redacted_count, force_fresh_reason, snapshot_json, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.handoffId,
        record.sessionId,
        record.turnId ?? null,
        record.fromInstanceId ?? null,
        record.toInstanceId,
        record.mode,
        record.deliveryChannel,
        record.deliveryStatus,
        record.coveredUpToSeq,
        record.estimatedChars ?? 0,
        record.redactedCount ?? 0,
        record.forceFreshReason ?? null,
        JSON.stringify(record.snapshot ?? {}),
        record.createdAt,
        record.confirmedAt ?? null,
      );
    return record;
  }

  updateHandoffDeliveryStatus(
    handoffId: string,
    status: HandoffDeliveryStatus,
    confirmedAt?: number | null,
  ): void {
    this.db
      .prepare('UPDATE session_handoffs SET delivery_status = ?, confirmed_at = COALESCE(?, confirmed_at) WHERE handoff_id = ?')
      .run(status, status === 'confirmed' ? (confirmedAt ?? Date.now()) : null, handoffId);
  }

  getLatestHandoffRecord(sessionId: string, toInstanceId: string): SessionHandoffRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM session_handoffs
         WHERE session_id = ? AND to_instance_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, toInstanceId) as unknown as HandoffRow | undefined;
    return row ? mapHandoffRow(row) : null;
  }

  listHandoffRecords(sessionId: string, limit = 50): SessionHandoffRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM session_handoffs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as HandoffRow[];
    return rows.map(mapHandoffRow);
  }

  createCheckpointRecord(record: SessionCheckpointRecord): SessionCheckpointRecord {
    this.db
      .prepare(
        `INSERT INTO session_checkpoints (
          checkpoint_id, session_id, turn_seq, phase, git_ref, tree_sha, base_head_sha,
          files_changed, insertions, deletions, skipped_large_files_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.checkpointId,
        record.sessionId,
        record.turnSeq,
        record.phase,
        record.gitRef,
        record.treeSha,
        record.baseHeadSha ?? null,
        record.filesChanged ?? 0,
        record.insertions ?? 0,
        record.deletions ?? 0,
        JSON.stringify(record.skippedLargeFiles ?? []),
        record.createdAt,
      );
    return record;
  }

  listCheckpointRecords(sessionId: string, limit = 100): SessionCheckpointRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM session_checkpoints WHERE session_id = ? ORDER BY turn_seq DESC, created_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as CheckpointRow[];
    return rows.map(mapCheckpointRow);
  }

  getCheckpointRecord(checkpointId: string): SessionCheckpointRecord | null {
    const row = this.db
      .prepare('SELECT * FROM session_checkpoints WHERE checkpoint_id = ?')
      .get(checkpointId) as unknown as CheckpointRow | undefined;
    return row ? mapCheckpointRow(row) : null;
  }

  deleteCheckpointRecords(sessionId: string, checkpointIds?: string[]): number {
    if (checkpointIds && checkpointIds.length > 0) {
      const placeholders = checkpointIds.map(() => '?').join(', ');
      const res = this.db
        .prepare(`DELETE FROM session_checkpoints WHERE session_id = ? AND checkpoint_id IN (${placeholders})`)
        .run(sessionId, ...checkpointIds);
      return Number(res.changes);
    }
    const res = this.db
      .prepare('DELETE FROM session_checkpoints WHERE session_id = ?')
      .run(sessionId);
    return Number(res.changes);
  }

  // ── Multi-Harness Parallel Subagent Runs ────────────────────────────

  createSubagentRun(record: SubagentRunRecord): SubagentRunRecord {
    this.db
      .prepare(
        `INSERT INTO subagent_runs (
          subagent_id, cohort_id, parent_session_id, child_session_id,
          target_instance_id, target_driver_id, role_title, prompt,
          isolation, worktree_path, branch_name, base_branch,
          effective_approval_policy, requested_approval_policy,
          depth, timeout_ms, fail_fast, status,
          diff_stat_json, summary, error,
          merged_at, merged_into_branch, worktree_cleaned,
          created_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.subagentId,
        record.cohortId,
        record.parentSessionId,
        record.childSessionId,
        record.targetInstanceId,
        record.targetDriverId ?? null,
        record.roleTitle,
        record.prompt ?? '',
        record.isolation,
        record.worktreePath ?? null,
        record.branchName ?? null,
        record.baseBranch ?? null,
        record.effectiveApprovalPolicy,
        record.requestedApprovalPolicy ?? null,
        record.depth ?? 1,
        record.timeoutMs ?? 15 * 60 * 1000,
        record.failFast ? 1 : 0,
        record.status,
        record.diffStat ? JSON.stringify(record.diffStat) : null,
        record.summary ?? null,
        record.error ?? null,
        record.mergedAt ?? null,
        record.mergedIntoBranch ?? null,
        record.worktreeCleaned ? 1 : 0,
        record.createdAt,
        record.finishedAt ?? null,
      );
    return this.getSubagentRun(record.subagentId)!;
  }

  getSubagentRun(subagentId: string): SubagentRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM subagent_runs WHERE subagent_id = ?')
      .get(subagentId) as unknown as SubagentRunRow | undefined;
    return row ? mapSubagentRunRow(row) : null;
  }

  getSubagentRunByChildSession(childSessionId: string): SubagentRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM subagent_runs WHERE child_session_id = ?')
      .get(childSessionId) as unknown as SubagentRunRow | undefined;
    return row ? mapSubagentRunRow(row) : null;
  }

  listSubagentRuns(filter?: {
    parentSessionId?: string;
    cohortId?: string;
    statuses?: SubagentStatus[];
    limit?: number;
  }): SubagentRunRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.parentSessionId) {
      where.push('parent_session_id = ?');
      params.push(filter.parentSessionId);
    }
    if (filter?.cohortId) {
      where.push('cohort_id = ?');
      params.push(filter.cohortId);
    }
    if (filter?.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const sql = `SELECT * FROM subagent_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`;
    params.push(filter?.limit ?? 200);
    const rows = this.db.prepare(sql).all(...params) as unknown as SubagentRunRow[];
    return rows.map(mapSubagentRunRow);
  }

  updateSubagentRun(
    subagentId: string,
    patch: Partial<
      Pick<
        SubagentRunRecord,
        | 'status'
        | 'diffStat'
        | 'summary'
        | 'error'
        | 'mergedAt'
        | 'mergedIntoBranch'
        | 'worktreeCleaned'
        | 'finishedAt'
      >
    >,
  ): SubagentRunRecord | null {
    const current = this.getSubagentRun(subagentId);
    if (!current) return null;
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.diffStat !== undefined) {
      fields.push('diff_stat_json = ?');
      params.push(patch.diffStat ? JSON.stringify(patch.diffStat) : null);
    }
    if (patch.summary !== undefined) {
      fields.push('summary = ?');
      params.push(patch.summary ?? null);
    }
    if (patch.error !== undefined) {
      fields.push('error = ?');
      params.push(patch.error ?? null);
    }
    if (patch.mergedAt !== undefined) {
      fields.push('merged_at = ?');
      params.push(patch.mergedAt ?? null);
    }
    if (patch.mergedIntoBranch !== undefined) {
      fields.push('merged_into_branch = ?');
      params.push(patch.mergedIntoBranch ?? null);
    }
    if (patch.worktreeCleaned !== undefined) {
      fields.push('worktree_cleaned = ?');
      params.push(patch.worktreeCleaned ? 1 : 0);
    }
    if (patch.finishedAt !== undefined) {
      fields.push('finished_at = ?');
      params.push(patch.finishedAt ?? null);
    }
    if (fields.length === 0) return current;
    params.push(subagentId);
    this.db.prepare(`UPDATE subagent_runs SET ${fields.join(', ')} WHERE subagent_id = ?`).run(...params);
    return this.getSubagentRun(subagentId);
  }

  settleActiveSubagentRuns(reason = 'Recovered on startup; worktree preserved'): SubagentRunRecord[] {
    const active = this.listSubagentRuns({ statuses: ['queued', 'running', 'awaiting_approval'] });
    if (active.length === 0) return [];
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE subagent_runs
         SET status = 'stopped',
             error = COALESCE(error, ?),
             finished_at = COALESCE(finished_at, ?)
         WHERE status IN ('queued', 'running', 'awaiting_approval')`,
      )
      .run(reason, now);
    return active.map((r) => this.getSubagentRun(r.subagentId)!).filter(Boolean);
  }

  indexSearchItem(entry: {
    sessionId: string;
    itemId: string;
    turnId: string | null;
    driverId: string;
    title: string;
    body: string;
  }): void {
    this.db.prepare('DELETE FROM session_search_fts WHERE item_id = ?').run(entry.itemId);
    this.db
      .prepare(
        'INSERT INTO session_search_fts (session_id, item_id, turn_id, driver_id, title, body) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entry.sessionId, entry.itemId, entry.turnId ?? '', entry.driverId, entry.title, entry.body);
  }

  deleteSessionSearchIndex(sessionId: string): void {
    this.db.prepare('DELETE FROM session_search_fts WHERE session_id = ?').run(sessionId);
  }

  listUnindexedTurnItems(limit = 20): Array<TurnBlockRecord & { sessionTitle: string }> {
    const rows = this.db
      .prepare(
        `SELECT ti.*, s.title AS session_title
         FROM session_turn_items ti
         JOIN sessions s ON s.id = ti.session_id
         WHERE ti.text_body != ''
           AND ti.block_type NOT IN ('secret_request')
           AND NOT EXISTS (SELECT 1 FROM session_search_fts f WHERE f.item_id = ti.item_id)
         ORDER BY ti.created_at DESC
         LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, limit))) as unknown as Array<TurnItemRow & { session_title: string }>;
    return rows.map((row) => ({ ...mapTurnItem(row), sessionTitle: row.session_title }));
  }

  searchSessionFts(query: string, limit = 25): Array<{
    sessionId: string;
    itemId: string;
    turnId: string;
    driverId: string;
    title: string;
    snippet: string;
  }> {
    const res = this.searchSessionFtsV2({ q: query, limit });
    return res.hits.map((h) => ({
      sessionId: h.sessionId,
      itemId: h.itemId,
      turnId: h.turnId,
      driverId: h.driverId,
      title: h.sessionTitle,
      snippet: h.snippetText,
    }));
  }

  searchSessionFtsV2(opts: {
    q: string;
    workspaceId?: string;
    driverId?: string;
    fromTs?: number;
    toTs?: number;
    limit?: number;
    offset?: number;
    forceLikeFallback?: boolean;
  }): { hits: SessionSearchHit[]; fallbackUsed: boolean } {
    const rawQuery = opts.q.trim();
    if (!rawQuery) return { hits: [], fallbackUsed: false };

    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const terms = extractSearchTerms(rawQuery);
    const ftsQuery = buildSafeFts5Query(rawQuery);

    const buildFilterClauses = (alias: { session: string; item: string; ftsDriverExpr: string }) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (opts.workspaceId) {
        clauses.push(`${alias.session}.workspace_id = ?`);
        params.push(opts.workspaceId);
      }
      if (opts.driverId) {
        clauses.push(`(${alias.ftsDriverExpr} = ? OR ${alias.session}.harness_kind = ? OR ${alias.session}.harness_id = ?)`);
        params.push(opts.driverId, opts.driverId, opts.driverId);
      }
      if (typeof opts.fromTs === 'number' && Number.isFinite(opts.fromTs)) {
        clauses.push(`COALESCE(${alias.item}.created_at, ${alias.session}.updated_at) >= ?`);
        params.push(opts.fromTs);
      }
      if (typeof opts.toTs === 'number' && Number.isFinite(opts.toTs)) {
        clauses.push(`COALESCE(${alias.item}.created_at, ${alias.session}.updated_at) <= ?`);
        params.push(opts.toTs);
      }
      return { clauses, params };
    };

    const runLikeFallback = (): SessionSearchHit[] => {
      const escapedPattern = `%${escapeLikePattern(rawQuery)}%`;
      const filter = buildFilterClauses({ session: 's', item: 'ti', ftsDriverExpr: 'ti.driver_id' });
      const whereParts = [
        "(ti.text_body LIKE ? ESCAPE '\\' OR ti.title LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')",
        ...filter.clauses,
      ];
      const rows = this.db
        .prepare(
          `SELECT ti.session_id, s.title AS session_title, s.workspace_id,
                  COALESCE(ti.turn_id, '') AS turn_id, ti.seq AS turn_seq,
                  ti.item_id, ti.block_type, ti.text_body AS body, ti.driver_id,
                  ti.created_at
           FROM session_turn_items ti
           JOIN sessions s ON s.id = ti.session_id
           WHERE ${whereParts.join(' AND ')}
           ORDER BY ti.created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(escapedPattern, escapedPattern, escapedPattern, ...filter.params, limit, offset) as unknown as Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        turn_id: string;
        turn_seq: number;
        item_id: string;
        block_type: string;
        body: string;
        driver_id: string;
        created_at: number;
      }>;
      return rows.map((row) => {
        const snippet = buildSafeHighlightedSnippet(row.body || row.session_title, terms);
        return {
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          workspaceId: row.workspace_id,
          turnId: row.turn_id,
          turnSeq: row.turn_seq ?? 0,
          itemId: row.item_id,
          blockType: row.block_type || 'assistant_text',
          snippetText: snippet.text,
          snippetHtmlSafe: snippet.htmlSafe,
          highlights: snippet.highlights,
          driverId: row.driver_id,
          createdAt: row.created_at,
        };
      });
    };

    if (opts.forceLikeFallback || !ftsQuery) {
      return { hits: runLikeFallback(), fallbackUsed: true };
    }

    try {
      const filter = buildFilterClauses({ session: 's', item: 'ti', ftsDriverExpr: 'f.driver_id' });
      const whereParts = ['session_search_fts MATCH ?', ...filter.clauses];
      const rows = this.db
        .prepare(
          `SELECT f.session_id,
                  COALESCE(s.title, f.title) AS session_title,
                  COALESCE(s.workspace_id, '') AS workspace_id,
                  f.turn_id,
                  COALESCE(ti.seq, 0) AS turn_seq,
                  f.item_id,
                  COALESCE(ti.block_type, 'assistant_text') AS block_type,
                  f.body,
                  f.driver_id,
                  COALESCE(ti.created_at, s.updated_at, 0) AS created_at
           FROM session_search_fts f
           LEFT JOIN sessions s ON s.id = f.session_id
           LEFT JOIN session_turn_items ti ON ti.item_id = f.item_id
           WHERE ${whereParts.join(' AND ')}
           ORDER BY bm25(session_search_fts) ASC, created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(ftsQuery, ...filter.params, limit, offset) as unknown as Array<{
        session_id: string;
        session_title: string;
        workspace_id: string;
        turn_id: string;
        turn_seq: number;
        item_id: string;
        block_type: string;
        body: string;
        driver_id: string;
        created_at: number;
      }>;

      if (rows.length === 0 && /[\u4e00-\u9fff]/.test(rawQuery)) {
        // SQLite default unicode61 tokenizer treats contiguous CJK runs as single tokens;
        // fall back cleanly to parameterized LIKE so substring CJK searches always work.
        const likeHits = runLikeFallback();
        if (likeHits.length > 0) {
          return { hits: likeHits, fallbackUsed: true };
        }
      }

      const hits: SessionSearchHit[] = rows.map((row) => {
        const snippet = buildSafeHighlightedSnippet(row.body || row.session_title, terms);
        return {
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          workspaceId: row.workspace_id,
          turnId: row.turn_id,
          turnSeq: row.turn_seq ?? 0,
          itemId: row.item_id,
          blockType: row.block_type || 'assistant_text',
          snippetText: snippet.text,
          snippetHtmlSafe: snippet.htmlSafe,
          highlights: snippet.highlights,
          driverId: row.driver_id,
          createdAt: row.created_at,
        };
      });
      return { hits, fallbackUsed: false };
    } catch {
      return { hits: runLikeFallback(), fallbackUsed: true };
    }
  }

  getSqlTransactionAccess(): SqlTransactionAccess {
    return {
      runImmediate: <T>(fn: (tx: SqlTransactionContext) => T): T =>
        this.runInImmediateTransaction((db) =>
          fn({
            exec: (sql) => db.exec(sql),
            prepare: (sql) => db.prepare(sql),
            markCommittedSeq: (seq) => {
              this.pendingCommitSeq = this.pendingCommitSeq === null ? seq : Math.max(this.pendingCommitSeq, seq);
            },
          })),
      runRead: <T>(fn: (tx: { prepare(sql: string): ReturnType<DatabaseSync['prepare']> }) => T): T =>
        this.runInReadTransaction((db) =>
          fn({
            prepare: (sql) => db.prepare(sql),
          })),
    };
  }

  upsertResourceOwner(input: Omit<ResourceOwnerRecord, 'updatedAt'> & { updatedAt?: number }): ResourceOwnerRecord {
    const updatedAt = input.updatedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO resource_owners (resource_type, resource_id, contract, instance_id, workspace_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_id, contract) DO UPDATE SET
           instance_id = excluded.instance_id,
           workspace_id = COALESCE(excluded.workspace_id, resource_owners.workspace_id),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.resourceType,
        input.resourceId,
        input.contract,
        input.instanceId,
        input.workspaceId ?? null,
        updatedAt,
      );
    return {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      contract: input.contract,
      instanceId: input.instanceId,
      workspaceId: input.workspaceId ?? null,
      updatedAt,
    };
  }

  getResourceOwner(
    resourceType: 'workspace' | 'session',
    resourceId: string,
    contract: string,
  ): ResourceOwnerRecord | null {
    const row = this.db
      .prepare(
        `SELECT resource_type, resource_id, contract, instance_id, workspace_id, updated_at
         FROM resource_owners
         WHERE resource_type = ? AND resource_id = ? AND contract = ?`,
      )
      .get(resourceType, resourceId, contract) as
      | {
          resource_type: string;
          resource_id: string;
          contract: string;
          instance_id: string;
          workspace_id: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      resourceType: row.resource_type as 'workspace' | 'session',
      resourceId: row.resource_id,
      contract: row.contract,
      instanceId: row.instance_id,
      workspaceId: row.workspace_id,
      updatedAt: row.updated_at,
    };
  }

  deleteResourceOwner(
    resourceType: 'workspace' | 'session',
    resourceId: string,
    contract?: string,
  ): void {
    if (contract) {
      this.db
        .prepare('DELETE FROM resource_owners WHERE resource_type = ? AND resource_id = ? AND contract = ?')
        .run(resourceType, resourceId, contract);
      return;
    }
    this.db
      .prepare('DELETE FROM resource_owners WHERE resource_type = ? AND resource_id = ?')
      .run(resourceType, resourceId);
  }

  listResourceOwners(filter?: {
    resourceType?: 'workspace' | 'session';
    contract?: string;
    instanceId?: string;
    workspaceId?: string;
  }): ResourceOwnerRecord[] {
    const clauses: string[] = [];
    const args: Array<string> = [];
    if (filter?.resourceType) {
      clauses.push('resource_type = ?');
      args.push(filter.resourceType);
    }
    if (filter?.contract) {
      clauses.push('contract = ?');
      args.push(filter.contract);
    }
    if (filter?.instanceId) {
      clauses.push('instance_id = ?');
      args.push(filter.instanceId);
    }
    if (filter?.workspaceId) {
      clauses.push('workspace_id = ?');
      args.push(filter.workspaceId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT resource_type, resource_id, contract, instance_id, workspace_id, updated_at
         FROM resource_owners
         ${whereSql}
         ORDER BY updated_at ASC`,
      )
      .all(...args) as Array<{
      resource_type: string;
      resource_id: string;
      contract: string;
      instance_id: string;
      workspace_id: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      resourceType: row.resource_type as 'workspace' | 'session',
      resourceId: row.resource_id,
      contract: row.contract,
      instanceId: row.instance_id,
      workspaceId: row.workspace_id,
      updatedAt: row.updated_at,
    }));
  }

  getSessionTurnReceipt(sessionId: string, requestId: string): SessionTurnReceiptRecord | null {
    const row = this.db
      .prepare(
        `SELECT session_id, request_id, request_hash, turn_id, run_id, status, runtime_instance_id, runtime_run_id, created_at, updated_at
         FROM session_turn_receipts
         WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as
      | {
          session_id: string;
          request_id: string;
          request_hash: string;
          turn_id: string;
          run_id: string;
          status: string;
          runtime_instance_id: string;
          runtime_run_id: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      requestId: row.request_id,
      requestHash: row.request_hash,
      turnId: row.turn_id,
      runId: row.run_id,
      status: row.status as SessionTurnReceiptRecord['status'],
      runtimeInstanceId: row.runtime_instance_id,
      runtimeRunId: row.runtime_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertSessionTurnReceipt(input: Omit<SessionTurnReceiptRecord, 'createdAt' | 'updatedAt'> & {
    createdAt?: number;
    updatedAt?: number;
  }): SessionTurnReceiptRecord {
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO session_turn_receipts (
           session_id, request_id, request_hash, turn_id, run_id, status, runtime_instance_id, runtime_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, request_id) DO UPDATE SET
           request_hash = excluded.request_hash,
           turn_id = excluded.turn_id,
           run_id = excluded.run_id,
           status = excluded.status,
           runtime_instance_id = excluded.runtime_instance_id,
           runtime_run_id = excluded.runtime_run_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.requestId,
        input.requestHash,
        input.turnId,
        input.runId,
        input.status,
        input.runtimeInstanceId,
        input.runtimeRunId,
        createdAt,
        updatedAt,
      );
    return {
      ...input,
      createdAt,
      updatedAt,
    };
  }

  updateSessionTurnReceiptStatus(
    sessionId: string,
    requestId: string,
    patch: {
      turnId?: string;
      runId?: string;
      status: SessionTurnReceiptRecord['status'];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE session_turn_receipts
         SET turn_id = COALESCE(?, turn_id),
             run_id = COALESCE(?, run_id),
             status = ?,
             updated_at = ?
         WHERE session_id = ? AND request_id = ?`,
      )
      .run(
        patch.turnId ?? null,
        patch.runId ?? null,
        patch.status,
        Date.now(),
        sessionId,
        requestId,
      );
  }
}

export function escapeFts5Query(raw: string): string {
  return buildSafeFts5Query(raw);
}

function buildSafeFts5Query(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Split on whitespace & FTS5 syntax punctuation so -, ", *, NEAR, NOT, AND, OR, :, ^, () cannot break FTS5 MATCH
  const tokens = trimmed
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(' ');
}

function extractSearchTerms(raw: string): string[] {
  const stripped = raw
    .replace(/["*^():+~]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/^-+/, '').trim())
    .filter((tok) => tok.length > 0);
  const unique = [...new Set(stripped.length > 0 ? stripped : [raw.trim()].filter(Boolean))];
  return unique.sort((a, b) => b.length - a.length);
}

function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSafeHighlightedSnippet(
  body: string,
  terms: string[],
  windowChars = 160,
): { text: string; htmlSafe: string; highlights: Array<{ start: number; end: number }> } {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) return { text: '', htmlSafe: '', highlights: [] };

  const lower = normalized.toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (firstMatch < 0 || idx < firstMatch)) {
      firstMatch = idx;
    }
  }

  let start = 0;
  let end = Math.min(normalized.length, windowChars);
  if (firstMatch > 40) {
    start = Math.max(0, firstMatch - 40);
    end = Math.min(normalized.length, start + windowChars);
  }
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  const snippetText = `${prefix}${normalized.slice(start, end)}${suffix}`;

  // Locate non-overlapping highlight spans inside snippetText
  const lowerSnippet = snippetText.toLowerCase();
  const spans: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let pos = 0;
    while (pos < lowerSnippet.length) {
      const idx = lowerSnippet.indexOf(needle, pos);
      if (idx < 0) break;
      const spanEnd = idx + needle.length;
      const overlaps = spans.some((s) => !(spanEnd <= s.start || idx >= s.end));
      if (!overlaps) {
        spans.push({ start: idx, end: spanEnd });
      }
      pos = spanEnd;
    }
  }
  spans.sort((a, b) => a.start - b.start);

  // Build XSS-safe HTML string with <mark> only around matched ranges
  let cursor = 0;
  let html = '';
  for (const span of spans) {
    if (span.start > cursor) {
      html += escapeHtml(snippetText.slice(cursor, span.start));
    }
    html += `<mark>${escapeHtml(snippetText.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  if (cursor < snippetText.length) {
    html += escapeHtml(snippetText.slice(cursor));
  }
  return { text: snippetText, htmlSafe: html, highlights: spans };
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    isGitRepo: row.is_git_repo === 1,
    gitBranch: row.git_branch,
    createdAt: row.created_at,
  };
}

function mapSession(row: SessionRow, bindings?: SessionHarnessBinding[]): Session {
  const parsedParticipating = safeJsonParse<string[]>(row.participating_harnesses_json, []);
  const participatingSet = new Set<string>(parsedParticipating);
  if (row.harness_id) participatingSet.add(row.harness_id);
  if (bindings) {
    for (const b of bindings) {
      if (b.harnessId) participatingSet.add(b.harnessId);
    }
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    harnessId: row.harness_id,
    harnessKind: row.harness_kind as HarnessKind,
    nativeSessionId: row.native_session_id,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.forked_from_turn_seq != null ? { forkedFromTurnSeq: row.forked_from_turn_seq } : {}),
    ...(row.fork_mode ? { forkMode: row.fork_mode as 'native' | 'portable' } : {}),
    ...(row.import_mode ? { importMode: row.import_mode as 'mirror' | 'attach' } : {}),
    ...(row.import_source ? { importSource: row.import_source } : {}),
    participatingHarnesses: Array.from(participatingSet),
    contextSyncMode: (row.context_sync_mode as ContextSyncMode) || 'auto',
    bindings,
    cwd: row.cwd,
    worktreeBranch: row.worktree_branch,
    title: row.title,
    status: row.status as SessionStatus,
    model: row.model,
    actualModel: row.actual_model ?? null,
    modelReroutedReason: row.model_rerouted_reason ?? null,
    reasoningEffort: row.reasoning_effort as ReasoningEffort | null,
    permissionMode: row.permission_mode as PermissionMode,
    lastSeq: row.last_seq,
    usage: safeJsonParse<TokenUsage | null>(row.usage_json, null),
    pendingApprovalCount: row.pending_approval_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBinding(row: BindingRow): SessionHarnessBinding {
  return {
    sessionId: row.session_id,
    harnessId: row.harness_id,
    harnessKind: row.harness_kind as HarnessKind,
    nativeSessionId: row.native_session_id,
    lastModel: row.last_model,
    lastActualModel: row.last_actual_model,
    lastEffort: row.last_effort as ReasoningEffort | null,
    syncedUpToSeq: row.synced_up_to_seq ?? 0,
    driverUsed: (row.driver_used as ContextInjectionDriver | null) ?? null,
    updatedAt: row.updated_at,
  };
}

function mapTaskState(row: TaskStateRow): SessionTaskState {
  const failedAttempts = safeJsonParse<TaskFailedAttempt[]>(row.failed_attempts_json ?? null, []);
  return {
    sessionId: row.session_id,
    objective: row.objective ?? '',
    steps: safeJsonParse<TaskStep[]>(row.steps_json, []),
    decisions: safeJsonParse<string[]>(row.decisions_json, []),
    touchedFiles: safeJsonParse<string[]>(row.touched_files_json, []),
    verifications: safeJsonParse<TaskVerification[]>(row.verifications_json, []),
    blockers: safeJsonParse<string[]>(row.blockers_json, []),
    pinnedFacts: safeJsonParse<string[]>(row.pinned_facts_json, []),
    ...(failedAttempts.length > 0 ? { failedAttempts } : {}),
    rollingSummary: row.rolling_summary ?? '',
    summarizedUpToSeq: row.summarized_up_to_seq ?? 0,
    version: row.version ?? 1,
    ledgerFilePath: row.ledger_file_path ?? null,
    updatedAt: row.updated_at,
  };
}


function mapDevice(row: DeviceRow): PairedDevice {
  return {
    id: row.id,
    deviceName: row.device_name,
    platform: row.platform as 'android' | 'ios' | 'web',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

interface TurnItemRow {
  item_id: string;
  session_id: string;
  turn_id: string | null;
  seq: number;
  instance_id: string;
  driver_id: string;
  block_type: string;
  status: string;
  title: string;
  text_body: string;
  payload_json: string;
  output_omitted: number;
  omitted_bytes: number;
  raw_ref_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionRunRow {
  run_id: string;
  session_id: string;
  turn_id: string;
  instance_id: string;
  driver_id: string;
  model: string | null;
  status: string;
  failure_class: string | null;
  usage_json: string | null;
  started_at: number;
  ended_at: number | null;
}

interface EffectOutboxRow {
  effect_id: string;
  session_id: string;
  effect_type: string;
  durability: string;
  payload_json: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface HandoffRow {
  handoff_id: string;
  session_id: string;
  turn_id: string | null;
  from_instance_id: string | null;
  to_instance_id: string;
  mode: string;
  delivery_channel: string;
  delivery_status: string;
  covered_up_to_seq: number;
  estimated_chars: number;
  redacted_count: number;
  force_fresh_reason: string | null;
  snapshot_json: string;
  created_at: number;
  confirmed_at: number | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  turn_seq: number;
  phase: string;
  git_ref: string;
  tree_sha: string;
  base_head_sha: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  skipped_large_files_json: string;
  created_at: number;
}

function mapTurnItem(row: TurnItemRow): TurnBlockRecord {
  return {
    itemId: row.item_id,
    schemaVersion: 2,
    sessionId: row.session_id,
    turnId: row.turn_id,
    seq: row.seq,
    instanceId: row.instance_id,
    driverId: row.driver_id,
    blockType: row.block_type,
    status: row.status as TurnBlockStatus,
    title: row.title,
    textBody: row.text_body,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    outputOmitted: row.output_omitted === 1,
    omittedBytes: row.omitted_bytes ?? 0,
    rawRef: safeJsonParse<TurnBlockRecord['rawRef']>(row.raw_ref_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionRun(row: SessionRunRow): SessionRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    instanceId: row.instance_id,
    driverId: row.driver_id,
    model: row.model,
    status: row.status as SessionRunStatus,
    failureClass: row.failure_class,
    usage: safeJsonParse<TokenUsage | null>(row.usage_json, null),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapOutboxRow(row: EffectOutboxRow): EffectOutboxRecord {
  return {
    effectId: row.effect_id,
    sessionId: row.session_id,
    effectType: row.effect_type,
    durability: row.durability as EffectOutboxDurability,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    status: row.status as EffectOutboxStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHandoffRow(row: HandoffRow): SessionHandoffRecord {
  return {
    handoffId: row.handoff_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    fromInstanceId: row.from_instance_id,
    toInstanceId: row.to_instance_id,
    mode: row.mode as SessionHandoffRecord['mode'],
    deliveryChannel: row.delivery_channel as SessionHandoffRecord['deliveryChannel'],
    deliveryStatus: row.delivery_status as HandoffDeliveryStatus,
    coveredUpToSeq: row.covered_up_to_seq,
    estimatedChars: row.estimated_chars,
    redactedCount: row.redacted_count,
    forceFreshReason: row.force_fresh_reason,
    snapshot: safeJsonParse<Record<string, unknown>>(row.snapshot_json, {}),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function mapCheckpointRow(row: CheckpointRow): SessionCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    turnSeq: row.turn_seq,
    phase: row.phase as SessionCheckpointRecord['phase'],
    gitRef: row.git_ref,
    treeSha: row.tree_sha,
    baseHeadSha: row.base_head_sha,
    filesChanged: row.files_changed,
    insertions: row.insertions,
    deletions: row.deletions,
    skippedLargeFiles: safeJsonParse<string[]>(row.skipped_large_files_json, []),
    createdAt: row.created_at,
  };
}

function mapSubagentRunRow(row: SubagentRunRow): SubagentRunRecord {
  return {
    subagentId: row.subagent_id,
    cohortId: row.cohort_id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    targetInstanceId: row.target_instance_id,
    targetDriverId: row.target_driver_id ?? undefined,
    roleTitle: row.role_title,
    prompt: row.prompt ?? '',
    isolation: row.isolation as SubagentIsolation,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    effectiveApprovalPolicy: row.effective_approval_policy as PermissionMode,
    requestedApprovalPolicy: (row.requested_approval_policy as PermissionMode | null) ?? null,
    depth: row.depth,
    timeoutMs: row.timeout_ms,
    failFast: row.fail_fast === 1,
    status: row.status as SubagentStatus,
    diffStat: row.diff_stat_json ? safeJsonParse<SubagentDiffStat | null>(row.diff_stat_json, null) : null,
    summary: row.summary,
    error: row.error,
    mergedAt: row.merged_at,
    mergedIntoBranch: row.merged_into_branch,
    worktreeCleaned: row.worktree_cleaned === 1,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
