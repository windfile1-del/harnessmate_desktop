import type { EffectOutboxRecord } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';

export type EffectHandler = (effect: EffectOutboxRecord) => Promise<void>;

export interface EffectOutboxWorkerOptions {
  maxAttempts?: number;
}

/**
 * Lightweight transactional outbox worker modeled on T3 Code's EffectWorker.
 * - `PROCESS_BOUND` effects are cancelled on crash recovery and never replayed across dead processes.
 * - `REPLAY_SAFE` effects are drained idempotently with bounded retry attempts.
 */
export class EffectOutboxWorker {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly maxAttempts: number;
  private draining = false;

  constructor(
    private readonly store: HarnessMateStore,
    opts: EffectOutboxWorkerOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  }

  registerHandler(effectType: string, handler: EffectHandler): () => void {
    this.handlers.set(effectType, handler);
    return () => {
      if (this.handlers.get(effectType) === handler) {
        this.handlers.delete(effectType);
      }
    };
  }

  async drainOnce(limit = 32): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.draining) return { processed: 0, succeeded: 0, failed: 0 };
    this.draining = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const batch = this.store.claimPendingOutboxEffects(limit);
      for (const effect of batch) {
        processed += 1;
        const handler = this.handlers.get(effect.effectType);
        if (!handler) {
          this.store.failOutboxEffect(
            effect.effectId,
            `No outbox handler registered for effectType "${effect.effectType}"`,
            false,
          );
          failed += 1;
          continue;
        }
        try {
          await handler(effect);
          this.store.completeOutboxEffect(effect.effectId);
          succeeded += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const retryable = effect.durability === 'REPLAY_SAFE' && effect.attempts < this.maxAttempts;
          this.store.failOutboxEffect(effect.effectId, message, retryable);
          failed += 1;
        }
      }
      return { processed, succeeded, failed };
    } finally {
      this.draining = false;
    }
  }
}
