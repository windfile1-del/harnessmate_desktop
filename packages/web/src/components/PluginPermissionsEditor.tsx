import type { InstalledPluginInfo, PluginPermission } from '@harnessmate/protocol';
import { useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

export function PluginPermissionsEditor({ plugin, onClose }: { plugin: InstalledPluginInfo; onClose: () => void }) {
  const { workspaces, sessions, selectedSessionId, selectedWorkspaceId, invalidatePluginPermissions } = useAppStore();
  const [workspaceId, setWorkspaceId] = useState(sessions.find(({ id }) => id === selectedSessionId)?.workspaceId
    ?? selectedWorkspaceId ?? workspaces[0]?.id ?? '');
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

  const update = async (permission: PluginPermission, granted: boolean) => {
    setSaving(true);
    setError('');
    try {
      const result = await daemonApi.setPluginPermission(plugin.id, { workspaceId,
        digest: permission.digest, capability: permission.capability, granted });
      setPermissions(result.permissions);
      invalidatePluginPermissions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return <section className="space-y-2 rounded-xl border border-[var(--border-hairline)] p-3 text-[12px]" aria-label="插件工作区授权">
    <div className="flex items-center justify-between gap-2">
      <h4 className="font-medium">{plugin.name} · 工作区授权</h4>
      <button type="button" className="rounded px-2 py-1 hover:bg-[var(--bg-hover)]" onClick={onClose}>关闭</button>
    </div>
    <select aria-label="授权工作区" disabled={saving} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}
      className="max-w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1.5">
      <option value="">选择工作区</option>
      {workspaces.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
    </select>
    <p className="text-[var(--text-secondary)]">授权适用于 {plugin.version} 的当前安装内容。模型工具将在会话下一轮更新。</p>
    {workspaceId && !permissions && !error && <p role="status">正在读取授权…</p>}
    {permissions?.length === 0 && <p>此插件版本暂无可授权的能力。</p>}
    {permissions?.map((permission) => {
      const [kind, id] = permission.capability.split(':');
      const label = kind === 'action' ? `/${id}` : `模型工具 ${id}`;
      return <label key={permission.capability} className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--border-hairline)] p-2">
        <input type="checkbox" aria-label={`授权 ${label}`} checked={permission.granted} disabled={saving}
          onChange={(event) => void update(permission, event.target.checked)} />
        <span><span className="font-medium">{label}</span><span className="ml-2 text-[var(--text-secondary)]">{permission.description}</span></span>
      </label>;
    })}
    {error && <p role="alert" className="text-[var(--accent-rose)]">{error}</p>}
  </section>;
}
