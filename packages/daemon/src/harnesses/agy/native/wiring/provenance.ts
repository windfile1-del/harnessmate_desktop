import type { AgyAuthMethod, AgyProfileConfig } from '@harnessmate/protocol';

/**
 * Unforgeable runtime token brand for verifying that a dispatch into a consumer-OAuth
 * AGY instance originated from a direct user action (or AGY's own native internal session)
 * rather than an automated external orchestrator, auto-failover loop, or plugin.
 */
const PROVENANCE_SEAL = Symbol('hm.agy.dispatch.provenance.seal');
const validProofs = new WeakSet<AgyDispatchProvenance>();

export type AgyDispatchChannel =
  | 'human_direct'
  | 'manual_user_switch'
  | 'agy_native_internal'
  | 'hm_orchestrator_delegation'
  | 'hm_orchestrator_wakeup'
  | 'auto_failover'
  | 'plugin_automated';

export interface AgyDispatchProvenance {
  readonly [PROVENANCE_SEAL]: true;
  readonly channel: AgyDispatchChannel;
  readonly actor: 'desktop' | 'mobile' | 'system' | 'plugin';
  readonly issuedAt: number;
  readonly reason?: string;
}

export interface AgyTargetDescriptor {
  readonly instanceId: string;
  readonly driverId: string;
  readonly authMethod?: AgyAuthMethod | string | null;
  readonly profile?: Pick<AgyProfileConfig, 'authMethod' | 'isolationMode'> | null;
}

export interface AgyConsumerProvenanceDecision {
  readonly allowed: boolean;
  readonly code?: 'CONSUMER_PROVENANCE_BLOCKED';
  readonly reason?: string;
  readonly channel: AgyDispatchChannel | 'unverified_forged';
}

export class AgyConsumerProvenanceError extends Error {
  readonly code = 'CONSUMER_PROVENANCE_BLOCKED' as const;
  readonly channel: AgyDispatchChannel | 'unverified_forged';

  constructor(message: string, channel: AgyDispatchChannel | 'unverified_forged') {
    super(message);
    this.name = 'AgyConsumerProvenanceError';
    this.channel = channel;
  }
}

/**
 * Mints a sealed, unforgeable provenance proof. Only trusted host entrypoints
 * (REST human turn/command handlers, manual switch handlers, orchestrator/failover guards)
 * may call this helper; plain objects crafted by callers or plugins fail verification.
 */
export function mintAgyDispatchProvenance(
  channel: AgyDispatchChannel,
  actor: AgyDispatchProvenance['actor'],
  reason?: string,
): AgyDispatchProvenance {
  const proof: AgyDispatchProvenance = Object.freeze({
    [PROVENANCE_SEAL]: true as const,
    channel,
    actor,
    issuedAt: Date.now(),
    ...(reason ? { reason } : {}),
  });
  validProofs.add(proof);
  return proof;
}

export function isVerifiedAgyDispatchProvenance(
  value: unknown,
): value is AgyDispatchProvenance {
  if (!value || typeof value !== 'object') return false;
  return (
    validProofs.has(value as AgyDispatchProvenance) &&
    (value as Partial<AgyDispatchProvenance>)[PROVENANCE_SEAL] === true
  );
}

/**
 * Returns true if the target harness instance is an AGY instance backed by a consumer
 * OAuth account (or default AGY whose auth method is not explicitly non-consumer API key /
 * enterprise agent-platform).
 */
export function isConsumerAgyTarget(target: AgyTargetDescriptor): boolean {
  if (target.driverId !== 'agy') return false;
  const authMethod = target.authMethod ?? target.profile?.authMethod ?? 'oauth-personal';
  return authMethod === 'oauth-personal';
}

const ALLOWED_CONSUMER_CHANNELS = new Set<AgyDispatchChannel>([
  'human_direct',
  'manual_user_switch',
  'agy_native_internal',
]);

/**
 * Central consumer provenance guard (Risk R-07, Decision D07):
 * - Non-AGY targets and non-consumer AGY targets (e.g. gemini-api-key, agent-platform, oauth-business)
 *   are not blocked by the consumer OAuth policy.
 * - Consumer OAuth AGY targets ONLY allow verified `human_direct`, `manual_user_switch`, or
 *   `agy_native_internal` provenance.
 * - Any forged/unsealed provenance object, HM orchestrator auto-delegation, auto-failover,
 *   or automated plugin dispatch is strictly denied.
 */
export function evaluateAgyConsumerProvenance(
  target: AgyTargetDescriptor,
  provenance: unknown,
): AgyConsumerProvenanceDecision {
  if (!isConsumerAgyTarget(target)) {
    const channel = isVerifiedAgyDispatchProvenance(provenance)
      ? provenance.channel
      : 'unverified_forged';
    return { allowed: true, channel };
  }

  if (!isVerifiedAgyDispatchProvenance(provenance)) {
    return {
      allowed: false,
      code: 'CONSUMER_PROVENANCE_BLOCKED',
      channel: 'unverified_forged',
      reason:
        '合规护栏：无法验证个人 AGY 账号请求来源（仅允许用户直接发起或原生 AGY 内部工作流）。',
    };
  }

  if (ALLOWED_CONSUMER_CHANNELS.has(provenance.channel)) {
    return { allowed: true, channel: provenance.channel };
  }

  switch (provenance.channel) {
    case 'hm_orchestrator_delegation':
      return {
        allowed: false,
        code: 'CONSUMER_PROVENANCE_BLOCKED',
        channel: provenance.channel,
        reason:
          '合规护栏：禁止通过 HarnessMate 多引擎编排器将个人 OAuth AGY 实例作为后台子 Worker 自动委派。请由用户直接开启 AGY 会话或使用 AGY 原生子代理/工作流。',
      };
    case 'hm_orchestrator_wakeup':
      return {
        allowed: false,
        code: 'CONSUMER_PROVENANCE_BLOCKED',
        channel: provenance.channel,
        reason:
          '合规护栏：禁止通过外部编排器自动向个人 OAuth AGY 会话注入汇总唤醒轮次。',
      };
    case 'auto_failover':
      return {
        allowed: false,
        code: 'CONSUMER_PROVENANCE_BLOCKED',
        channel: provenance.channel,
        reason:
          '合规护栏：禁止自动故障转移或额度轮换至个人 OAuth AGY 实例，请由用户手动一键切换。',
      };
    case 'plugin_automated':
      return {
        allowed: false,
        code: 'CONSUMER_PROVENANCE_BLOCKED',
        channel: provenance.channel,
        reason:
          '合规护栏：禁止插件在未经用户直接发起的情况下向个人 OAuth AGY 实例派发任务。',
      };
    default:
      return {
        allowed: false,
        code: 'CONSUMER_PROVENANCE_BLOCKED',
        channel: provenance.channel,
        reason: '合规护栏：个人 OAuth AGY 实例仅允许受控的用户直接交互来源。',
      };
  }
}

export function assertAgyConsumerProvenance(
  target: AgyTargetDescriptor,
  provenance: unknown,
): void {
  const decision = evaluateAgyConsumerProvenance(target, provenance);
  if (!decision.allowed) {
    throw new AgyConsumerProvenanceError(
      decision.reason ?? 'Consumer AGY dispatch blocked by provenance policy',
      decision.channel,
    );
  }
}
