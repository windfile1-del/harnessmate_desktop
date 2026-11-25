import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeBinding } from '@harnessmate/protocol';
import type { NativeIngress } from '../wiring/types.js';
import type { NativeArtifactReviewTransportPort } from './contracts.js';

export interface AgyNp14NdjsonFrame {
  readonly schemaVersion: number;
  readonly captureId: string;
  readonly scenario: string;
  readonly channel: 'live' | 'history_replay';
  readonly connectionId: string;
  readonly ingressOrdinal: number;
  readonly wire: unknown;
}

export function loadNp14NdjsonFixture(fixturePath: string): AgyNp14NdjsonFrame[] {
  const raw = fs.readFileSync(fixturePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as AgyNp14NdjsonFrame);
}

export function toNativeIngressEnvelopes(
  binding: RuntimeBinding,
  frames: readonly AgyNp14NdjsonFrame[],
  originSession = 'native_sess_np14_fixture',
): NativeIngress[] {
  return frames.map((frame) => ({
    binding,
    connectionId: frame.connectionId,
    ingressOrdinal: frame.ingressOrdinal,
    channel: frame.channel,
    originSession,
    wire: frame.wire,
  }));
}

/**
 * Synthetic-only verified transport stub for T12 / T16 unit & replay tests.
 * Never used in production default wiring until live wire capture confirms schema.
 */
export function createSyntheticVerifiedReviewTransport(opts?: {
  readonly delayMs?: number;
  readonly onSubmit?: (input: {
    artifactId: string;
    requestId: string;
    decision: 'approve' | 'reject' | 'comment';
  }) => void;
}): NativeArtifactReviewTransportPort {
  let seq = 1;
  return {
    getWireSupportStatus() {
      return 'verified_live_wire';
    },
    async submitReviewAction(input) {
      if (opts?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      opts?.onSubmit?.({
        artifactId: input.artifactId,
        requestId: input.requestId,
        decision: input.decision,
      });
      return {
        accepted: true,
        state: 'response_written',
        receiptId: `rcpt_np14_syn_${seq++}`,
        reasonCode: `synthetic_verified_${input.decision}`,
      };
    },
  };
}

export function resolveNp14FixturePath(fileName: string): string {
  return path.resolve(process.cwd(), 'tests', 'fixtures', 'agy-np14', fileName);
}
