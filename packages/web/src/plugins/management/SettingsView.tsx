import { useEffect, useState, useRef } from 'react';
import type { PluginSettingsDescriptorV1 } from '@harnessmate/protocol';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { daemonApi } from '../../api/client';
import { useManagementStore } from './store';
const field = 'w-full rounded-lg border border-[var(--border-hairline)] bg-transparent p-2';
function SettingsEditor({ item, onSaved }: { item: PluginSettingsDescriptorV1; onSaved(): void }) {
  const [config, setConfig] = useState<Record<string, unknown>>(item.config);
  const [error, setError] = useState('');
  return <section className="space-y-3 rounded-xl border border-[var(--border-hairline)] p-4">
    <h3>{item.instanceId} · schema {item.schemaVersion}</h3>
    {Object.entries(item.settings).map(([key, schema]) => <label className="block" key={key}>{schema.description ?? key}
      {schema.type === 'boolean' ? <input type="checkbox" checked={Boolean(config[key] ?? schema.default)} onChange={e => setConfig({ ...config, [key]: e.target.checked })} />
        : schema.type === 'object' || schema.type === 'array' ? <textarea aria-label={key} className={field} defaultValue={JSON.stringify(config[key] ?? schema.default ?? (schema.type === 'array' ? [] : {}), null, 2)} onChange={e => { try { setConfig({ ...config, [key]: JSON.parse(e.target.value) }); setError(''); } catch { setError(key + ' JSON 无效'); } }} />
        : <input aria-label={key} className={field} type={schema.type === 'number' ? 'number' : 'text'} value={String(config[key] ?? schema.default ?? '')} onChange={e => setConfig({ ...config, [key]: schema.type === 'number' ? Number(e.target.value) : e.target.value })} />}
    </label>)}
    <details><summary>实例完整配置</summary><textarea className={field} aria-label={'完整配置 ' + item.instanceId} rows={7} defaultValue={JSON.stringify(config, null, 2)} onChange={e => { try { setConfig(JSON.parse(e.target.value)); setError(''); } catch { setError('配置 JSON 无效'); } }} /></details>
    <button disabled={!!error} onClick={() => void daemonApi.savePluginSettings(item.instanceId, { config, schemaVersion: item.schemaVersion, expectedVersion: item.version }).then(onSaved).catch(e => setError(String(e)))}>保存并应用</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function SettingsSurface({ bridge, harness, onRefresh = () => {} }: { onRefresh?: () => void; bridge: TrustedModulePageBridge; harness: ReturnType<typeof useManagementStore>['harnesses'][number] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current; if (!root) return;
    const handles: Array<{ dispose(): void }> = [];
    const mount = () => { for (const h of handles.splice(0)) h.dispose(); root.replaceChildren();
      for (const item of bridge.surfaces.listSlots('harness.settings', { matchKey: harness.driverId ?? harness.kind })) {
        const el = document.createElement('div'); root.append(el);
        handles.push(bridge.surfaces.mountSlotItem(el, { slot: 'harness.settings', instanceId: item.instanceId, slotId: item.id, props: { harness, onRefresh } }));
      }
    }; mount(); const off = bridge.surfaces.onSlotsChanged(mount);
    return () => { off(); for (const h of handles) h.dispose(); };
  }, [bridge, harness]);
  return <div ref={ref} />;
}
export function SettingsView({ bridge }: { bridge: TrustedModulePageBridge }) {
  const [items, setItems] = useState<PluginSettingsDescriptorV1[]>([]); const [error, setError] = useState('');
  const [host, setHost] = useState<{ port: number; dataRoot: string }>({ port: 4789, dataRoot: '' });
  const [settingsViews, setSettingsViews] = useState(() => bridge.contributions.query({ kind: 'settings' }));
  useEffect(() => bridge.contributions.subscribe(() => setSettingsViews(bridge.contributions.query({ kind: 'settings' }))), [bridge]);
  const [restart, setRestart] = useState<unknown>(); const { harnesses, refreshPlugins } = useManagementStore();
  const load = () => { void daemonApi.listPluginSettings().then(r => setItems(r.settings)).catch(e => setError(String(e))); };
  useEffect(() => { load(); void daemonApi.getHostConfig().then(setHost).catch(e => setError(String(e))); }, []);
  return <div className="space-y-4 p-5 text-sm">
    <h2>设置 · 按实例所有者保存</h2>
    <section className="space-y-2 rounded border p-3"><h3>宿主启动</h3>
      <label>监听端口<input type="number" value={host.port} onChange={e => setHost({ ...host, port: Number(e.target.value) })} className={field} /></label>
      <label>数据根<input value={host.dataRoot} onChange={e => setHost({ ...host, dataRoot: e.target.value })} className={field} /></label>
      <button onClick={() => void daemonApi.saveHostConfig(host).then(setRestart).catch(e => setError(String(e)))}>保存启动参数</button>
      {restart != null && <div><pre className="overflow-auto">{JSON.stringify(restart, null, 2)}</pre><p>退出当前进程后，按上方 executable / args / env 启动；数据根由启动环境选择。</p></div>}
    </section>
    {settingsViews.filter(view => view.owner.instanceId !== bridge.instanceId).map(view => <button key={view.key} onClick={() => void bridge.contributions.execute(view.key).then(result => { if (!result.ok) setError(result.message ?? result.code ?? '设置视图不可用'); }).catch(e => setError(String(e)))}>{view.title} · {view.owner.instanceId}</button>)}
    {items.map(item => <SettingsEditor key={item.instanceId + ':' + item.version} item={item} onSaved={() => { load(); void refreshPlugins(); }} />)}
    {harnesses.map(h => <section key={h.id}><h3>{h.displayName} · 自定义设置视图</h3><SettingsSurface bridge={bridge} harness={h} /></section>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
