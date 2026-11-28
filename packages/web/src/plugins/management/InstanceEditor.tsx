import { useEffect, useState } from 'react';
import { daemonApi } from '../../api/client';
import { useManagementStore } from './store';
export function InstanceEditor() {
  const [composition, setComposition] = useState<Awaited<ReturnType<typeof daemonApi.getPluginComposition>>>();
  const [id, setId] = useState(''); const [name, setName] = useState(''); const [config, setConfig] = useState('{}'); const [bindings, setBindings] = useState('{}'); const [error, setError] = useState('');
  const { refreshPlugins, workspaces, sessions } = useManagementStore();
  const [scope, setScope] = useState('composition'); const [scopeId, setScopeId] = useState(''); const [contract, setContract] = useState(''); const [target, setTarget] = useState('');
  const load = () => void daemonApi.getPluginComposition().then(setComposition).catch(e => setError(String(e)));
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await refreshPlugins(); load(); } catch (e) { setError(String(e)); } };
  return <div className="space-y-3 p-5 text-sm"><h2>实例、绑定与组合编辑</h2>
    <div className="flex flex-wrap gap-2">{composition?.entries.map(e => <button key={e.id} onClick={() => { setId(e.id); setName(e.name); setConfig(JSON.stringify(e.config ?? {}, null, 2)); setBindings(JSON.stringify(e.bindings ?? {}, null, 2)); }}>{e.id}</button>)}</div>
    <label>实例 ID<input aria-label="实例 ID" className="w-full border bg-transparent p-2" value={id} onChange={e => setId(e.target.value)} /></label>
    <label>包 ID<input aria-label="包 ID" className="w-full border bg-transparent p-2" value={name} onChange={e => setName(e.target.value)} /></label>
    <label>配置<textarea aria-label="实例配置" className="w-full border bg-transparent p-2" value={config} onChange={e => setConfig(e.target.value)} /></label>
    <label>依赖绑定<textarea aria-label="实例绑定" className="w-full border bg-transparent p-2" value={bindings} onChange={e => setBindings(e.target.value)} /></label>
    <button onClick={() => void run(() => daemonApi.upsertCompositionInstance({ id, name, config: JSON.parse(config), bindings: JSON.parse(bindings) }))}>保存实例</button>
    <button onClick={() => void run(() => daemonApi.removeCompositionInstance(id))}>移除实例</button>
    <h3>能力绑定</h3><select aria-label="绑定范围" value={scope} onChange={e => { setScope(e.target.value); setScopeId(''); }}><option value="composition">组合</option><option value="workspace">工作区</option><option value="session">会话</option></select>
    {scope !== 'composition' && <select aria-label="绑定目标范围" value={scopeId} onChange={e => setScopeId(e.target.value)}><option value="">选择</option>{(scope === 'workspace' ? workspaces : sessions).map(s => <option key={s.id} value={s.id}>{'name' in s ? s.name : s.title}</option>)}</select>}
    <input aria-label="契约" placeholder="契约" value={contract} onChange={e => setContract(e.target.value)} list="contracts" /><datalist id="contracts">{[...new Set(composition?.serviceProviders?.map(p => p.contract))].map(c => <option key={c}>{c}</option>)}</datalist>
    <input aria-label="提供实例" placeholder="提供实例，留空清除" value={target} onChange={e => setTarget(e.target.value)} />
    <button onClick={() => void run(() => scope === 'composition' ? daemonApi.setCompositionBinding(contract, target || null) : scope === 'workspace' ? daemonApi.setWorkspaceBinding(scopeId, contract, target || null) : daemonApi.setSessionBinding(scopeId, contract, target || null))}>保存绑定</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
