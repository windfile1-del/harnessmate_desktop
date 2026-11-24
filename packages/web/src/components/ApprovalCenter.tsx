import type {
  ApprovalDecision,
  ApprovalRequest,
  CustomRiskRule,
  ResolveApprovalRequest,
  Session,
} from '@harnessmate/protocol';
import {
  AlertOctagon,
  Check,
  ChevronRight,
  HelpCircle,
  KeyRound,
  Lock,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import { Slot } from '../slots';
import { useAppStore } from '../stores/app-store';

const DECISION_LABELS: Record<string, string> = {
  allow_once: '允许本次',
  allow_session: '本会话信任',
  deny: '拒绝',
};

export function GlobalAttentionStrip({
  pendingRequests,
  sessions,
  selectedSessionId,
  onJumpToSession,
  onOpenRiskRules,
}: {
  pendingRequests: ApprovalRequest[];
  sessions: Session[];
  selectedSessionId: string | null;
  onJumpToSession: (sessionId: string) => void;
  onOpenRiskRules: () => void;
}) {
  const [queueOpen, setQueueOpen] = useState(false);

  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const approvalCount = pendingRequests.filter(
    (r) => r.kind !== 'user_question' && r.kind !== 'secret_request',
  ).length;
  const questionCount = pendingRequests.filter((r) => r.kind === 'user_question').length;
  const secretCount = pendingRequests.filter((r) => r.kind === 'secret_request').length;

  // Also include sessions whose pendingApprovalCount > 0 even if list not yet hydrated
  const backgroundSessions = sessions.filter(
    (s) =>
      s.id !== selectedSessionId &&
      (s.status === 'awaiting_approval' || s.pendingApprovalCount > 0),
  );

  if (pendingRequests.length === 0 && backgroundSessions.length === 0) return null;

  const summaryParts: string[] = [];
  if (approvalCount > 0) summaryParts.push(`${approvalCount} 个待审批`);
  if (questionCount > 0) summaryParts.push(`${questionCount} 个提问`);
  if (secretCount > 0) summaryParts.push(`${secretCount} 个凭据请求`);
  if (summaryParts.length === 0 && backgroundSessions.length > 0) {
    summaryParts.push(`${backgroundSessions.length} 个后台会话待确认`);
  }

  const hasCritical = pendingRequests.some((r) => r.riskLevel === 'critical');

  return (
    <div
      className="relative shrink-0 px-4 py-1.5 text-[11.5px]"
      style={{
        backgroundColor: hasCritical ? 'var(--accent-rose-soft)' : 'var(--accent-star-soft)',
        borderBottom: `1px solid color-mix(in srgb, ${hasCritical ? 'var(--accent-rose)' : 'var(--accent-star)'} 35%, transparent)`,
        color: hasCritical ? 'var(--accent-rose)' : 'var(--accent-star)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setQueueOpen((v) => !v)}
          className="inline-flex cursor-pointer items-center gap-2 text-left font-medium"
        >
          {hasCritical ? <AlertOctagon size={13.5} /> : <ShieldAlert size={13.5} />}
          <span>全局待处理队列：{summaryParts.join(' · ')}</span>
          <ChevronRight
            size={12.5}
            className={`transition-transform ${queueOpen ? 'rotate-90' : ''}`}
          />
        </button>

        <div className="flex items-center gap-2">
          {pendingRequests.some((r) => r.sessionId !== selectedSessionId) && (
            <button
              type="button"
              onClick={() => {
                const other = pendingRequests.find((r) => r.sessionId !== selectedSessionId);
                if (other) onJumpToSession(other.sessionId);
              }}
              className="cursor-pointer rounded-md px-2 py-0.5 font-medium underline"
            >
              跳转下一待决
            </button>
          )}
          <button
            type="button"
            onClick={onOpenRiskRules}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] hover:bg-black/10"
          >
            <Sliders size={11} />
            <span>风险规则</span>
          </button>
        </div>
      </div>

      {queueOpen && pendingRequests.length > 0 && (
        <div
          className="mt-2 space-y-1.5 rounded-xl p-2"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
          }}
        >
          {pendingRequests.map((req) => {
            const owner = sessionMap.get(req.sessionId);
            return (
              <button
                key={req.id}
                type="button"
                onClick={() => {
                  setQueueOpen(false);
                  onJumpToSession(req.sessionId);
                }}
                className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] hover:bg-[var(--bg-hover)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold">
                      {owner?.title ?? req.sessionId}
                    </span>
                    {req.parentSessionId && (
                      <span className="rounded bg-[var(--bg-elevated)] px-1 py-0.2 text-[10px] text-[var(--text-muted)]">
                        子任务
                      </span>
                    )}
                    <span className="font-mono-code text-[10px] uppercase text-[var(--text-muted)]">
                      {req.kind ?? 'command_approval'}
                    </span>
                  </div>
                  <p className="truncate font-mono-code text-[11px] text-[var(--text-secondary)]">
                    {req.summary}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--accent-indigo)]">前往 →</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Isolated secret_request password-masked input widget.
 * Strictly clears React state on unmount and never logs plaintext.
 */
export function SecretRequestInputCard({
  request,
  submitting,
  onSubmitSecret,
  onDeny,
}: {
  request: ApprovalRequest;
  submitting: boolean;
  onSubmitSecret: (secretValue: string) => void;
  onDeny: () => void;
}) {
  const [secretValue, setSecretValue] = useState('');

  useEffect(() => {
    return () => {
      setSecretValue('');
    };
  }, [request.id]);

  const handleSubmit = () => {
    if (!secretValue || submitting) return;
    const value = secretValue;
    setSecretValue('');
    onSubmitSecret(value);
  };

  return (
    <div className="mt-2.5 space-y-2.5">
      <div
        className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px]"
        style={{
          backgroundColor: 'var(--accent-indigo-soft)',
          color: 'var(--accent-indigo)',
        }}
      >
        <Lock size={12.5} className="shrink-0" />
        <span>
          私密凭据通道（noLog）：直达引擎内存，零落盘 SQLite、零写入日志、零在聊天时间线回显明文。
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && secretValue) handleSubmit();
          }}
          placeholder={request.secretSpec?.fieldLabel || '输入敏感令牌或密码（掩码显示）...'}
          className="min-w-0 flex-1 rounded-xl px-3 py-1.5 font-mono-code text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
          }}
        />
        <button
          type="button"
          disabled={submitting}
          onClick={onDeny}
          className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium"
          style={{
            color: 'var(--accent-rose)',
            border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
          }}
        >
          拒绝
        </button>
        <button
          type="button"
          disabled={!secretValue || submitting}
          onClick={handleSubmit}
          className="inline-flex cursor-pointer items-center gap-1 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          <KeyRound size={12.5} />
          <span>安全提交</span>
        </button>
      </div>
    </div>
  );
}

