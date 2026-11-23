import { DatabaseSync } from 'node:sqlite';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  CanonicalEvent,
  CanonicalEventType,
  ContextInjectionDriver,
  ContextSyncMode,
  DiscoveredCliSession,
  HarnessKind,
  PairedDevice,
  PluginPanelQuery,
  PluginProjection,
  PluginTurnRow,
  PermissionMode,
  ReasoningEffort,
  RiskLevel,
  Session,
  SessionHarnessBinding,
  SessionStatus,
  SessionTaskState,
  TaskStep,
  TaskVerification,
  TokenUsage,
  ToolKind,
  Workspace,
} from '@harnessmate/protocol';

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

interface ApprovalRow {
  id: string;
  session_id: string;
  native_request_id: string;
  tool_name: string;
  tool_kind: string;
  summary: string;
  input_json: string;
  diff_preview: string | null;
  risk_level: string;
  status: string;
  resolved_by: string | null;
  decision: string | null;
  comment: string | null;
  annotations_json?: string | null;
  created_at: number;
  resolved_at: number | null;
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

export interface LocalHarnessUsageAggregate {
  harnessId: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export class HarnessMateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
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
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        native_request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_kind TEXT NOT NULL DEFAULT 'other',
        summary TEXT NOT NULL,
        input_json TEXT NOT NULL,
        diff_preview TEXT,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_by TEXT,
        decision TEXT,
        comment TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_session_status
        ON approvals(session_id, status);

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
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        objective TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[]',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        touched_files_json TEXT NOT NULL DEFAULT '[]',
        verifications_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        pinned_facts_json TEXT NOT NULL DEFAULT '[]',
        rolling_summary TEXT NOT NULL DEFAULT '',
        summarized_up_to_seq INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        ledger_file_path TEXT,
        updated_at INTEGER NOT NULL
      );
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

