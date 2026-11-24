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
    portableItems: context.portableItems,
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
  const injectedDriver = handle.injectContext && payload.portableItems.length > 0
    ? await handle.injectContext(payload)
    : null;
  const injected = injectedDriver !== null && injectedDriver !== 'prompt_envelope';
  const result = await handle.sendTurn({ ...turn, contextSync: injected ? null : payload });
  const finalDriver = injected ? injectedDriver : (result?.driverUsed ?? 'prompt_envelope');
  if (recordedDriver === finalDriver) {
    record('handoff.snapshot_delivered', { ...attribution, driver: finalDriver, sectionHashes: snapshot.sectionHashes });
  }
  return finalDriver;
}
