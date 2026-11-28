import { useEffect, useState } from 'react';
import { PluginManifestSchema, type DeveloperTaskV1 } from '@harnessmate/protocol';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { daemonApi } from '../../api/client';
import { PluginAuthoringForm } from './PluginAuthoringForm';
import { PluginDevPanel } from './PluginDevPanel';
import { useManagementStore } from '../management/store';
export function DeveloperToolsApp({ bridge }: { bridge: TrustedModulePageBridge }) {
  const { plugins } = useManagementStore(); const [tasks, setTasks] = useState<DeveloperTaskV1[]>([]); const [error, setError] = useState('');
  useEffect(() => { let alive = true; const poll = () => void daemonApi.developerRoute<{ tasks: DeveloperTaskV1[] }>('/tasks', undefined, bridge.instanceId).then(r => { if (alive) setTasks(r.tasks); }).catch(e => { if (alive) setError(String(e)); }); poll(); const timer = setInterval(poll, 1500); return () => { alive = false; clearInterval(timer); }; }, [bridge.instanceId]);
  const editingInput = bridge.props.editing as { manifest?: unknown; digest?: string } | undefined;
  const checked = PluginManifestSchema.safeParse(editingInput?.manifest);
  const editing = checked.success && editingInput?.digest ? { manifest: checked.data, digest: editingInput.digest } : undefined;
  return <main className="h-full overflow-auto space-y-4 p-5 text-sm" data-developer-instance={bridge.instanceId}>
    <h1>AI 插件开发工具</h1>
    <PluginAuthoringForm key={editing?.digest ?? 'new'} editing={editing} initialManifest={editing ? JSON.stringify(editing.manifest) : '{}'} initialTier="tier2" onInstalled={() => {}} />
    <details><summary>开发目录、脚手架与热加载</summary><PluginDevPanel plugins={plugins} onOpenLogs={id => void bridge.toast('插件日志', id)} /></details>
    <section><h2>可恢复任务</h2>{tasks.map(task => <article key={task.taskId} className="my-2 rounded border p-3"><div>{task.taskId} · {task.status}</div>
      {task.error && <p role="alert">{task.error}</p>}
      {task.status === 'running' && <button onClick={() => void daemonApi.developerRoute('/tasks/' + task.taskId + '/cancel', { method: 'POST', body: '{}' }, bridge.instanceId)}>取消生成</button>}
      {task.result && <details><summary>文件和构建诊断</summary><pre className="overflow-auto">{JSON.stringify(task.result, null, 2)}</pre></details>}
      {task.status === 'completed' && task.result?.digest != null && <button onClick={() => void daemonApi.installPluginV2({ draftId: String(task.result!.draftId), expectedDigest: String(task.result!.digest), installMode: 'dev_link', trustCode: window.confirm('首次安装请确认信任此生成来源；同源热加载沿用已授权信任。') }, bridge.instanceId).then(() => bridge.kernel.refreshPlugins()).catch(e => setError(String(e)))}>安装此开发修订</button>}
    </article>)}</section>{error && <p role="alert">{error}</p>}
  </main>;
}
