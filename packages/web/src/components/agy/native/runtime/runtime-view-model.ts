import type { ApprovalRequest } from '@harnessmate/protocol';
import type {
  Activity,
  CapabilityDescriptor,
  NativeControlRequest,
  NativeFeedSyncState,
  NativeRuntimeProjection,
  NativeWork,
} from '../../../../lib/native-client';
import { WORK_KIND_LABELS, type SemanticTone } from '../shared';

export type RuntimeBannerPhase =
  | 'reconnecting'
  | 'disconnected'
  | 'requires_action'
  | 'cancelling'
  | 'waiting_background'
  | 'running'
  | 'quiescent';

export interface RuntimeBannerModel {
  readonly phase: RuntimeBannerPhase;
  readonly headline: string;
  readonly detail: string;
  readonly tone: SemanticTone;
  readonly blockingFiniteCount: number;
  readonly detachedDaemonCount: number;
  readonly scheduleCount: number;
  readonly unknownWorkCount: number;
  readonly pendingRequestCount: number;
  readonly leaseReasons: readonly string[];
  readonly showReconnectAction: boolean;
}

export interface StopTargetCandidate {
  readonly key: string;
  readonly target: NativeControlRequest['target'];
  readonly label: string;
  readonly kindBadge: string;
  readonly expectedRevision: number;
  readonly isActive: boolean;
}

export type StopInteractionPhase =
  | 'idle'
  | 'waiting_confirmation'
  | 'confirmed_cancelled'
  | 'unconfirmed_unknown'
  | 'disconnected'
  | 'error';

export interface StopStatusSummary {
  readonly phase: StopInteractionPhase;
  readonly targetLabel: string;
  readonly headline: string;
  readonly detail: string;
  readonly tone: SemanticTone;
}

export interface HonestOutcomeDisplay {
  readonly label: string;
  readonly tone: SemanticTone;
  readonly modelConfirmedSuccess: boolean;
}

function isWorkActive(work: NativeWork): boolean {
  return (
    work.state.kind === 'known' &&
    (work.state.value === 'queued' ||
      work.state.value === 'running' ||
      work.state.value === 'waiting' ||
      work.state.value === 'requires_action')
  );
}

/**
 * Extracts retention lease reasons across both projection shapes (`leaseReasons` in NP-03 client
 * and optional `retentionReasons` from wire DTOs).
 */
export function extractLeaseReasons(projection: NativeRuntimeProjection): readonly string[] {
  const withRetention = projection as NativeRuntimeProjection & {
    retentionReasons?: readonly string[];
  };
  return projection.leaseReasons ?? withRetention.retentionReasons ?? [];
}

/**
 * Computes the top Native Runtime banner state:
 * explicitly highlights waiting_background, requires_action, reconnecting/reconciling,
 * cancelling, and disconnected states without conflating detached daemons with blocking waits.
 */
