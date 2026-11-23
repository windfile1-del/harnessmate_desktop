import type { InstalledPluginInfo, PluginPanelSnapshot, PluginTurnEvent } from '@harnessmate/protocol';

export const pluginEventLabels: Record<PluginTurnEvent, string> = {
  'turn.completed': '完成', 'turn.failed': '失败', 'turn.cancelled': '取消',
};

export function listPluginPanels(plugins: InstalledPluginInfo[]) {
  return plugins.flatMap((plugin) => plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE') ? (plugin.contributes.dataPanels ?? []).map((panel) => ({
    key: `${plugin.id}:${panel.id}`, pluginId: plugin.id, revision: plugin.packageDigest ?? plugin.version, panel,
  })) : []);
}

export type ActivePluginPanel = ReturnType<typeof listPluginPanels>[number];

export function formatPluginSummary(title: string, data: PluginPanelSnapshot) {
  const groups = new Map<string, string[]>();
  for (const row of data.counts) {
    const name = row.harnessId ?? '未知 Harness';
    const statuses = groups.get(name) ?? [];
    statuses.push(`${pluginEventLabels[row.event]} ${row.count}`);
    groups.set(name, statuses);
  }
  return [title, ...[...groups].map(([name, values]) => `${name} · ${values.join(' / ')}`),
    ...(groups.size === 0 ? ['暂无轮次记录'] : []),
  ].join('\n');
}
