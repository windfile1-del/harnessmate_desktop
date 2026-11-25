import type { RpcId } from '@harnessmate/protocol';
import type {
  AttachStrategyDecision,
  CliVersionCompatProfile,
  NegotiatedAcpProtocol,
  ParsedAcpInitializeCapabilities,
  RecoveryGuardResult,
  RecoveryReasonCode,
} from './types.js';

export class ProtocolCompatibilityError extends Error {
  constructor(
    readonly reasonCode: RecoveryReasonCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProtocolCompatibilityError';
  }
}

export interface AcpInitializeRequestPayload {
  readonly protocolVersion: 1 | 2;
  readonly clientCapabilities: {
    readonly fs: { readonly readTextFile: false; readonly writeTextFile: false };
    readonly terminal: false;
  };
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
}

export function buildInitializeRequest(opts?: {
  readonly allowV2Preview?: boolean;
  readonly clientName?: string;
  readonly clientVersion?: string;
}): AcpInitializeRequestPayload {
  return {
    protocolVersion: opts?.allowV2Preview ? 2 : 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: opts?.clientName ?? 'harnessmate-desktop',
      version: opts?.clientVersion ?? '0.3.0',
    },
  };
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

function parseSemver(version: string | null | undefined): ParsedSemver | null {
  if (!version || typeof version !== 'string') return null;
  const trimmed = version.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(trimmed);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    raw: trimmed,
  };
}

function compareSemver(a: ParsedSemver, b: { major: number; minor: number; patch: number }): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Evaluates CLI version behavior across documented AGY compatibility bands:
 * - Quarantined bad versions -> safe degraded mode (skip session/close, block workflow controls)
 * - `< 1.5.10` -> legacy unverified (no reliable cancel/close, require process-tree fallback)
 * - `1.5.10..1.5.14` -> pre-1.5.15 compat (idle-gap load guard, no reliable session/close)
 * - `1.5.15` -> boundary release (longer finite prompt, cancel supported, close if advertised)
 * - `1.5.16+` -> verified handshake v1 (E02/E03/1.5.17, session/close & child routing fixes)
 */