export function deriveRuntimeBannerModel(
  projection: NativeRuntimeProjection,
  syncState: NativeFeedSyncState | null | undefined,
  pendingApprovals: readonly ApprovalRequest[],
): RuntimeBannerModel {
  const workItems = projection.work;
  const activities = projection.activities;
  const leaseReasons = extractLeaseReasons(projection);

  const blockingFiniteCount = workItems.filter(
    (w) => w.blocking === 'confirmed_blocking' && isWorkActive(w),
  ).length;
  const detachedDaemonCount = workItems.filter(
    (w) => w.kind === 'daemon' && isWorkActive(w),
  ).length;
  const scheduleCount = workItems.filter((w) => w.kind === 'schedule' && isWorkActive(w)).length;
  const unknownWorkCount = workItems.filter(
    (w) => w.state.kind === 'unknown' || w.state.kind === 'stale' || w.kind === 'unknown',
  ).length;

  const activeReceiptPending = Object.values(projection.receipts ?? {}).filter(
    (r) => r.receiptState === 'pending' || r.receiptState === 'claimed',
  ).length;
  const pendingRequestCount = Math.max(pendingApprovals.length, activeReceiptPending);

  const hasCancellingActivity =
    activities.some((a) => a.state === 'cancelling') ||
    leaseReasons.some((r) => r.startsWith('cancel_grace:'));
  const hasWaitingBgActivity = activities.some((a) => a.state === 'waiting_background');
  const hasRequiresActionActivity = activities.some((a) => a.state === 'requires_action');
  const hasRunningActivity = activities.some(
    (a) => a.state === 'running' || a.state === 'starting',
  );

  const isSyncReconnecting =
    syncState?.phase === 'resyncing' ||
    syncState?.phase === 'hydrating' ||
    syncState?.phase === 'catching_up' ||
    syncState?.phase === 'incomplete';

  if (projection.status === 'reconciling' || isSyncReconnecting) {
    return {
      phase: 'reconnecting',
      headline: '重新连接与状态校准中',
      detail:
        syncState?.phase === 'incomplete'
          ? (syncState.lastError ?? '事件补缺未完成，请刷新快照重新对齐，避免误判运行态。')
          : '正在重新连接并校准原生快照；旧代审批不可重放，未确认项保留最后观测。',
      tone: 'star',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: true,
    };
  }

  if (projection.status === 'disconnected') {
    return {
      phase: 'disconnected',
      headline: '观测连接已断开 · 需要重新连接',
      detail: '观测连接已结束，不能推断后台子进程已按逻辑取消；保留最后观测与只读收据。',
      tone: 'rose',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: true,
    };
  }

  if (pendingRequestCount > 0 || hasRequiresActionActivity) {
    return {
      phase: 'requires_action',
      headline: `需要用户处理（${Math.max(1, pendingRequestCount)} 项原生请求）`,
      detail: '存在待处理的原生权限确认或结构化问答；处理前请核对请求作用域与官方选项。',
      tone: 'star',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: false,
    };
  }

  if (hasCancellingActivity) {
    return {
      phase: 'cancelling',
      headline: '正在停止 · 等待原生取消确认',
      detail: '已向原生端发出取消信号，正处于宽限等待窗口，收到原生终态前不会伪造已停止。',
      tone: 'clay',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: false,
    };
  }

  if (hasWaitingBgActivity || blockingFiniteCount > 0) {
    return {
      phase: 'waiting_background',
      headline: `等待有限后台任务（${blockingFiniteCount} 项阻塞中）`,
      detail: '主响应已返回但有限任务仍在执行，保持保活等待原生唤醒，无需用户补发消息。',
      tone: 'star',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: false,
    };
  }

  if (hasRunningActivity) {
    return {
      phase: 'running',
      headline: '原生运行时活跃执行中',
      detail:
        detachedDaemonCount > 0
          ? `主活动运行中；另有 ${detachedDaemonCount} 个常驻 Daemon 独立运行（不阻塞轮次）。`
          : '已收到实时协议帧，正在追踪活动与工作项状态。',
      tone: 'indigo',
      blockingFiniteCount,
      detachedDaemonCount,
      scheduleCount,
      unknownWorkCount,
      pendingRequestCount,
      leaseReasons,
      showReconnectAction: false,
    };
  }

  return {
    phase: 'quiescent',
    headline:
      detachedDaemonCount > 0
        ? `当前无阻塞轮次 · ${detachedDaemonCount} 个常驻 Daemon 运行中`
        : '当前静默待唤醒',
    detail:
      detachedDaemonCount > 0
        ? '常驻 Daemon 与定时任务在后台独立追踪，不阻塞主聊天输入。'
        : '尚未观察到阻塞中的前台任务；可由后续原生事件再次唤醒。',
    tone: 'muted',
    blockingFiniteCount,
    detachedDaemonCount,
    scheduleCount,
    unknownWorkCount,
    pendingRequestCount,
    leaseReasons,
    showReconnectAction: false,
  };
}

/**
 * Enforces "UI 不显示模型未发的成功":
 * Only reports verified success when `outcome` is `known('succeeded')`.
 * Distinguishes observable `finished` from confirmed success, and keeps `unknown`/`stale` honest.
 */
