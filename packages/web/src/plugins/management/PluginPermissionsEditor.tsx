import type { InstalledPluginInfo, PluginPermission } from '@harnessmate/protocol';
import { useEffect, useState } from 'react';
import { daemonApi } from '../../api/client';
import { useManagementStore as useAppStore } from './store';

const RISK_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

function formatCapabilityLabel(capability: string): string {
  if (capability.startsWith('action:')) return `/${capability.slice(7)}`;
  if (capability.startsWith('tool:')) return `模型工具 ${capability.slice(5)}`;
  if (capability.startsWith('service:provide:')) return `服务提供方 ${capability.slice('service:provide:'.length)}`;
  if (capability.startsWith('net:')) return `网络 ${capability.slice(4)}`;
  return capability;
}

export function PluginPermissionsEditor({ plugin, onClose }: { plugin: InstalledPluginInfo; onClose: () => void }) {
  const { workspaces, sessions, selectedSessionId, selectedWorkspaceId, invalidatePluginPermissions, refreshPlugins } = useAppStore();
  const [workspaceId, setWorkspaceId] = useState(
    sessions.find(({ id }) => id === selectedSessionId)?.workspaceId
    ?? selectedWorkspaceId ?? workspaces[0]?.id ?? '__global__',
  );
  const [coverFuture, setCoverFuture] = useState(false);
  const [permissions, setPermissions] = useState<PluginPermission[]>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPermissions(undefined);
    setError('');
    if (!workspaceId) return;
    let current = true;
    void daemonApi.listPluginPermissions(plugin.id, workspaceId).then((result) => {
      if (current) setPermissions(result.permissions);
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [plugin.id, plugin.packageDigest, workspaceId]);

  const update = async (permission: PluginPermission, granted: boolean, nextCoverFuture?: boolean) => {
    setSaving(true);
    setError('');
    try {
      const result = await daemonApi.setPluginPermission(plugin.id, {
        workspaceId,
        digest: permission.digest,
        capability: permission.capability,
        granted,
        coverFuture: nextCoverFuture ?? (granted ? coverFuture : false),
      });
      setPermissions(result.permissions);
      invalidatePluginPermissions();
      if (permission.capability.startsWith('service:provide:')) {
        void refreshPlugins();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return <section className="space-y-2 rounded-xl border border-[var(--border-hairline)] p-3 text-[12px]" aria-label="插件工作区授权">
    <div className="flex items-center justify-between gap-2">
      <h4 className="font-medium">{plugin.name} · 权限与工作区授权</h4>
      <button type="button" className="rounded px-2 py-1 hover:bg-[var(--bg-hover)]" onClick={onClose}>关闭</button>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="授权工作区" disabled={saving} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}
        className="max-w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1.5">
        <option value="__global__">全局权限</option>
        {workspaces.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
        <input type="checkbox" checked={coverFuture} disabled={saving} onChange={(event) => setCoverFuture(event.target.checked)} />
        <span>覆盖后续版本（权限不增加时自动沿用）</span>
      </label>
    </div>
    <p className="text-[var(--text-secondary)]">授权绑定 {plugin.version} 的包摘要，宿主升级不失效。模型工具在会话下一轮生效。</p>
    {workspaceId && !permissions && !error && <p role="status">正在读取授权…</p>}
    {permissions?.length === 0 && <p>此插件版本暂无可授权的能力。</p>}
    {permissions?.map((permission) => {
      const label = formatCapabilityLabel(permission.capability);
      return <label key={permission.capability} className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border-hairline)] p-2">
        <input type="checkbox" aria-label={`授权 ${label}`} checked={permission.granted} disabled={saving}
          onChange={(event) => void update(permission, event.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{label}</span>
          {permission.risk && (
            <span className="ml-1.5 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
              {RISK_LABEL[permission.risk]}
            </span>
          )}
          {permission.scope === 'global' && (
            <span className="ml-1 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]">全局</span>
          )}
          {permission.coverFuture && permission.granted && (
            <span className="ml-1 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--accent-emerald)]">覆盖后续版本</span>
          )}
          {permission.inheritedFromDigest && (
            <span className="ml-1 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">已沿用</span>
          )}
          <span className="ml-2 text-[var(--text-secondary)]">{permission.description}</span>
        </span>
      </label>;
    })}
    {error && <p role="alert" className="text-[var(--accent-rose)]">{error}</p>}
  </section>;
}
