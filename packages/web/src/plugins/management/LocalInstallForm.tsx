import { useState } from 'react';
import { daemonApi, type PluginPreview } from '../../api/client';
import type { InstallPluginRequest } from '@harnessmate/protocol';
import { useManagementStore } from './store';
export function LocalInstallForm({ initialManifest, onInstalled }: { initialManifest: string; onInstalled(): void }) {
  const { installPlugin } = useManagementStore();
  const [directory, setDirectory] = useState(''); const [manifest, setManifest] = useState(initialManifest);
  const [preview, setPreview] = useState<{ value: PluginPreview; request: InstallPluginRequest }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <section className="space-y-3 text-sm">
    <label>插件目录<input aria-label="插件目录" value={directory} onChange={e => { setDirectory(e.target.value); setPreview(undefined); }} className="w-full rounded border bg-transparent p-2" /></label>
    <button onClick={() => void window.harnessMateBridge?.pickDirectory().then(p => { if (p) { setDirectory(p); setPreview(undefined); } })}>选择目录</button>
    <details><summary>或编辑声明式清单</summary><textarea aria-label="插件清单" rows={10} value={manifest} onChange={e => { setManifest(e.target.value); setPreview(undefined); }} className="w-full bg-transparent" /></details>
    <button disabled={busy} onClick={() => void run(async () => { const request: InstallPluginRequest = directory.trim() ? { mode: 'local_dir', dirPath: directory.trim() } : { mode: 'manifest', manifest: JSON.parse(manifest) }; setPreview({ request, value: await daemonApi.previewPlugin(request) }); })}>预览安装</button>
    {preview && <div><pre>{JSON.stringify({ name: preview.value.manifest.name, digest: preview.value.digest, permissions: preview.value.manifest.permissions }, null, 2)}</pre>
      <button disabled={busy} onClick={() => void run(async () => { if (preview.value.requiresTrust && !window.confirm('信任该来源并安装 ' + preview.value.manifest.name + '？')) return; await installPlugin({ ...preview.request, expectedDigest: preview.value.digest, expectedInstalledDigest: preview.value.installedDigest, trustCode: preview.value.requiresTrust }); onInstalled(); })}>确认安装</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