export function formatHonestWorkOutcome(work: NativeWork): HonestOutcomeDisplay {
  if (work.outcome) {
    if (work.outcome.kind === 'known') {
      if (work.outcome.value === 'succeeded') {
        return { label: '已证实成功', tone: 'emerald', modelConfirmedSuccess: true };
      }
      if (work.outcome.value === 'failed') {
        return { label: '结果失败', tone: 'rose', modelConfirmedSuccess: false };
      }
      return { label: '已中止取消', tone: 'clay', modelConfirmedSuccess: false };
    }
    if (work.outcome.kind === 'stale') {
      return {
        label: '结果观测已过期',
        tone: 'clay',
        modelConfirmedSuccess: false,
      };
    }
    return {
      label: '结果未由协议证实',
      tone: 'muted',
      modelConfirmedSuccess: false,
    };
  }

  if (work.state.kind === 'known') {
    if (work.state.value === 'finished') {
      return {
        label: '运行结束（未报成功结果）',
        tone: 'muted',
        modelConfirmedSuccess: false,
      };
    }
    if (work.state.value === 'failed') {
      return { label: '执行失败', tone: 'rose', modelConfirmedSuccess: false };
    }
    if (work.state.value === 'cancelled') {
      return { label: '已确认取消', tone: 'clay', modelConfirmedSuccess: false };
    }
    return {
      label: '尚未终态',
      tone: 'indigo',
      modelConfirmedSuccess: false,
    };
  }

  if (work.state.kind === 'stale') {
    return {
      label: '观测已过期（状态未确认）',
      tone: 'clay',
      modelConfirmedSuccess: false,
    };
  }

  return {
    label: '状态未知（不推断成功）',
    tone: 'muted',
    modelConfirmedSuccess: false,
  };
}

export function deriveStopTargetCandidates(
  projection: NativeRuntimeProjection,
  selectedWork: NativeWork | null,
  selectedActivity: Activity | null,
): StopTargetCandidate[] {
  const candidates: StopTargetCandidate[] = [
    {
      key: `runtime:${projection.binding.runtimeId}`,
      target: { type: 'runtime', id: projection.binding.runtimeId },
      label: `整个原生运行时 (${projection.binding.runtimeId})`,
      kindBadge: 'Runtime 根会话',
      expectedRevision: projection.asOfSeq,
      isActive: projection.status === 'attached',
    },
  ];

  if (selectedWork) {
    candidates.push({
      key: `work:${selectedWork.id}`,
      target: { type: 'work', id: selectedWork.id },
      label: selectedWork.observedLabel ?? selectedWork.id,
      kindBadge:
        selectedWork.kind === 'daemon'
          ? '常驻 Daemon (独立)'
          : selectedWork.kind === 'finite_command'
            ? '有限命令 (阻塞)'
            : WORK_KIND_LABELS[selectedWork.kind],
      expectedRevision: selectedWork.revision,
      isActive: isWorkActive(selectedWork),
    });
  }

  if (selectedActivity) {
    candidates.push({
      key: `activity:${selectedActivity.id}`,
      target: { type: 'activity', id: selectedActivity.id },
      label: selectedActivity.summary ?? selectedActivity.id,
      kindBadge: selectedActivity.turnId ? '用户轮次活动' : '原生续跑活动',
      expectedRevision: projection.asOfSeq,
      isActive:
        selectedActivity.state === 'running' ||
        selectedActivity.state === 'waiting_background' ||
        selectedActivity.state === 'requires_action' ||
        selectedActivity.state === 'cancelling',
    });
  }

  return candidates;
}

export function findStopCapabilityAction(
  capabilities: readonly CapabilityDescriptor[],
): { capability: CapabilityDescriptor; actionKey: string; actionLabel: string } | null {
  const preferredIds = ['AGY-R10', 'agy.reactive.background', 'agy.acp.v1', 'AGY-W11'];
  const ordered = [
    ...preferredIds
      .map((id) => capabilities.find((c) => c.id === id))
      .filter((c): c is CapabilityDescriptor => Boolean(c)),
    ...capabilities.filter((c) => !preferredIds.includes(c.id)),
  ];

  for (const cap of ordered) {
    if (cap.control !== 'available') continue;
    const cancelAct = cap.actions.find(
      (a) => (a.key === 'cancel' || a.key === 'stop') && a.gate === 'available',
    );
    if (cancelAct) {
      return {
        capability: cap,
        actionKey: cancelAct.key,
        actionLabel: cancelAct.label ?? '停止 (Stop)',
      };
    }
  }
  return null;
}

/**
 * Reconciles local Stop dispatch state against authoritative projection state so the UI
 * explicitly separates: target -> waiting -> confirmed_cancelled | unconfirmed_unknown | disconnected | error.
 */