export function UserQuestionCard({
  request,
  submitting,
  onSubmitAnswer,
  onDeny,
}: {
  request: ApprovalRequest;
  submitting: boolean;
  onSubmitAnswer: (answer: { selectedOptionIds?: string[]; freeText?: string }) => void;
  onDeny: () => void;
}) {
  const spec = request.questionSpec;
  const selectionMode = spec?.selectionMode ?? 'single';
  const options = spec?.options ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');

  const toggleOption = (id: string) => {
    if (selectionMode === 'single') {
      setSelectedIds([id]);
    } else {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
      );
    }
  };

  const canSubmit = selectedIds.length > 0 || freeText.trim().length > 0;

  return (
    <div className="mt-2.5 space-y-2.5">
      {spec?.question && (
        <p className="text-[12.5px] font-medium text-[var(--text-primary)]">{spec.question}</p>
      )}
      {options.length > 0 && (
        <div className="space-y-1.5">
          {options.map((opt) => {
            const checked = selectedIds.includes(opt.id);
            return (
              <label
                key={opt.id}
                className="flex cursor-pointer items-start gap-2 rounded-xl px-2.5 py-2 text-[12px]"
                style={{
                  backgroundColor: checked ? 'var(--bg-active)' : 'var(--bg-elevated)',
                  border: `1px solid ${checked ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                }}
              >
                <input
                  type={selectionMode === 'multiple' ? 'checkbox' : 'radio'}
                  name={`uq-${request.id}`}
                  checked={checked}
                  onChange={() => toggleOption(opt.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <div className="font-medium text-[var(--text-primary)]">{opt.label}</div>
                  {opt.description && (
                    <div className="text-[11px] text-[var(--text-muted)]">{opt.description}</div>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}
      {(selectionMode === 'free_text' || spec?.allowFreeText || options.length === 0) && (
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder={spec?.placeholder || '输入回复或补充说明...'}
          className="w-full rounded-xl px-3 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
          }}
        />
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={onDeny}
          className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          跳过/取消
        </button>
        <button
          type="button"
          disabled={!canSubmit || submitting}
          onClick={() =>
            onSubmitAnswer({
              selectedOptionIds: selectedIds.length > 0 ? selectedIds : undefined,
              freeText: freeText.trim() || undefined,
            })
          }
          className="inline-flex cursor-pointer items-center gap-1 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          <Check size={13} />
          <span>提交回答</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Composer-Anchored Pending Request Action Bar (inspired by T3 Code `ComposerPendingApprovalActions`).
 * Honestly maps only driver-declared `supportedDecisions`, enforces double-confirm on `critical` risk,
 * and handles 409 Already Resolved gracefully without error popups.
 */
export function ComposerPendingRequestBar({
  session,
  pendingRequests,
  onResolve,
  onOpenRiskRules,
}: {
  session: Session;
  pendingRequests: ApprovalRequest[];
  onResolve: (requestId: string, req: ResolveApprovalRequest) => Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
  onOpenRiskRules?: () => void;
}) {
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [criticalConfirmedId, setCriticalConfirmedId] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  if (pendingRequests.length === 0 && !conflictNotice) return null;

  const active = pendingRequests[0];

  const handleDispatch = async (requestId: string, payload: ResolveApprovalRequest) => {
    setSubmittingId(requestId);
    try {
      const outcome = await onResolve(requestId, payload);
      if (outcome.conflict) {
        const who = outcome.resolvedBy === 'mobile' ? '移动端' : '其他客户端';
        setConflictNotice(`该请求已由${who}处理，已自动收起。`);
      }
      setCriticalConfirmedId(null);
    } finally {
      setSubmittingId(null);
    }
  };

  if (!active && conflictNotice) {
    return (
      <div
        role="status"
        className="mx-auto mb-2 flex max-w-[760px] items-center justify-between gap-2 rounded-xl px-3 py-2 text-[12px]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
          color: 'var(--text-secondary)',
        }}
      >
        <span>{conflictNotice}</span>
        <button
          type="button"
          onClick={() => setConflictNotice(null)}
          className="cursor-pointer rounded p-0.5 text-[var(--text-muted)]"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  if (!active) return null;

  const kind = active.kind ?? 'command_approval';
  const isCritical = active.riskLevel === 'critical';
  const isHigh = active.riskLevel === 'high';
  const isCriticalArmed = criticalConfirmedId === active.id;
  const supportedDecisions = (active.supportedDecisions?.length
    ? active.supportedDecisions
    : ['allow_once', 'allow_session', 'deny']
  ).filter((d): d is ApprovalDecision => d === 'allow_once' || d === 'allow_session' || d === 'deny');

  const borderColor = isCritical
    ? 'var(--accent-rose)'
    : isHigh
      ? 'var(--accent-star)'
      : kind === 'user_question' || kind === 'secret_request'
        ? 'var(--accent-indigo)'
        : 'var(--border-strong)';

  return (
    <div
      className="mx-auto mb-2.5 max-w-[760px] rounded-2xl p-3.5"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1.5px solid color-mix(in srgb, ${borderColor} 65%, transparent)`,
        boxShadow: 'var(--shadow-float)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {kind === 'user_question' ? (
            <HelpCircle size={16} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
          ) : kind === 'secret_request' ? (
            <KeyRound size={16} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
          ) : isCritical ? (
            <AlertOctagon size={16} className="mt-0.5 shrink-0 text-[var(--accent-rose)]" />
          ) : (
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[var(--accent-star)]" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {kind === 'user_question'
                  ? '引擎请求补充信息'
                  : kind === 'secret_request'
                    ? '私密凭据请求'
                    : isCritical
                      ? '高危操作确认 (CRITICAL)'
                      : '待审批操作'}
              </span>
              <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--text-secondary)]">
                {active.toolName}
              </span>
              {pendingRequests.length > 1 && (
                <span className="rounded-full bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent-star)]">
                  还有 {pendingRequests.length - 1} 项排队
                </span>
              )}
            </div>
            <p className="mt-1 break-all font-mono-code text-[12px] text-[var(--text-secondary)]">
              {active.summary}
            </p>
          </div>
        </div>
        {onOpenRiskRules && (
          <button
            type="button"
            onClick={onOpenRiskRules}
            title="管理高危命令风险规则"
            className="shrink-0 cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            <Sliders size={13} />
          </button>
        )}
      </div>

      {/* Risk Annotations (including degraded grey fallback) */}
      {(active.annotations?.length ?? 0) > 0 && (
        <div className="mt-2 space-y-1">
          {active.annotations!.map((note, idx) => (
            <div
              key={`${note.pluginId}:${idx}`}
              className="flex items-start gap-1.5 rounded-lg px-2.5 py-1 text-[11px]"
              style={{
                backgroundColor: note.degraded
                  ? 'var(--bg-elevated)'
                  : note.severity === 'critical' || note.risk === 'critical' || note.risk === 'high'
                    ? 'var(--accent-rose-soft)'
                    : note.risk === 'medium'
                      ? 'var(--accent-star-soft)'
                      : 'var(--bg-elevated)',
                color: note.degraded
                  ? 'var(--text-muted)'
                  : note.severity === 'critical' || note.risk === 'critical' || note.risk === 'high'
                    ? 'var(--accent-rose)'
                    : note.risk === 'medium'
                      ? 'var(--accent-star)'
                      : 'var(--text-secondary)',
              }}
            >
              <Shield size={11.5} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <span className="font-medium">{note.title || note.label}</span>
                {note.detail && <span className="ml-1.5 opacity-90">— {note.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <Slot name="approval.detail" slotProps={{ session, approval: active }} />

      {/* Interactive body by request kind */}
      {kind === 'secret_request' ? (
        <SecretRequestInputCard
          request={active}
          submitting={submittingId === active.id}
          onSubmitSecret={(secretValue) =>
            void handleDispatch(active.id, { secretValue, noLog: true, resolvedBy: 'desktop' })
          }
          onDeny={() =>
            void handleDispatch(active.id, { decision: 'deny', resolvedBy: 'desktop' })
          }
        />
      ) : kind === 'user_question' ? (
        <UserQuestionCard
          request={active}
          submitting={submittingId === active.id}
          onSubmitAnswer={(questionAnswer) =>
            void handleDispatch(active.id, { questionAnswer, resolvedBy: 'desktop' })
          }
          onDeny={() =>
            void handleDispatch(active.id, { decision: 'deny', resolvedBy: 'desktop' })
          }
        />
      ) : (
        <div className="mt-3 space-y-2">
          {isCritical && (
            <label
              className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11.5px]"
              style={{
                backgroundColor: 'var(--accent-rose-soft)',
                color: 'var(--accent-rose)',
              }}
            >
              <input
                type="checkbox"
                checked={isCriticalArmed}
                onChange={(e) => setCriticalConfirmedId(e.target.checked ? active.id : null)}
              />
              <span>高危操作禁止单键误触：我已审阅上述命令与风险说明，确认放行</span>
            </label>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {supportedDecisions.includes('deny') && (
              <button
                type="button"
                disabled={submittingId === active.id}
                onClick={() =>
                  void handleDispatch(active.id, { decision: 'deny', resolvedBy: 'desktop' })
                }
                className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium"
                style={{
                  color: 'var(--accent-rose)',
                  border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
                }}
              >
                {DECISION_LABELS.deny}
              </button>
            )}
            {supportedDecisions.includes('allow_session') && (
              <button
                type="button"
                disabled={submittingId === active.id || (isCritical && !isCriticalArmed)}
                onClick={() =>
                  void handleDispatch(active.id, { decision: 'allow_session', resolvedBy: 'desktop' })
                }
                className="cursor-pointer rounded-xl px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                {DECISION_LABELS.allow_session}
              </button>
            )}
            {supportedDecisions.includes('allow_once') && (
              <button
                type="button"
                disabled={submittingId === active.id || (isCritical && !isCriticalArmed)}
                onClick={() =>
                  void handleDispatch(active.id, { decision: 'allow_once', resolvedBy: 'desktop' })
                }
                className="inline-flex cursor-pointer items-center gap-1 rounded-xl px-3.5 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                style={{ backgroundColor: isCritical ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}
              >
                <Check size={13} />
                <span>{DECISION_LABELS.allow_once}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Historical read-only receipt block rendered via `chat.block` (key: `runtime_request`).
 * Never displays secret_request plaintext.
 */
export function RuntimeRequestReceiptBlock({
  kind,
  title,
  receiptText,
  requestStatus,
  resolvedBy,
}: {
  kind: string;
  title: string;
  receiptText: string;
  requestStatus: string;
  resolvedBy?: string | null;
}) {
  const safeText = kind === 'secret_request' ? '已安全提供凭据（内容已隐藏）' : receiptText;
  const isDenied = requestStatus === 'denied' || requestStatus === 'cancelled' || requestStatus === 'expired';
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl px-3 py-2 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      {kind === 'secret_request' ? (
        <Lock size={14} className="mt-0.5 shrink-0 text-[var(--accent-indigo)]" />
      ) : (
        <ShieldCheck
          size={14}
          className="mt-0.5 shrink-0"
          style={{ color: isDenied ? 'var(--accent-rose)' : 'var(--accent-emerald)' }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-[var(--text-primary)]">{title}</span>
          {resolvedBy && (
            <span className="text-[10.5px] text-[var(--text-muted)]">
              · {resolvedBy === 'mobile' ? '移动端' : '桌面端'}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">{safeText}</p>
      </div>
    </div>
  );
}

export function RiskRulesModal({ onClose }: { onClose: () => void }) {
  const { pushToast } = useAppStore();
  const [rules, setRules] = useState<CustomRiskRule[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [severity, setSeverity] = useState<CustomRiskRule['severity']>('high');
  const [target, setTarget] = useState<CustomRiskRule['target']>('command');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void daemonApi
      .listRiskRules()
      .then((res) => setRules(res.rules))
      .catch(() => {});
  }, []);

  const handleAdd = async () => {
    if (!name.trim() || !pattern.trim() || !reason.trim()) return;
    setSaving(true);
    try {
      const res = await daemonApi.addRiskRule({
        name: name.trim(),
        pattern: pattern.trim(),
        severity,
        target,
        reason: reason.trim(),
        enabled: true,
      });
      setRules(res.rules);
      setName('');
      setPattern('');
      setReason('');
      pushToast({ kind: 'success', title: '已添加自定义风险规则' });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '添加规则失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-h-[82vh] flex-col">
      <div
        className="flex items-start justify-between gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        <div>
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
            <ShieldAlert size={16} className="text-[var(--accent-rose)]" />
            <span>审批高危命令风险规则编辑器</span>
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            基于 V4 approval.annotate 静态扫描命令、越界写入与 MCP 调用；仅提供只读风险标注，绝不自动批准
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {/* Add Custom Rule Form */}
        <div className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
          <div className="text-[12px] font-semibold text-[var(--text-primary)]">新增自定义正则规则</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="规则名称（如：禁止操作生产集群）"
              className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
            />
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="正则表达式（如：kubectl\\s+delete\\s+-n\\s+prod）"
              className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-code text-[12px] text-[var(--text-primary)]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as CustomRiskRule['severity'])}
              className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
            >
              <option value="critical">critical（强制二次确认）</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="info">info</option>
            </select>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as CustomRiskRule['target'])}
              className="rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
            >
              <option value="command">Shell 命令</option>
              <option value="file_path">文件路径</option>
              <option value="mcp">MCP 工具</option>
              <option value="any">全部载荷</option>
            </select>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="可读风险说明..."
              className="min-w-[180px] flex-1 rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
            />
            <button
              type="button"
              disabled={saving || !name.trim() || !pattern.trim() || !reason.trim()}
              onClick={() => void handleAdd()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              <Plus size={13} />
              <span>添加</span>
            </button>
          </div>
        </div>

        {/* Rules List */}
        <div className="space-y-1.5">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-start justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2.5 text-[12px]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-[var(--text-primary)]">{rule.name}</span>
                  <span
                    className="rounded px-1.5 py-0.5 font-mono-code text-[10px] uppercase"
                    style={{
                      backgroundColor:
                        rule.severity === 'critical'
                          ? 'var(--accent-rose-soft)'
                          : rule.severity === 'high'
                            ? 'var(--accent-star-soft)'
                            : 'var(--bg-surface)',
                      color:
                        rule.severity === 'critical'
                          ? 'var(--accent-rose)'
                          : rule.severity === 'high'
                            ? 'var(--accent-star)'
                            : 'var(--text-secondary)',
                    }}
                  >
                    {rule.severity}
                  </span>
                  <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                    {rule.builtin ? '内置' : '自定义'}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono-code text-[10.5px] text-[var(--text-muted)]">
                  /{rule.pattern}/i
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{rule.reason}</div>
              </div>
              {!rule.builtin && (
                <button
                  type="button"
                  onClick={async () => {
                    const res = await daemonApi.deleteRiskRule(rule.id);
                    setRules(res.rules);
                  }}
                  className="shrink-0 cursor-pointer rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent-rose)]"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