    const permCols = new Set((this.db.prepare('PRAGMA table_info(plugin_permissions)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!permCols.has('cover_future')) {
      this.db.exec('ALTER TABLE plugin_permissions ADD COLUMN cover_future INTEGER NOT NULL DEFAULT 0;');
    }
    if (!permCols.has('declared_permissions_json')) {
      this.db.exec('ALTER TABLE plugin_permissions ADD COLUMN declared_permissions_json TEXT;');
    }
    const approvalCols = new Set((this.db.prepare('PRAGMA table_info(approvals)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!approvalCols.has('annotations_json')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN annotations_json TEXT;');
    }

    // Idempotent backfill for existing v0.1/v0.2 sessions -> unified multi-harness bindings + task ledger
    this.backfillLegacySessions();
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

  close(): void {
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
    const res = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return Number(res.changes) > 0;
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
    const participating =
      session.participatingHarnesses && session.participatingHarnesses.length > 0
        ? session.participatingHarnesses
        : [session.harnessId];
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, workspace_id, harness_id, harness_kind, native_session_id,
          participating_harnesses_json, context_sync_mode,
          cwd, worktree_branch,
          title, status, model, actual_model, model_rerouted_reason, reasoning_effort, permission_mode,
          last_seq, usage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceId,
        session.harnessId,
        session.harnessKind,
        session.nativeSessionId,
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

    return this.getSession(session.id)!;
  }

  getImportedSession(
    source: NonNullable<DiscoveredCliSession['source']>, nativeSessionId: string,
  ): Session | null {
    const row = this.db.prepare(
      'SELECT session_id FROM native_history_imports WHERE source = ? AND native_session_id = ?',
    ).get(source, nativeSessionId);
    return typeof row?.session_id === 'string' ? this.getSession(row.session_id) : null;
  }

  getNativeHistory(sessionId: string, nativeSessionId: string): {
    source: DiscoveredCliSession['source']; sourcePath?: string;
  } | undefined {
    const row = this.db.prepare(
      'SELECT source, source_path FROM native_history_imports WHERE session_id = ? AND native_session_id = ?',
    ).get(sessionId, nativeSessionId);
    if (!row) return undefined;
    return { source: row.source as DiscoveredCliSession['source'],
      sourcePath: typeof row.source_path === 'string' ? row.source_path : undefined };
  }

  importSession(
    session: Session,
    source: NonNullable<DiscoveredCliSession['source']>,
    sourcePath: string | undefined,
    events: Array<Omit<CanonicalEvent, 'sessionId' | 'seq'>>,
  ): Session {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getImportedSession(source, session.nativeSessionId!);
      if (existing) {
        this.db.exec('COMMIT');
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
      this.db.exec('COMMIT');
      return imported;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

    sets.push('updated_at = ?');
    params.push(patch.updatedAt ?? Date.now());
    params.push(id);

    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    const res = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(res.changes) > 0;
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

  // ── Canonical Events ─────────────────────────────────────────────────

  appendEvent(
    sessionId: string,
    type: CanonicalEventType,
    payload: Record<string, unknown>,
    turnId: string | null = null,
    createdAt: number = Date.now(),
  ): CanonicalEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
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
      this.db.exec('COMMIT');

      return {
        sessionId,
        seq: nextSeq,
        type,
        turnId,
        createdAt,
        payload,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  *iterateEvents(sessionId: string, afterSeq = 0, upToSeq = Number.MAX_SAFE_INTEGER): Generator<CanonicalEvent> {
    const pageSize = 1000;
    while (afterSeq < upToSeq) {
      const page = this.getEventsInRange(sessionId, afterSeq, upToSeq, pageSize);
      yield* page;
      if (page.length < pageSize) return;
      afterSeq = page.at(-1)!.seq;
    }
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
          verifications_json, blockers_json, pinned_facts_json,
          rolling_summary, summarized_up_to_seq, version, ledger_file_path, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          objective = excluded.objective,
          steps_json = excluded.steps_json,
          decisions_json = excluded.decisions_json,
          touched_files_json = excluded.touched_files_json,
          verifications_json = excluded.verifications_json,
          blockers_json = excluded.blockers_json,
          pinned_facts_json = excluded.pinned_facts_json,
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
        state.rollingSummary ?? '',
        state.summarizedUpToSeq ?? 0,
        state.version ?? 1,
        state.ledgerFilePath ?? null,
        state.updatedAt ?? Date.now(),
      );
    return this.getTaskState(state.sessionId)!;
  }

  // ── Approvals ────────────────────────────────────────────────────────

  createApproval(req: ApprovalRequest): ApprovalRequest {
    this.db
      .prepare(
        `INSERT INTO approvals (
          id, session_id, native_request_id, tool_name, tool_kind, summary, input_json,
          diff_preview, risk_level, status, resolved_by, decision, comment, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.sessionId,
        req.nativeRequestId,
        req.toolName,
        req.toolKind,
        req.summary,
        JSON.stringify(req.input ?? {}),
        req.diffPreview ?? null,
        req.riskLevel,
        req.status,
        req.resolvedBy ?? null,
        req.decision ?? null,
        req.comment ?? null,
        req.createdAt,
        req.resolvedAt ?? null,
      );
    return req;
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE id = ?')
      .get(id) as unknown as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  listPendingApprovals(sessionId?: string): ApprovalRequest[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
          )
          .all(sessionId) as unknown as ApprovalRow[])
      : (this.db
          .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
          .all() as unknown as ApprovalRow[]);
    return rows.map(mapApproval);
  }

  addApprovalAnnotation(
    approvalId: string,
    annotation: { pluginId: string; risk?: RiskLevel; label: string; detail?: string },
  ): ApprovalRequest | null {
    const existing = this.getApproval(approvalId);
    if (!existing) return null;
    const current = existing.annotations ?? [];
    const next = [...current.filter((item) => item.pluginId !== annotation.pluginId || item.label !== annotation.label), annotation].slice(0, 16);
    this.db.prepare('UPDATE approvals SET annotations_json = ? WHERE id = ?')
      .run(JSON.stringify(next), approvalId);
    return this.getApproval(approvalId);
  }

  resolveApprovalIfPending(
    id: string,
    decision: ApprovalDecision,
    resolvedBy: 'desktop' | 'mobile' | 'auto',
    comment?: string,
  ): { updated: boolean; approval: ApprovalRequest | null } {
    const now = Date.now();
    const status: ApprovalStatus = decision === 'deny' ? 'denied' : 'approved';
    const res = this.db
      .prepare(
        `UPDATE approvals
         SET status = ?, resolved_by = ?, decision = ?, comment = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, resolvedBy, decision, comment ?? null, now, id);
    return {
      updated: Number(res.changes) === 1,
      approval: this.getApproval(id),
    };
  }

  expirePendingApprovals(sessionId?: string): number {
    const now = Date.now();
    const res = sessionId
      ? this.db
          .prepare(
            "UPDATE approvals SET status = 'expired', resolved_at = ? WHERE session_id = ? AND status = 'pending'",
          )
          .run(now, sessionId)
      : this.db
          .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'")
          .run(now);
    return Number(res.changes);
  }

  expireApprovalIfPending(id: string): boolean {
    return Number(this.db.prepare(
      "UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).run(Date.now(), id).changes) === 1;
  }

  listUnpublishedExpiredApprovals(): ApprovalRequest[] {
    const rows = this.db.prepare(`SELECT a.* FROM approvals a
      WHERE a.status = 'expired' AND NOT EXISTS (
        SELECT 1 FROM session_events e WHERE e.session_id = a.session_id
        AND e.type = 'approval.resolved' AND json_extract(e.payload_json, '$.approvalId') = a.id
      )`).all() as unknown as ApprovalRow[];
    return rows.map(mapApproval);
  }

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
  return {
    sessionId: row.session_id,
    objective: row.objective ?? '',
    steps: safeJsonParse<TaskStep[]>(row.steps_json, []),
    decisions: safeJsonParse<string[]>(row.decisions_json, []),
    touchedFiles: safeJsonParse<string[]>(row.touched_files_json, []),
    verifications: safeJsonParse<TaskVerification[]>(row.verifications_json, []),
    blockers: safeJsonParse<string[]>(row.blockers_json, []),
    pinnedFacts: safeJsonParse<string[]>(row.pinned_facts_json, []),
    rollingSummary: row.rolling_summary ?? '',
    summarizedUpToSeq: row.summarized_up_to_seq ?? 0,
    version: row.version ?? 1,
    ledgerFilePath: row.ledger_file_path ?? null,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRequest {
  const annotations = safeJsonParse<ApprovalRequest['annotations']>(row.annotations_json ?? null, undefined);
  return {
    id: row.id,
    sessionId: row.session_id,
    nativeRequestId: row.native_request_id,
    toolName: row.tool_name,
    toolKind: row.tool_kind as ToolKind,
    summary: row.summary,
    input: safeJsonParse<unknown>(row.input_json, {}),
    diffPreview: row.diff_preview,
    riskLevel: row.risk_level as RiskLevel,
    status: row.status as ApprovalStatus,
    resolvedBy: row.resolved_by as 'desktop' | 'mobile' | 'auto' | null,
    decision: row.decision as ApprovalDecision | null,
    comment: row.comment,
    ...(annotations?.length ? { annotations } : {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
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