export function deriveStopStatusSummary(params: {
  readonly target: StopTargetCandidate;
  readonly projection: NativeRuntimeProjection;
  readonly localRequested: boolean;
  readonly localSubmitting: boolean;
  readonly localError: string | null;
}): StopStatusSummary {
  const { target, projection, localRequested, localSubmitting, localError } = params;

  if (localError) {
    return {
      phase: 'error',
      targetLabel: target.label,
      headline: '停止请求失败',
      detail: localError,
      tone: 'rose',
    };
  }

  if (projection.status === 'disconnected' && localRequested) {
    return {
      phase: 'disconnected',
      targetLabel: target.label,
      headline: '连接已断开 · 停止结果未确认',
      detail: '观测连接已关闭，不能直接确认目标后台进程已按逻辑退出。',
      tone: 'rose',
    };
  }

  // Inspect authoritative entity state for the chosen target
  if (target.target.type === 'work') {
    const work = projection.work.find((w) => w.id === target.target.id);
    if (work) {
      if (work.state.kind === 'known' && work.state.value === 'cancelled') {
        return {
          phase: 'confirmed_cancelled',
          targetLabel: target.label,
          headline: '已收到原生取消确认',
          detail: `工作项 ${work.id} 已返回原生 cancelled 终态。`,
          tone: 'emerald',
        };
      }
      if (localRequested && (work.state.kind === 'unknown' || work.state.kind === 'stale')) {
        return {
          phase: 'unconfirmed_unknown',
          targetLabel: target.label,
          headline: '宽限期后状态未确认',
          detail: `未收到工作项 ${work.id} 的原生终止确认 (${work.state.reasonCode})，不将其标记为已成功停止。`,
          tone: 'clay',
        };
      }
    }
  } else if (target.target.type === 'activity') {
    const act = projection.activities.find((a) => a.id === target.target.id);
    if (act) {
      if (act.state === 'cancelled') {
        return {
          phase: 'confirmed_cancelled',
          targetLabel: target.label,
          headline: '已收到原生取消确认',
          detail: `活动 ${act.id} 已进入原生 cancelled 终态。`,
          tone: 'emerald',
        };
      }
      if (act.state === 'cancelling') {
        return {
          phase: 'waiting_confirmation',
          targetLabel: target.label,
          headline: '等待原生取消确认…',
          detail: `已对活动 ${act.id} 发出原生取消信号，等待宽限期内终态证据。`,
          tone: 'clay',
        };
      }
      if (localRequested && act.state === 'unknown') {
        return {
          phase: 'unconfirmed_unknown',
          targetLabel: target.label,
          headline: '取消结果未确认（未知）',
          detail: '取消宽限期结束前未收到原生终止帧，状态保持未知。',
          tone: 'clay',
        };
      }
    }
  } else {
    const leaseReasons = extractLeaseReasons(projection);
    const anyCancelling =
      projection.activities.some((a) => a.state === 'cancelling') ||
      leaseReasons.some((r) => r.startsWith('cancel_grace:'));
    if (anyCancelling) {
      return {
        phase: 'waiting_confirmation',
        targetLabel: target.label,
        headline: '等待原生取消确认…',
        detail: '已向原生运行时发出 session/cancel，正等待原生终态确认（宽限期中）。',
        tone: 'clay',
      };
    }
    if (localRequested && projection.activities.some((a) => a.state === 'cancelled')) {
      return {
        phase: 'confirmed_cancelled',
        targetLabel: target.label,
        headline: '已收到原生取消确认',
        detail: '原生运行时已返回 cancelled 终态。',
        tone: 'emerald',
      };
    }
    if (localRequested && projection.activities.some((a) => a.state === 'unknown')) {
      return {
        phase: 'unconfirmed_unknown',
        targetLabel: target.label,
        headline: '取消结果未确认（未知）',
        detail: '未在宽限期内收到原生终态证据，不能确认后台进程已全部退出。',
        tone: 'clay',
      };
    }
  }

  if (localSubmitting || localRequested) {
    return {
      phase: 'waiting_confirmation',
      targetLabel: target.label,
      headline: localSubmitting ? '正在发送原生取消信号…' : '已发送停止请求，等待原生确认…',
      detail: `目标：${target.label}（在收到原生终态前不会显示已停止）。`,
      tone: 'clay',
    };
  }

  return {
    phase: 'idle',
    targetLabel: target.label,
    headline: '就绪',
    detail: `当前选定目标：${target.label}。`,
    tone: 'muted',
  };
}
