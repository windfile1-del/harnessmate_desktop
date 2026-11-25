import fs from 'node:fs';
import {
  asActivityId,
  type ActivityId,
  type RuntimeBinding,
} from '@harnessmate/protocol';
import type { NativeIngress } from '../../wiring/types.js';
import type { DynamicWorkflowObserver } from './observer.js';
import type { DynamicWorkflowIngestResult } from './types.js';

export interface DynamicWorkflowNdjsonEntry {
  readonly kind: string;
  readonly scenarioId?: string;
  readonly cliVersion?: string;
  readonly provenanceOrigin?: string;
  readonly channel?: 'live' | 'history_replay';
  readonly connectionId?: string;
  readonly ingressOrdinal?: number;
  readonly originSession?: string;
  readonly turnId?: string | null;
  readonly originActivityId?: string;
  readonly nowMs?: number;
  readonly frame?: unknown;
}

export interface DynamicWorkflowReplayReport {
  readonly scenarioMeta: DynamicWorkflowNdjsonEntry | null;
  readonly results: readonly DynamicWorkflowIngestResult[];
}

export function loadDynamicWorkflowNdjsonFixture(
  filePath: string,
): DynamicWorkflowNdjsonEntry[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as DynamicWorkflowNdjsonEntry);
}

export function replayDynamicWorkflowNdjson(
  observer: DynamicWorkflowObserver,
  binding: RuntimeBinding,
  entries: readonly DynamicWorkflowNdjsonEntry[],
  opts?: {
    readonly rootNativeSessionId?: string;
    readonly defaultActivityId?: ActivityId;
  },
): DynamicWorkflowReplayReport {
  let scenarioMeta: DynamicWorkflowNdjsonEntry | null = null;
  const results: DynamicWorkflowIngestResult[] = [];
  let seq = 0;

  for (const entry of entries) {
    if (entry.kind === 'scenario_meta') {
      scenarioMeta = entry;
      continue;
    }
    if (entry.kind !== 'wire_frame' || !entry.frame) {
      continue;
    }
    seq += 1;
    const envelope: NativeIngress = {
      binding,
      connectionId: entry.connectionId ?? 'conn_replay_np11',
      ingressOrdinal: entry.ingressOrdinal ?? seq,
      channel: entry.channel ?? 'live',
      ...(entry.originSession ? { originSession: entry.originSession } : {}),
      wire: entry.frame,
    };
    const res = observer.acceptFrame(envelope, {
      originActivityId: entry.originActivityId
        ? asActivityId(entry.originActivityId)
        : opts?.defaultActivityId,
      turnId: entry.turnId ?? null,
      rootNativeSessionId: opts?.rootNativeSessionId,
      nowMs: entry.nowMs,
    });
    results.push(res);
  }

  return { scenarioMeta, results };
}
