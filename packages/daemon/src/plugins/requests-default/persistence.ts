import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalRequest, ApprovalDecision, ApprovalStatus, ApprovalAnnotationDto, RiskLevel, RuntimeRequestKind, UserQuestionSpec, UserQuestionAnswer, SecretRequestSpec, ToolKind } from '@harnessmate/protocol';
function safeJsonParse<T>(input: string | null, fallback: T): T { try { return input ? JSON.parse(input) : fallback; } catch { return fallback; } }
interface ApprovalRow {
  id: string;
  session_id: string;
  parent_session_id?: string | null;
  instance_id?: string | null;
  native_request_id: string;
  kind?: string | null;
  tool_name: string;
  tool_kind: string;
  summary: string;
  input_json: string;
  diff_preview: string | null;
  risk_level: string;
  supported_decisions_json?: string | null;
  question_spec_json?: string | null;
  question_answer_json?: string | null;
  secret_spec_json?: string | null;
  secret_provided?: number | null;
  status: string;
  resolved_by: string | null;
  decision: string | null;
  comment: string | null;
  annotations_json?: string | null;
  created_at: number;
  resolved_at: number | null;
}

export function initializeApprovalSchema(db: DatabaseSync) {
  db.exec(`      CREATE TABLE IF NOT EXISTS approvals (
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

`);
    const approvalCols = new Set((db.prepare('PRAGMA table_info(approvals)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
    if (!approvalCols.has('annotations_json')) {
      db.exec('ALTER TABLE approvals ADD COLUMN annotations_json TEXT;');
    }
    if (!approvalCols.has('kind')) {
      db.exec("ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'command_approval';");
    }
    if (!approvalCols.has('parent_session_id')) {
      db.exec('ALTER TABLE approvals ADD COLUMN parent_session_id TEXT;');
    }
    if (!approvalCols.has('instance_id')) {
      db.exec('ALTER TABLE approvals ADD COLUMN instance_id TEXT;');
    }
    if (!approvalCols.has('supported_decisions_json')) {
      db.exec('ALTER TABLE approvals ADD COLUMN supported_decisions_json TEXT;');
    }
    if (!approvalCols.has('question_spec_json')) {
      db.exec('ALTER TABLE approvals ADD COLUMN question_spec_json TEXT;');
    }
    if (!approvalCols.has('question_answer_json')) {
      db.exec('ALTER TABLE approvals ADD COLUMN question_answer_json TEXT;');
    }
    if (!approvalCols.has('secret_spec_json')) {
      db.exec('ALTER TABLE approvals ADD COLUMN secret_spec_json TEXT;');
    }
    if (!approvalCols.has('secret_provided')) {
      db.exec('ALTER TABLE approvals ADD COLUMN secret_provided INTEGER NOT NULL DEFAULT 0;');
    }
}
export class ApprovalRepository {
  constructor(private db: DatabaseSync) {}
  createApproval(req: ApprovalRequest): ApprovalRequest {
    this.db
      .prepare(
        `INSERT INTO approvals (
          id, session_id, parent_session_id, instance_id, native_request_id, kind,
          tool_name, tool_kind, summary, input_json, diff_preview, risk_level,
          supported_decisions_json, question_spec_json, question_answer_json,
          secret_spec_json, secret_provided, status, resolved_by, decision, comment,
          annotations_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.sessionId,
        req.parentSessionId ?? null,
        req.instanceId ?? null,
        req.nativeRequestId,
        req.kind ?? 'command_approval',
        req.toolName,
        req.toolKind,
        req.summary,
        JSON.stringify(req.input ?? {}),
        req.diffPreview ?? null,
        req.riskLevel,
        req.supportedDecisions ? JSON.stringify(req.supportedDecisions) : null,
        req.questionSpec ? JSON.stringify(req.questionSpec) : null,
        req.questionAnswer ? JSON.stringify(req.questionAnswer) : null,
        req.secretSpec ? JSON.stringify(req.secretSpec) : null,
        req.secretProvided ? 1 : 0,
        req.status,
        req.resolvedBy ?? null,
        req.decision ?? null,
        req.comment ?? null,
        req.annotations ? JSON.stringify(req.annotations) : null,
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

  listApprovals(filter?: { sessionId?: string; status?: ApprovalStatus; limit?: number }): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, filter?.limit ?? 100));
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as unknown as ApprovalRow[];
    return rows.map(mapApproval);
  }

  addApprovalAnnotation(
    approvalId: string,
    annotation: ApprovalAnnotationDto,
  ): ApprovalRequest | null {
    const existing = this.getApproval(approvalId);
    if (!existing) return null;
    const current = existing.annotations ?? [];
    const next = [...current.filter((item) => item.pluginId !== annotation.pluginId || item.label !== annotation.label), annotation].slice(0, 24);
    this.db.prepare('UPDATE approvals SET annotations_json = ? WHERE id = ?')
      .run(JSON.stringify(next), approvalId);
    return this.getApproval(approvalId);
  }

  setApprovalAnnotationsAndRisk(
    approvalId: string,
    annotations: ApprovalAnnotationDto[],
    riskLevel?: RiskLevel,
  ): ApprovalRequest | null {
    const existing = this.getApproval(approvalId);
    if (!existing) return null;
    if (riskLevel) {
      this.db
        .prepare('UPDATE approvals SET annotations_json = ?, risk_level = ? WHERE id = ?')
        .run(JSON.stringify(annotations.slice(0, 24)), riskLevel, approvalId);
    } else {
      this.db
        .prepare('UPDATE approvals SET annotations_json = ? WHERE id = ?')
        .run(JSON.stringify(annotations.slice(0, 24)), approvalId);
    }
    return this.getApproval(approvalId);
  }

  resolveApprovalIfPending(
    id: string,
    decision: ApprovalDecision | null,
    resolvedBy: 'desktop' | 'mobile' | 'auto',
    comment?: string,
    opts?: {
      statusOverride?: ApprovalStatus;
      questionAnswer?: UserQuestionAnswer | null;
      secretProvided?: boolean;
    },
  ): { updated: boolean; approval: ApprovalRequest | null } {
    const now = Date.now();
    const status: ApprovalStatus =
      opts?.statusOverride ?? (decision === 'deny' ? 'denied' : 'approved');
    const res = this.db
      .prepare(
        `UPDATE approvals
         SET status = ?,
             resolved_by = ?,
             decision = ?,
             comment = ?,
             question_answer_json = COALESCE(?, question_answer_json),
             secret_provided = CASE WHEN ? = 1 THEN 1 ELSE secret_provided END,
             resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        resolvedBy,
        decision ?? null,
        comment ?? null,
        opts?.questionAnswer ? JSON.stringify(opts.questionAnswer) : null,
        opts?.secretProvided ? 1 : 0,
        now,
        id,
      );
    return {
      updated: Number(res.changes) === 1,
      approval: this.getApproval(id),
    };
  }

  cancelPendingApprovals(sessionId?: string): ApprovalRequest[] {
    const pending = this.listPendingApprovals(sessionId);
    if (pending.length === 0) return [];
    const now = Date.now();
    if (sessionId) {
      this.db
        .prepare("UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE session_id = ? AND status = 'pending'")
        .run(now, sessionId);
    } else {
      this.db
        .prepare("UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE status = 'pending'")
        .run(now);
    }
    return pending.map((item) => ({ ...item, status: 'cancelled' as const, resolvedAt: now }));
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

}
function mapApproval(row: ApprovalRow): ApprovalRequest {
  const annotations = safeJsonParse<ApprovalRequest['annotations']>(row.annotations_json ?? null, undefined);
  const supportedDecisions = safeJsonParse<string[] | undefined>(row.supported_decisions_json ?? null, undefined);
  const questionSpec = safeJsonParse<UserQuestionSpec | null>(row.question_spec_json ?? null, null);
  const questionAnswer = safeJsonParse<UserQuestionAnswer | null>(row.question_answer_json ?? null, null);
  const secretSpec = safeJsonParse<SecretRequestSpec | null>(row.secret_spec_json ?? null, null);
  const inferredKind: RuntimeRequestKind =
    (row.kind as RuntimeRequestKind) ||
    (row.tool_kind === 'file_edit'
      ? 'file_change_approval'
      : row.tool_kind === 'mcp'
        ? 'mcp_tool_approval'
        : 'command_approval');
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.instance_id ? { instanceId: row.instance_id } : {}),
    nativeRequestId: row.native_request_id,
    kind: inferredKind,
    toolName: row.tool_name,
    toolKind: row.tool_kind as ToolKind,
    summary: row.summary,
    input: safeJsonParse<unknown>(row.input_json, {}),
    diffPreview: row.diff_preview,
    riskLevel: row.risk_level as RiskLevel,
    ...(supportedDecisions?.length ? { supportedDecisions } : {}),
    ...(questionSpec ? { questionSpec } : {}),
    ...(questionAnswer ? { questionAnswer } : {}),
    ...(secretSpec ? { secretSpec } : {}),
    ...(row.secret_provided === 1 ? { secretProvided: true } : {}),
    status: row.status as ApprovalStatus,
    resolvedBy: row.resolved_by as 'desktop' | 'mobile' | 'auto' | null,
    decision: row.decision as ApprovalDecision | null,
    comment: row.comment,
    ...(annotations?.length ? { annotations } : {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
