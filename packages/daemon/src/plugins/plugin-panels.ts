import type { PluginDataPanel, PluginPanelQuery, PluginPanelSnapshot, PluginProjection, Session } from '@harnessmate/protocol';
import { readRecordedTurnEvidence } from '../core/task-ledger-service.js';
import type { HarnessMateStore } from '../db/sqlite.js';

export function readPluginPanel(
  store: HarnessMateStore,
  session: Session,
  panel: PluginDataPanel,
  projection: PluginProjection,
  query: PluginPanelQuery,
): PluginPanelSnapshot {
  const pageSize = 25;
  const { rows, counts, total } = store.readPluginTurns(session, projection, query, pageSize);
  const showFiles = panel.columns.some(({ field }) => field === 'changed_files');
  const showVerifications = panel.columns.some(({ field }) => field === 'verifications');
  const directories = new Map([[session.id, session.cwd]]);
  return {
    scope: projection.scope, counts, total, pageSize,
    rows: rows.map(({ imported, ...row }) => {
      const base = { ...row, imported: Boolean(imported) };
      if (!showFiles && !showVerifications) return base;
      if (!directories.has(row.sessionId)) directories.set(row.sessionId, store.getSession(row.sessionId)!.cwd);
      const events = store.getPluginTurnToolEvents(row.sessionId, row.turnId, row.seq);
      const evidence = readRecordedTurnEvidence(events, directories.get(row.sessionId)!);
      return { ...base, ...(showFiles && { files: evidence.files }),
        ...(showVerifications && { verifications: evidence.verifications }) };
    }),
  };
}
