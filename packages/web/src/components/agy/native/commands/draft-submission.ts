import type {
  ActivityId,
  BindingGeneration,
  NativeCommandSubmitRequest,
  NativeCommandSubmitResponse,
} from '../../../../lib/native-client';
import { NativeClientError } from '../../../../lib/native-client';

export interface PreservedCommandDraft {
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly selectedModeId: string;
  readonly selectedCapabilityId?: string;
  readonly selectedActionKey?: string;
}

export type CommandSubmissionPhase =
  | 'idle'
  | 'submitting'
  | 'accepted_waiting_evidence'
  | 'accepted_confirmed'
  | 'inspected'
  | 'conflict_preserved'
  | 'error_preserved';

export interface NativeCommandSubmissionState {
  readonly phase: CommandSubmissionPhase;
  readonly draft: PreservedCommandDraft;
  readonly activeIdempotencyKey: string | null;
  readonly activeRequestFingerprint: string | null;
  readonly statusMessage?: string;
  readonly inspectOutput?: string;
  readonly receiptId?: string;
  readonly activityId?: ActivityId;
  readonly turnId?: string | null;
  readonly lastErrorCode?: string;
  readonly capabilitiesRefreshRequested: boolean;
}

export function createInitialCommandSubmissionState(
  initialDraft?: Partial<PreservedCommandDraft>,
): NativeCommandSubmissionState {
  return {
    phase: 'idle',
    draft: {
      text: initialDraft?.text ?? '',
      attachmentIds: initialDraft?.attachmentIds ? [...initialDraft.attachmentIds] : [],
      selectedModeId: initialDraft?.selectedModeId ?? 'normal',
      ...(initialDraft?.selectedCapabilityId
        ? { selectedCapabilityId: initialDraft.selectedCapabilityId }
        : {}),
      ...(initialDraft?.selectedActionKey
        ? { selectedActionKey: initialDraft.selectedActionKey }
        : {}),
    },
    activeIdempotencyKey: null,
    activeRequestFingerprint: null,
    capabilitiesRefreshRequested: false,
  };
}

/**
 * Builds the canonical native command request payload while preserving exact attachment order.
 */
export function buildOrderedCommandSubmitRequest(params: {
  readonly bindingGeneration: BindingGeneration;
  readonly catalogRevision: number;
  readonly capabilityId: string;
  readonly actionKey: string;
  readonly args: Record<string, string | number | boolean | null | string[]>;
  readonly attachmentIds?: readonly string[];
  readonly idempotencyKey: string;
}): NativeCommandSubmitRequest {
  const orderedAttachments = (params.attachmentIds ?? []).filter((id) => id.trim().length > 0);
  return {
    bindingGeneration: params.bindingGeneration,
    catalogRevision: params.catalogRevision,
    capabilityId: params.capabilityId,
    actionKey: params.actionKey,
    args: {
      ...params.args,
      ...(orderedAttachments.length > 0 ? { attachmentIds: orderedAttachments } : {}),
    },
    idempotencyKey: params.idempotencyKey,
  };
}

function fingerprintSubmission(params: {
  bindingGeneration: string;
  catalogRevision: number;
  capabilityId: string;
  actionKey: string;
  args: Record<string, unknown>;
}): string {
  return JSON.stringify({
    g: params.bindingGeneration,
    r: params.catalogRevision,
    c: params.capabilityId,
    a: params.actionKey,
    p: params.args,
  });
}

function generateIdempotencyKey(seqHint: number): string {
  return `ncmd_${Date.now().toString(36)}_${seqHint.toString(36)}`;
}

/**
 * Pure submission coordinator ensuring:
 * 1. Mode switches and catalog revision updates NEVER wipe user draft text or ordered attachments.
 * 2. Duplicate clicks for the same unchanged payload reuse the same `idempotencyKey`.
 * 3. `409` (`STALE_BINDING`, `BUSY`, `IDEMPOTENCY_CONFLICT`) preserves the full draft + attachments
 *    and flags capability refresh so the user can retry cleanly without retyping.
 * 4. Accepted responses without `modeEvidenceObserved === true` honestly report
 *    "已发送，等待原生确认" instead of claiming mode activation.
 */
export class NativeCommandSubmissionController {
  private state: NativeCommandSubmissionState;
  private keyCounter = 0;

  constructor(initialDraft?: Partial<PreservedCommandDraft>) {
    this.state = createInitialCommandSubmissionState(initialDraft);
  }

  getState(): NativeCommandSubmissionState {
    return this.state;
  }

  updateDraft(patch: Partial<PreservedCommandDraft>): NativeCommandSubmissionState {
    const nextDraft: PreservedCommandDraft = {
      ...this.state.draft,
      ...patch,
      attachmentIds: patch.attachmentIds
        ? [...patch.attachmentIds]
        : [...this.state.draft.attachmentIds],
    };
    // Changing draft content clears the previous submission's idempotency fingerprint so a new edit mints a fresh key
    const textOrAttachmentsChanged =
      nextDraft.text !== this.state.draft.text ||
      nextDraft.attachmentIds.join(',') !== this.state.draft.attachmentIds.join(',') ||
      nextDraft.selectedActionKey !== this.state.draft.selectedActionKey ||
      nextDraft.selectedCapabilityId !== this.state.draft.selectedCapabilityId;

    this.state = {
      ...this.state,
      draft: nextDraft,
      ...(textOrAttachmentsChanged
        ? {
            activeIdempotencyKey: null,
            activeRequestFingerprint: null,
            capabilitiesRefreshRequested: false,
          }
        : {}),
    };
    return this.state;
  }