export function evaluateCliVersionCompatibility(
  cliVersion: string | null | undefined,
  quarantinedVersions: readonly string[] = [],
): CliVersionCompatProfile {
  const normalized = typeof cliVersion === 'string' && cliVersion.trim() ? cliVersion.trim() : null;
  if (normalized && quarantinedVersions.includes(normalized)) {
    return {
      band: 'quarantined_bad_version',
      cliVersion: normalized,
      supportsReliableCancel: false,
      supportsSessionClose: false,
      requiresIdleGapLoadGuard: true,
      degradedToSafeMode: true,
      reasonCode: 'bad_cli_version_degraded',
      notes: `CLI version ${normalized} is quarantined; degraded to read-only safe mode with process-tree cleanup.`,
    };
  }

  const parsed = parseSemver(normalized);
  if (!parsed) {
    return {
      band: 'unknown_version',
      cliVersion: normalized,
      supportsReliableCancel: true,
      supportsSessionClose: false,
      requiresIdleGapLoadGuard: true,
      degradedToSafeMode: false,
      notes: 'CLI version missing or unparseable; conservative v1 defaults applied (tree teardown fallback enabled).',
    };
  }

  if (compareSemver(parsed, { major: 1, minor: 5, patch: 10 }) < 0) {
    return {
      band: 'legacy_unverified',
      cliVersion: parsed.raw,
      supportsReliableCancel: false,
      supportsSessionClose: false,
      requiresIdleGapLoadGuard: true,
      degradedToSafeMode: true,
      reasonCode: 'bad_cli_version_degraded',
      notes: `CLI ${parsed.raw} is older than 1.5.10; degraded to safe mode and explicit Windows process-tree teardown.`,
    };
  }

  if (compareSemver(parsed, { major: 1, minor: 5, patch: 15 }) < 0) {
    return {
      band: 'pre_1515_finite_compat',
      cliVersion: parsed.raw,
      supportsReliableCancel: true,
      supportsSessionClose: false,
      requiresIdleGapLoadGuard: true,
      degradedToSafeMode: false,
      notes: `CLI ${parsed.raw} (1.5.10-1.5.14 band): idle-gap session/load guard active; rely on process-tree fallback on exit.`,
    };
  }

  if (compareSemver(parsed, { major: 1, minor: 5, patch: 16 }) < 0) {
    return {
      band: 'boundary_1515',
      cliVersion: parsed.raw,
      supportsReliableCancel: true,
      supportsSessionClose: true,
      requiresIdleGapLoadGuard: true,
      degradedToSafeMode: false,
      notes: `CLI ${parsed.raw} (1.5.15 boundary): supports finite prompt extension and cancel; close allowed when advertised.`,
    };
  }

  return {
    band: 'verified_handshake_v1',
    cliVersion: parsed.raw,
    supportsReliableCancel: true,
    supportsSessionClose: true,
    requiresIdleGapLoadGuard: true,
    degradedToSafeMode: false,
    notes: `CLI ${parsed.raw} (1.5.16+): handshake verified for v1 sessionCapabilities (resume/load/close/list/additionalDirectories).`,
  };
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

export type NegotiateAcpProtocolResult =
  | {
      readonly ok: true;
      readonly capabilities: ParsedAcpInitializeCapabilities;
      readonly compat: CliVersionCompatProfile;
      readonly instantiateV2Preview: boolean;
      readonly reasonCode?: RecoveryReasonCode;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'unsupported_protocol_version' | 'v2_schema_unconfirmed';
      readonly message: string;
      readonly observedProtocol: unknown;
      readonly cliVersion: string | null;
    };

/**
 * Negotiates ACP protocol version from an `initialize` result.
 * - Accepts camelCase & snake_case capability fields observed on Windows AGY 1.5.16 / 1.5.17.
 * - Downgrades cleanly from requested v2 -> v1 BEFORE any prompt is sent when server replies protocolVersion: 1.
 * - Fails closed on unknown versions (0, 3, 99, strings) or unconfirmed v2 schemas.
 */
export function negotiateAcpProtocol(input: {
  readonly requestedProtocol: 1 | 2;
  readonly allowV2Preview: boolean;
  readonly initializeResult: unknown;
  readonly quarantinedCliVersions?: readonly string[];
}): NegotiateAcpProtocolResult {
  const root = asRecord(input.initializeResult);
  if (!root) {
    return {
      ok: false,
      reasonCode: 'unsupported_protocol_version',
      message: 'ACP initialize result is not an object',
      observedProtocol: input.initializeResult,
      cliVersion: null,
    };
  }

  const agentInfo = asRecord(root.agentInfo);
  const cliVersion =
    typeof agentInfo?.version === 'string' && agentInfo.version.trim()
      ? agentInfo.version.trim()
      : null;
  const agentName =
    typeof agentInfo?.name === 'string' && agentInfo.name.trim()
      ? agentInfo.name.trim()
      : null;

  const rawProto = root.protocolVersion;
  if (rawProto !== 1 && rawProto !== 2) {
    return {
      ok: false,
      reasonCode: 'unsupported_protocol_version',
      message: `Unsupported ACP protocolVersion: ${String(rawProto)}`,
      observedProtocol: rawProto,
      cliVersion,
    };
  }

  const negotiatedProtocol: NegotiatedAcpProtocol = rawProto;
  const agentCaps = asRecord(root.agentCapabilities) ?? {};
  const sessionCaps =
    asRecord(agentCaps.sessionCapabilities) ?? asRecord(agentCaps.session_capabilities) ?? {};
  const promptCaps =
    asRecord(agentCaps.promptCapabilities) ?? asRecord(agentCaps.prompt_capabilities) ?? {};

  const resumeCap = sessionCaps.resume;
  const hasResume = resumeCap !== undefined && resumeCap !== false && resumeCap !== null;
  const hasLoad =
    Boolean(agentCaps.loadSession ?? agentCaps.load_session) ||
    (sessionCaps.load !== undefined && sessionCaps.load !== false && sessionCaps.load !== null);
  const hasClose =
    sessionCaps.close !== undefined && sessionCaps.close !== false && sessionCaps.close !== null;
  const hasList =
    sessionCaps.list !== undefined && sessionCaps.list !== false && sessionCaps.list !== null;
  const hasAdditionalDirs =
    sessionCaps.additionalDirectories !== undefined &&
    sessionCaps.additionalDirectories !== false &&
    sessionCaps.additionalDirectories !== null;

  const replayCursorFlag =
    Boolean(sessionCaps.replayCursor ?? sessionCaps.replayFrom ?? sessionCaps.stateStream) ||
    Boolean(asRecord(resumeCap)?.replayFrom || asRecord(resumeCap)?.cursor);
  const v2SchemaConfirmed = negotiatedProtocol === 2 && replayCursorFlag;

  if (negotiatedProtocol === 2 && (!input.allowV2Preview || !v2SchemaConfirmed)) {
    return {
      ok: false,
      reasonCode: 'v2_schema_unconfirmed',
      message: !input.allowV2Preview
        ? 'ACP v2 Preview gate is disabled; refusing v2 runtime instantiation'
        : 'Server returned protocolVersion 2 without confirmed replayCursor/stateStream schema capabilities',
      observedProtocol: negotiatedProtocol,
      cliVersion,
    };
  }

  const authMethodsRaw = Array.isArray(root.authMethods) ? root.authMethods : [];
  const authMethods: string[] = [];
  for (const item of authMethodsRaw) {
    if (typeof item === 'string' && item.trim()) {
      authMethods.push(item.trim());
    } else {
      const rec = asRecord(item);
      if (typeof rec?.id === 'string' && rec.id.trim()) {
        authMethods.push(rec.id.trim());
      }
    }
  }

  const capabilities: ParsedAcpInitializeCapabilities = {
    requestedProtocol: input.requestedProtocol,
    negotiatedProtocol,
    downgradedFromV2: input.requestedProtocol === 2 && negotiatedProtocol === 1,
    v2SchemaConfirmed,
    agentName,
    cliVersion,
    authMethods,
    loadSession: Boolean(agentCaps.loadSession ?? agentCaps.load_session),
    sessionCapabilities: {
      resume: hasResume,
      load: hasLoad,
      close: hasClose,
      list: hasList,
      additionalDirectories: hasAdditionalDirs,
      replayCursor: replayCursorFlag,
    },
    promptCapabilities: {
      image: Boolean(promptCaps.image),
      audio: Boolean(promptCaps.audio),
      embeddedContext: Boolean(promptCaps.embeddedContext),
    },
  };

  const compat = evaluateCliVersionCompatibility(cliVersion, input.quarantinedCliVersions);

  let reasonCode: RecoveryReasonCode | undefined;
  if (capabilities.downgradedFromV2) {
    reasonCode = 'v2_downgraded_to_v1';
  } else if (compat.degradedToSafeMode) {
    reasonCode = 'bad_cli_version_degraded';
  }

  return {
    ok: true,
    capabilities,
    compat,
    instantiateV2Preview: Boolean(input.allowV2Preview && negotiatedProtocol === 2 && v2SchemaConfirmed),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/**
 * Selects attach/replay mode strictly from binding guard, negotiated protocol capabilities,
 * and CLI compatibility band. Separates v1 `session/resume` (live, no replay) from `session/load`
 * (history_replay), and keeps v2 preview gated behind double-confirmation.
 */
export function selectAttachStrategy(input: {
  readonly negotiated: ParsedAcpInitializeCapabilities;
  readonly compat: CliVersionCompatProfile;
  readonly hasNativeSessionId: boolean;
  readonly guard: RecoveryGuardResult;
  readonly requireNativeResume?: boolean;
  readonly allowV2Preview: boolean;
  readonly replayFromCursor?: string;
}): AttachStrategyDecision {
  if (!input.guard.allowed) {
    if (input.guard.requiresManualAuth) {
      return {
        mode: 'auth_blocked',
        channelDuringAttach: 'history_replay',
        willReplayHistory: false,
        allowsLiveApprovalsDuringAttach: false,
        allowsWorkflowControlDuringReconcile: false,
        reasonCode: input.guard.reasonCode ?? 'auth_required_manual_login',
      };
    }
    return {
      mode: 'manual_attach_only',
      channelDuringAttach: 'history_replay',
      willReplayHistory: false,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: input.guard.reasonCode ?? 'profile_or_source_mismatch',
    };
  }

  if (!input.hasNativeSessionId) {
    return {
      mode: 'fresh',
      channelDuringAttach: 'live',
      willReplayHistory: false,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'fresh_session_attached',
    };
  }

  if (input.compat.degradedToSafeMode) {
    if (input.negotiated.sessionCapabilities.load) {
      return {
        mode: 'v1_load_replay',
        channelDuringAttach: 'history_replay',
        willReplayHistory: true,
        allowsLiveApprovalsDuringAttach: false,
        allowsWorkflowControlDuringReconcile: false,
        reasonCode: 'bad_cli_version_degraded',
        fallbackFrom: 'v1_resume_attached',
      };
    }
    return {
      mode: 'manual_attach_only',
      channelDuringAttach: 'history_replay',
      willReplayHistory: false,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'bad_cli_version_degraded',
    };
  }

  if (
    input.allowV2Preview &&
    input.negotiated.negotiatedProtocol === 2 &&
    input.negotiated.v2SchemaConfirmed
  ) {
    const usesReplay = Boolean(input.replayFromCursor);
    return {
      mode: 'v2_resume_cursor',
      channelDuringAttach: usesReplay ? 'history_replay' : 'live',
      willReplayHistory: usesReplay,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'v2_preview_attached',
    };
  }

  if (input.negotiated.sessionCapabilities.resume) {
    return {
      mode: 'v1_resume',
      channelDuringAttach: 'live',
      willReplayHistory: false,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'v1_resume_attached',
      ...(input.negotiated.downgradedFromV2 ? { fallbackFrom: 'v2_downgraded_to_v1' } : {}),
    };
  }

  if (input.negotiated.sessionCapabilities.load) {
    return {
      mode: 'v1_load_replay',
      channelDuringAttach: 'history_replay',
      willReplayHistory: true,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'v1_load_replay_attached',
      ...(input.negotiated.downgradedFromV2 ? { fallbackFrom: 'v2_downgraded_to_v1' } : {}),
    };
  }

  if (input.requireNativeResume) {
    return {
      mode: 'manual_attach_only',
      channelDuringAttach: 'history_replay',
      willReplayHistory: false,
      allowsLiveApprovalsDuringAttach: false,
      allowsWorkflowControlDuringReconcile: false,
      reasonCode: 'no_live_continuation_evidence',
    };
  }

  return {
    mode: 'fresh',
    channelDuringAttach: 'live',
    willReplayHistory: false,
    allowsLiveApprovalsDuringAttach: false,
    allowsWorkflowControlDuringReconcile: false,
    reasonCode: 'fresh_session_attached',
  };
}

// ── ACP v1 Codec (Default Production Path) ─────────────────────────────

export type DecodedV1Frame =
  | {
      readonly kind: 'v1_session_update';
      readonly sessionId: string | null;
      readonly sessionUpdate: string;
      readonly rawUpdate: Record<string, unknown>;
    }
  | {
      readonly kind: 'v1_server_request';
      readonly rpcId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly kind: 'v1_rpc_response';
      readonly rpcId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly result: unknown;
    }
  | {
      readonly kind: 'v1_rpc_error';
      readonly rpcId: RpcId | null;
      readonly rpcIdType: 'number' | 'string' | null;
      readonly code: number;
      readonly message: string;
    }
  | {
      readonly kind: 'v2_frame_rejected_on_v1';
      readonly reasonCode: 'unsupported_protocol_version';
      readonly methodOrUpdate: string;
    }
  | {
      readonly kind: 'invalid_frame';
      readonly reason: string;
    };

const V2_ONLY_UPDATES = new Set(['state_update', 'replay_complete', 'prompt_accepted']);
const V2_ONLY_METHODS = new Set(['session/replay_complete', 'session/state_update']);

function parseRpcId(rawId: unknown): { id: RpcId; type: 'number' | 'string' } | null {
  if (typeof rawId === 'number' && Number.isSafeInteger(rawId)) {
    return { id: rawId, type: 'number' };
  }
  if (typeof rawId === 'string' && rawId.length > 0) {
    return { id: rawId, type: 'string' };
  }
  return null;
}

export class AcpV1ProtocolCodec {
  readonly protocolVersion = 1 as const;

  encodeSessionAttach(
    mode: 'v1_resume' | 'v1_load_replay',
    params: {
      readonly sessionId: string;
      readonly cwd: string;
      readonly mcpServers?: readonly unknown[];
    },
  ): { readonly method: 'session/resume' | 'session/load'; readonly params: Record<string, unknown> } {
    return {
      method: mode === 'v1_resume' ? 'session/resume' : 'session/load',
      params: {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ? [...params.mcpServers] : [],
      },
    };
  }

  encodeSessionCancel(sessionId: string): {
    readonly method: 'session/cancel';
    readonly params: { readonly sessionId: string };
  } {
    return {
      method: 'session/cancel',
      params: { sessionId },
    };
  }

  encodeSessionClose(sessionId: string): {
    readonly method: 'session/close';
    readonly params: { readonly sessionId: string };
  } {
    return {
      method: 'session/close',
      params: { sessionId },
    };
  }

  decodeFrame(wire: unknown): DecodedV1Frame {
    const obj = asRecord(wire);
    if (!obj) {
      return { kind: 'invalid_frame', reason: 'frame_not_object' };
    }

    const method = typeof obj.method === 'string' ? obj.method : null;
    const parsedId = obj.id !== undefined ? parseRpcId(obj.id) : null;
    if (obj.id !== undefined && obj.id !== null && !parsedId) {
      return { kind: 'invalid_frame', reason: 'invalid_rpc_id' };
    }

    if (method && parsedId) {
      if (V2_ONLY_METHODS.has(method)) {
        return {
          kind: 'v2_frame_rejected_on_v1',
          reasonCode: 'unsupported_protocol_version',
          methodOrUpdate: method,
        };
      }
      return {
        kind: 'v1_server_request',
        rpcId: parsedId.id,
        rpcIdType: parsedId.type,
        method,
        params: asRecord(obj.params) ?? {},
      };
    }

    if (method && !parsedId) {
      if (V2_ONLY_METHODS.has(method)) {
        return {
          kind: 'v2_frame_rejected_on_v1',
          reasonCode: 'unsupported_protocol_version',
          methodOrUpdate: method,
        };
      }
      if (method === 'session/update') {
        const params = asRecord(obj.params) ?? {};
        const update = asRecord(params.update) ?? {};
        const sessionUpdate =
          typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown';
        if (V2_ONLY_UPDATES.has(sessionUpdate)) {
          return {
            kind: 'v2_frame_rejected_on_v1',
            reasonCode: 'unsupported_protocol_version',
            methodOrUpdate: sessionUpdate,
          };
        }
        return {
          kind: 'v1_session_update',
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : null,
          sessionUpdate,
          rawUpdate: update,
        };
      }
      return { kind: 'invalid_frame', reason: `unrecognized_notification:${method}` };
    }

    if (obj.error !== undefined) {
      const errObj = asRecord(obj.error);
      const code = typeof errObj?.code === 'number' ? errObj.code : -32603;
      const message = typeof errObj?.message === 'string' ? errObj.message : 'JSON-RPC error';
      return {
        kind: 'v1_rpc_error',
        rpcId: parsedId?.id ?? null,
        rpcIdType: parsedId?.type ?? null,
        code,
        message,
      };
    }

    if ('result' in obj && parsedId) {
      return {
        kind: 'v1_rpc_response',
        rpcId: parsedId.id,
        rpcIdType: parsedId.type,
        result: obj.result,
      };
    }

    return { kind: 'invalid_frame', reason: 'malformed_jsonrpc_envelope' };
  }
}

// ── ACP v2 Preview Codec (Controlled Instantiation Only) ───────────────

export type DecodedV2PreviewFrame =
  | {
      readonly kind: 'v2_prompt_accepted';
      readonly rpcId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly turnToken?: string;
    }
  | {
      readonly kind: 'v2_state_update';
      readonly sessionId: string | null;
      readonly state: string;
      readonly cursor?: string;
      readonly channel: 'live' | 'history_replay';
    }
  | {
      readonly kind: 'v2_session_message';
      readonly sessionId: string | null;
      readonly role: 'user' | 'assistant' | 'thought' | 'system';
      readonly text: string;
      readonly cursor?: string;
      readonly channel: 'live' | 'history_replay';
    }
  | {
      readonly kind: 'v2_replay_complete';
      readonly sessionId: string | null;
      readonly finalCursor: string | null;
      readonly channelTransitionedToLive: true;
    }
  | {
      readonly kind: 'v2_server_request_blocked_replay';
      readonly rpcId: RpcId;
      readonly method: string;
      readonly reasonCode: 'replay_server_request_blocked';
    }
  | {
      readonly kind: 'v2_server_request_live';
      readonly rpcId: RpcId;
      readonly rpcIdType: 'number' | 'string';
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly kind: 'v2_invalid_frame';
      readonly reason: string;
    };

export class AcpV2PreviewProtocolCodec {
  readonly protocolVersion = 2 as const;
  private replayActive: boolean;
  private replayCompletedOnce = false;
  private lastCursor: string | null = null;

  constructor(opts?: { readonly startInReplay?: boolean }) {
    this.replayActive = Boolean(opts?.startInReplay);
  }

  isReplayActive(): boolean {
    return this.replayActive;
  }

  getLastCursor(): string | null {
    return this.lastCursor;
  }

  encodeSessionResume(params: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly replayFrom?: string;
    readonly mcpServers?: readonly unknown[];
  }): { readonly method: 'session/resume'; readonly params: Record<string, unknown> } {
    if (params.replayFrom !== undefined) {
      if (typeof params.replayFrom !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(params.replayFrom)) {
        throw new ProtocolCompatibilityError(
          'unsupported_protocol_version',
          'Invalid ACP v2 replayFrom cursor token',
        );
      }
      this.replayActive = true;
    }
    return {
      method: 'session/resume',
      params: {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ? [...params.mcpServers] : [],
        ...(params.replayFrom ? { replayFrom: params.replayFrom } : {}),
      },
    };
  }

  decodeFrame(wire: unknown): DecodedV2PreviewFrame {
    const obj = asRecord(wire);
    if (!obj) {
      return { kind: 'v2_invalid_frame', reason: 'frame_not_object' };
    }

    const parsedId = obj.id !== undefined ? parseRpcId(obj.id) : null;
    if (obj.id !== undefined && obj.id !== null && !parsedId) {
      return { kind: 'v2_invalid_frame', reason: 'invalid_rpc_id' };
    }

    // Prompt acceptance response: { id, result: { accepted: true, ... } }
    if ('result' in obj && parsedId && !obj.method) {
      const resObj = asRecord(obj.result);
      if (resObj && resObj.accepted === true) {
        return {
          kind: 'v2_prompt_accepted',
          rpcId: parsedId.id,
          rpcIdType: parsedId.type,
          ...(typeof resObj.turnToken === 'string' ? { turnToken: resObj.turnToken } : {}),
        };
      }
      return { kind: 'v2_invalid_frame', reason: 'unrecognized_v2_result' };
    }

    const method = typeof obj.method === 'string' ? obj.method : null;
    if (!method) {
      return { kind: 'v2_invalid_frame', reason: 'missing_method' };
    }

    // Server request: strictly block while replay boundary is still open
    if (parsedId) {
      if (this.replayActive) {
        return {
          kind: 'v2_server_request_blocked_replay',
          rpcId: parsedId.id,
          method,
          reasonCode: 'replay_server_request_blocked',
        };
      }
      return {
        kind: 'v2_server_request_live',
        rpcId: parsedId.id,
        rpcIdType: parsedId.type,
        method,
        params: asRecord(obj.params) ?? {},
      };
    }

    const params = asRecord(obj.params) ?? {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;

    if (method === 'session/replay_complete') {
      if (this.replayCompletedOnce) {
        return { kind: 'v2_invalid_frame', reason: 'duplicate_replay_complete' };
      }
      const finalCursor = typeof params.cursor === 'string' ? params.cursor : null;
      this.replayCompletedOnce = true;
      this.replayActive = false;
      if (finalCursor) this.lastCursor = finalCursor;
      return {
        kind: 'v2_replay_complete',
        sessionId,
        finalCursor,
        channelTransitionedToLive: true,
      };
    }

    if (method !== 'session/update') {
      return { kind: 'v2_invalid_frame', reason: `unknown_v2_method:${method}` };
    }

    const update = asRecord(params.update);
    if (!update || typeof update.sessionUpdate !== 'string') {
      return { kind: 'v2_invalid_frame', reason: 'missing_session_update' };
    }

    const cursor = typeof update.cursor === 'string' ? update.cursor : undefined;
    if (cursor) this.lastCursor = cursor;
    const channel: 'live' | 'history_replay' = this.replayActive ? 'history_replay' : 'live';

    switch (update.sessionUpdate) {
      case 'replay_complete': {
        if (this.replayCompletedOnce) {
          return { kind: 'v2_invalid_frame', reason: 'duplicate_replay_complete' };
        }
        const finalCursor = typeof update.finalCursor === 'string' ? update.finalCursor : cursor ?? null;
        this.replayCompletedOnce = true;
        this.replayActive = false;
        if (finalCursor) this.lastCursor = finalCursor;
        return {
          kind: 'v2_replay_complete',
          sessionId,
          finalCursor,
          channelTransitionedToLive: true,
        };
      }

      case 'state_update': {
        if (typeof update.state !== 'string' || !update.state.trim()) {
          return { kind: 'v2_invalid_frame', reason: 'state_update_missing_state' };
        }
        return {
          kind: 'v2_state_update',
          sessionId,
          state: update.state.trim(),
          ...(cursor ? { cursor } : {}),
          channel,
        };
      }

      case 'session_message': {
        const roleRaw = update.role;
        const role =
          roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'thought' || roleRaw === 'system'
            ? roleRaw
            : null;
        if (!role || typeof update.text !== 'string') {
          return { kind: 'v2_invalid_frame', reason: 'session_message_invalid_fields' };
        }
        return {
          kind: 'v2_session_message',
          sessionId,
          role,
          text: update.text,
          ...(cursor ? { cursor } : {}),
          channel,
        };
      }

      default:
        return { kind: 'v2_invalid_frame', reason: `unsupported_v2_update:${update.sessionUpdate}` };
    }
  }
}

/**
 * Controlled instantiation gate for ACP v2 Preview codec.
 * Refuses instantiation unless BOTH `allowV2Preview === true` AND handshake confirmed `protocolVersion === 2`
 * with v2 replay/state capabilities.
 */
export function createAcpV2PreviewCodec(gate: {
  readonly allowV2Preview: boolean;
  readonly negotiated: ParsedAcpInitializeCapabilities;
  readonly startInReplay?: boolean;
}): AcpV2PreviewProtocolCodec | null {
  if (
    !gate.allowV2Preview ||
    gate.negotiated.negotiatedProtocol !== 2 ||
    !gate.negotiated.v2SchemaConfirmed
  ) {
    return null;
  }
  return new AcpV2PreviewProtocolCodec({ startInReplay: gate.startInReplay });
}
