import type { CanonicalEventType, ContextInjectionDriver, HarnessKind } from '@harnessmate/protocol';
import type { AdapterSessionHandle, ContextSyncPayload, TurnInput } from '../harnesses/types.js';
import type { CompiledContextPacket } from './context-compiler.js';

export async function dispatchTurn(
  handle: AdapterSessionHandle,
  harness: { id: string; kind: HarnessKind },
  turn: TurnInput,
  context: CompiledContextPacket | null,
  record: (type: CanonicalEventType, payload: Record<string, unknown>) => void,
): Promise<ContextInjectionDriver> {
  if (!context?.syncNeeded || turn.cliCommand) {
    await handle.sendTurn(turn);
    return 'native_warm';
  }
  const { snapshot, preview } = context;
  const attribution = { snapshotId: snapshot.snapshotId, targetHarnessId: harness.id, nativeSessionId: handle.nativeSessionId };
  let recordedDriver: ContextInjectionDriver | undefined;
  const payload: ContextSyncPayload = {
    deltaMarkdown: context.deltaMarkdown,
    codexInjectItems: context.codexInjectItems,
    objective: context.objective,
    isWarmBinding: preview.isWarmBinding,
    onDispatch(driver, content) {
      record('handoff.snapshot', {
        ...attribution, coveredUpToSeq: context.coveredUpToSeq, previousSnapshotId: snapshot.previousSnapshotId,
        sourceHarnesses: [...new Set(preview.deltaTurnSummary.map(({ harnessId }) => harnessId))],
        sections: snapshot.sections, driver, content,
      });
      recordedDriver = driver;
    },
  };
  const injected = harness.kind === 'codex' && handle.injectContext
    ? await handle.injectContext(payload) === 'codex_inject_items' : false;
  const result = await handle.sendTurn({ ...turn, contextSync: injected ? null : payload });
  const finalDriver = injected ? 'codex_inject_items' : (result?.driverUsed ?? 'prompt_envelope');
  if (recordedDriver === finalDriver) {
    record('handoff.snapshot_delivered', { ...attribution, driver: finalDriver, sectionHashes: snapshot.sectionHashes });
  }
  return finalDriver;
}