  /**
   * Switching mode preserves user text & attachment ordering untouched.
   */
  selectMode(params: {
    readonly modeId: string;
    readonly capabilityId?: string;
    readonly actionKey?: string;
  }): NativeCommandSubmissionState {
    return this.updateDraft({
      selectedModeId: params.modeId,
      selectedCapabilityId: params.capabilityId,
      selectedActionKey: params.actionKey,
    });
  }

  /**
   * Executes command submission through the provided submit function.
   * Reuses the same `idempotencyKey` if invoked repeatedly for the same payload.
   */
  async submit(
    params: {
      readonly bindingGeneration: BindingGeneration;
      readonly catalogRevision: number;
      readonly capabilityId: string;
      readonly actionKey: string;
      readonly args: Record<string, string | number | boolean | null | string[]>;
    },
    executor: (req: NativeCommandSubmitRequest) => Promise<NativeCommandSubmitResponse>,
    onRefreshCapabilities?: () => void | Promise<void>,
  ): Promise<NativeCommandSubmissionState> {
    const orderedArgs = {
      ...params.args,
      ...(this.state.draft.attachmentIds.length > 0
        ? { attachmentIds: [...this.state.draft.attachmentIds] }
        : {}),
    };
    const fp = fingerprintSubmission({
      bindingGeneration: params.bindingGeneration,
      catalogRevision: params.catalogRevision,
      capabilityId: params.capabilityId,
      actionKey: params.actionKey,
      args: orderedArgs,
    });

    const idempotencyKey =
      this.state.activeRequestFingerprint === fp && this.state.activeIdempotencyKey
        ? this.state.activeIdempotencyKey
        : generateIdempotencyKey(++this.keyCounter);

    const request = buildOrderedCommandSubmitRequest({
      bindingGeneration: params.bindingGeneration,
      catalogRevision: params.catalogRevision,
      capabilityId: params.capabilityId,
      actionKey: params.actionKey,
      args: params.args,
      attachmentIds: this.state.draft.attachmentIds,
      idempotencyKey,
    });

    this.state = {
      ...this.state,
      phase: 'submitting',
      activeIdempotencyKey: idempotencyKey,
      activeRequestFingerprint: fp,
      statusMessage: '正在发起…',
      lastErrorCode: undefined,
      capabilitiesRefreshRequested: false,
    };

    try {
      const response = await executor(request);
      if (response.status === 'accepted') {
        const confirmed = response.modeEvidenceObserved === true;
        this.state = {
          ...this.state,
          phase: confirmed ? 'accepted_confirmed' : 'accepted_waiting_evidence',
          statusMessage: confirmed ? '原生工作流已确认启动' : '已发送，等待原生确认',
          receiptId: response.receiptId,
          activityId: response.activityId,
          turnId: response.turnId,
          draft: {
            ...this.state.draft,
            text: '',
            attachmentIds: [],
          },
          activeIdempotencyKey: null,
          activeRequestFingerprint: null,
        };
      } else {
        this.state = {
          ...this.state,
          phase: 'inspected',
          statusMessage: '查询/配置已完成',
          inspectOutput: response.output ?? '',
          receiptId: response.receiptId,
          activeIdempotencyKey: null,
          activeRequestFingerprint: null,
        };
      }
      return this.state;
    } catch (err) {
      const nativeErr = err instanceof NativeClientError ? err : null;
      const isConflict =
        nativeErr?.status === 409 ||
        nativeErr?.code === 'STALE_BINDING' ||
        nativeErr?.code === 'BUSY' ||
        nativeErr?.code === 'IDEMPOTENCY_CONFLICT';

      if (isConflict) {
        this.state = {
          ...this.state,
          phase: 'conflict_preserved',
          // Preserve draft & attachments intact!
          draft: { ...this.state.draft },
          // Keep idempotency key on BUSY so retry doesn't double-send; clear on STALE_BINDING so fresh rev uses new key
          activeIdempotencyKey: nativeErr?.code === 'BUSY' ? idempotencyKey : null,
          activeRequestFingerprint: nativeErr?.code === 'BUSY' ? fp : null,
          lastErrorCode: nativeErr?.code ?? 'STALE_BINDING',
          statusMessage:
            nativeErr?.code === 'BUSY'
              ? '相同请求正在处理中，已保留草稿，请勿重复提交'
              : '能力目录或会话绑定已更新，已保留草稿并刷新目录',
          capabilitiesRefreshRequested: true,
        };
        await onRefreshCapabilities?.();
        return this.state;
      }

      this.state = {
        ...this.state,
        phase: 'error_preserved',
        draft: { ...this.state.draft },
        lastErrorCode: nativeErr?.code ?? 'UNKNOWN_ERROR',
        statusMessage: err instanceof Error ? err.message : '原生命令提交失败，草稿已保留',
        capabilitiesRefreshRequested: false,
      };
      return this.state;
    }
  }
}
