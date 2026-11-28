import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PluginDataPanel as PanelDefinition, PluginPanelField, PluginPanelQuery, PluginPanelSnapshot, PluginTurnEvent, PluginTurnRow } from '@harnessmate/protocol';
import { daemonApi } from '../api/client';
import { formatPluginSummary, pluginEventLabels, type ActivePluginPanel } from '../lib/plugin-panels';
import { useAppStore } from '../stores/app-store';

import { PluginPanelView } from './PluginPanelView';
export { PluginPanelView } from './PluginPanelView';

export function PluginDataPanel({ sessionId, contribution }: { sessionId: string; contribution: ActivePluginPanel }) {
  const { pluginId, panel } = contribution;
  const { selectSession, focusTurn, pushToast } = useAppStore();
  const loadSnapshot = useCallback((query: PluginPanelQuery, signal: AbortSignal) =>
    daemonApi.getPluginPanel(sessionId, pluginId, panel.id, query, signal), [sessionId, pluginId, panel.id]);
  const onOpenTurn = async (row: PluginTurnRow) => {
    if (row.sessionId !== sessionId) await selectSession(row.sessionId);
    if (useAppStore.getState().selectedSessionId === row.sessionId) focusTurn(row);
  };
  const copySummary = async (data: PluginPanelSnapshot) => {
    try {
      await navigator.clipboard.writeText(formatPluginSummary(panel.title, data));
      pushToast({ kind: 'success', title: '已复制轮次摘要' });
    } catch (err) {
      pushToast({ kind: 'error', title: '复制失败', body: err instanceof Error ? err.message : String(err) });
    }
  };
  return <PluginPanelView panel={panel} loadSnapshot={loadSnapshot} refreshInterval={4_000}
    onOpenTurn={onOpenTurn} onCopySummary={copySummary} />;
}
