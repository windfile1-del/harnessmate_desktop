import type { ResolveApprovalRequest } from '@harnessmate/protocol';
import { ArrowUpRight, Bot, CheckCircle2, Eye, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import type {
  CapabilityDescriptor,
  NativeAgentId,
  NativeRuntimeProjection,
} from '../../../../lib/native-client';
import {
  CapabilityUnavailable,
  EMPTY_STATE_COPY,
  EVIDENCE_SOURCE_LABELS,
  EntityStatusBadge,
  EvidenceDetails,
  NativeControlMenu,
  NativeRequestCard,
  type NativeWorkbenchViewProps,
} from '../shared';
import {
  resolveSafeSwarmControlCapability,
  type SwarmStudioViewModel,
  type SwarmWorkerViewRow,
} from './swarm-view-model';

export interface SwarmWorkersPanelProps {
  projection: NativeRuntimeProjection;
  model: SwarmStudioViewModel;
  capabilities: readonly CapabilityDescriptor[];
  selectedAgentId?: NativeAgentId | null;
  onSelectAgent: (agentId: NativeAgentId) => void;
  onJumpToSubagent: (agentId: NativeAgentId) => void;
  onResolveRequest: (
    approvalId: string,
    req: ResolveApprovalRequest,
  ) => Promise<{ conflict?: boolean; resolvedBy?: string | null }>;
  onDispatchControl?: NativeWorkbenchViewProps['onDispatchControl'];
}

/**
 * NP-08 Swarm Workers & Verifiers Panel.
 *
 * Rules enforced:
 * - Workers are ONLY derived from verified native IDs in `workflow.detail.workerIds`;
 *   NEVER fabricated from tool titles.
 * - `idle` workers are explicitly labeled "空闲（可再唤醒）" and NEVER counted as succeeded progress.
 * - Confirmed worker identities allow linking/resolving their scoped approvals and jumping to their
 *   independent subagent timeline without moving native context.
 * - Controls remain strictly disabled when member identity is unconfirmed, snapshot-only, or upstream-limited.
 */
export function SwarmWorkersPanel({
  projection,
  model,
  capabilities,
  selectedAgentId,
  onSelectAgent,
  onJumpToSubagent,
  onResolveRequest,
  onDispatchControl,
}: SwarmWorkersPanelProps) {
  const allRows: SwarmWorkerViewRow[] = [
    ...(model.coordinator ? [model.coordinator] : []),
    ...model.workers,
    ...model.verifiers,
    ...model.unconfirmedMembers,
  ];
  const selectedRow =
    allRows.find((r) => r.agent.id === selectedAgentId) ??
    model.workers[0] ??
    model.verifiers[0] ??
    model.coordinator ??
    model.unconfirmedMembers[0] ??
    null;

  const safeControl = selectedRow
    ? resolveSafeSwarmControlCapability({
        runtimeStatus: projection.status,
        targetConfirmed: selectedRow.isConfirmed,
        targetEvidence: selectedRow.provenance,
        capabilities,
        targetKind: 'agent',
      })
    : { capability: null };

  const renderMemberRow = (row: SwarmWorkerViewRow) => {
    const isSelected = selectedRow?.agent.id === row.agent.id;
    const roleBadge =
      row.memberRole === 'coordinator'
        ? 'Coordinator'
        : row.memberRole === 'verifier'
          ? 'Verifier'
          : 'Worker';

    return (
      <button
        key={row.agent.id}
        type="button"
        data-testid="np08-worker-row"
        data-agent-id={row.agent.id}
        data-member-role={row.memberRole}
        data-lineage={row.agent.lineage}
        aria-pressed={isSelected}
        onClick={() => onSelectAgent(row.agent.id)}
        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border p-2.5 text-left text-[11.5px] transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          backgroundColor: isSelected ? 'var(--bg-active)' : 'var(--bg-surface)',
          borderColor: isSelected ? 'var(--border-focus)' : 'var(--border-hairline)',
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {row.memberRole === 'verifier' ? (
              <ShieldCheck size={12.5} className="shrink-0 text-[var(--accent-emerald)]" aria-hidden="true" />
            ) : row.memberRole === 'coordinator' ? (
              <Users size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
            ) : (
              <Bot size={12.5} className="shrink-0 text-[var(--accent-indigo)]" aria-hidden="true" />
            )}
            <span className="truncate font-medium text-[var(--text-primary)]">{row.displayName}</span>
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px] font-medium text-[var(--text-secondary)]">
              {roleBadge}
            </span>
            <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
              {row.agent.id}
            </span>
            {row.isReadOnlySnapshotOnly && (
              <span className="inline-flex items-center gap-0.5 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9.5px] text-[var(--text-muted)]">
                <Eye size={9.5} aria-hidden="true" />
                <span>只读</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
            <span>
              来源：{row.provenance ? EVIDENCE_SOURCE_LABELS[row.provenance.sourceKind] : '未确认'}
            </span>
            {row.isIdle && <span>空闲不等同于成功进度</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <EntityStatusBadge kind="lineage" lineage={row.agent.lineage} compact />
          <EntityStatusBadge kind="foreground" observed={row.agent.foreground} compact />
          {row.agent.status && <EntityStatusBadge kind="work" observed={row.agent.status} compact />}
          {row.pendingApprovals.length > 0 && (
            <span
              data-testid="np08-worker-approval-badge"
              className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-star-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-star)]"
            >
              <ShieldAlert size={10} aria-hidden="true" />
              <span>{row.pendingApprovals.length} 审批</span>
            </span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-3" data-testid="np08-workers-panel">
      {/* Honest Worker Invariant Notice */}
      <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
        仅展示同作用域且具有已证实原生 ID 的 Coordinator、Workers 与 Verifiers；不从工具标题生成 Worker，空闲 (idle) 状态不计入成功进度。
      </div>

      {/* Coordinator Section */}
      {model.coordinator && (
        <section className="space-y-1.5" aria-label="Swarm Coordinator">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Coordinator (1)
          </h4>
          {renderMemberRow(model.coordinator)}
        </section>
      )}

      {/* Confirmed Workers */}
      <section className="space-y-1.5" aria-label="已证实 Workers">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          已证实 Workers ({model.workers.length})
        </h4>
        {model.workers.length === 0 ? (
          <div
            data-testid="np08-workers-empty"
            className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-[11.5px] text-[var(--text-muted)]"
          >
            <div>{EMPTY_STATE_COPY.noActivityObserved}</div>
            <p className="mt-0.5 text-[10.5px]">
              尚未观察到具有已证实原生身份的 Worker（不会依据工具调用标题伪造 Worker）。
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">{model.workers.map(renderMemberRow)}</div>
        )}
      </section>

      {/* Confirmed Verifiers */}
      <section className="space-y-1.5" aria-label="已证实 Verifiers">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          已证实 Verifiers ({model.verifiers.length})
        </h4>
        {model.verifiers.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 text-[11px] text-[var(--text-muted)]">
            尚未观察到已证实的 Verifier 成员。
          </div>
        ) : (
          <div className="space-y-1.5">{model.verifiers.map(renderMemberRow)}</div>
        )}
      </section>

      {/* Unconfirmed Candidates */}
      {model.unconfirmedMembers.length > 0 && (
        <section className="space-y-1.5" aria-label="身份待确认成员">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-clay)]">
            身份待确认 ({model.unconfirmedMembers.length})
          </h4>
          <div className="space-y-1.5">{model.unconfirmedMembers.map(renderMemberRow)}</div>
        </section>
      )}

      {/* Selected Worker Inspector */}
      {selectedRow && (
        <div
          data-testid="np08-worker-detail"
          className="space-y-2.5 rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] pb-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {selectedRow.displayName}
                </span>
                <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                  {selectedRow.agent.id}
                </span>
              </div>
              {selectedRow.isFinished && (
                <p className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                  <CheckCircle2 size={11} className="text-[var(--accent-emerald)]" aria-hidden="true" />
                  <span>运行已结束（具体成功与否以独立原生结果为准）</span>
                </p>
              )}
            </div>

            {selectedRow.isConfirmed && (
              <button
                type="button"
                data-testid="np08-jump-worker-subagent"
                onClick={() => onJumpToSubagent(selectedRow.agent.id)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
              >
                <span>查看独立输出与时间线</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </button>
            )}
          </div>

          {!selectedRow.isConfirmed && (
            <CapabilityUnavailable
              title="成员身份待确认 · 仅只读诊断"
              gate="unknown"
              capabilityId="AGY-W04"
              reason="该成员尚未获得协议或快照确证的原生身份；已禁用子审批链接、输出跳转与原生控制。"
            />
          )}

          {/* Scoped Approvals linked to confirmed Worker (without moving native context) */}
          {selectedRow.isConfirmed && selectedRow.pendingApprovals.length > 0 && (
            <section className="space-y-2" aria-label="该成员待处理审批">
              <h5 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-star)]">
                已链接的子审批 ({selectedRow.pendingApprovals.length})
              </h5>
              {selectedRow.pendingApprovals.map((appr) => (
                <NativeRequestCard
                  key={appr.id}
                  approval={appr}
                  receipt={projection.receipts?.[appr.id] ?? null}
                  ownerAgent={selectedRow.agent}
                  onResolve={onResolveRequest}
                  onJumpToAgent={onJumpToSubagent}
                />
              ))}
            </section>
          )}

          {/* Strictly Gated Native Control Menu */}
          <div className="space-y-1">
            <NativeControlMenu
              target={{ type: 'agent', id: selectedRow.agent.id }}
              targetLabel={selectedRow.displayName}
              expectedRevision={selectedRow.agent.revision}
              binding={projection.binding}
              capability={safeControl.capability}
              disabled={!safeControl.capability}
              onDispatchControl={safeControl.capability ? onDispatchControl : undefined}
            />
            {safeControl.blockReason && (
              <p
                data-testid="np08-worker-control-guard"
                className="text-[10.5px] text-[var(--text-muted)]"
              >
                控制门控：{safeControl.blockReason}
              </p>
            )}
          </div>

          <EvidenceDetails
            evidence={selectedRow.provenance}
            reasonCode={
              selectedRow.agent.foreground.kind !== 'known'
                ? selectedRow.agent.foreground.reasonCode
                : undefined
            }
            label={`成员 ${selectedRow.displayName} 观测证据`}
          />
        </div>
      )}
    </div>
  );
}
