import type { InstallPluginRequest, PluginManifest } from '@harnessmate/protocol';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { daemonApi, type PluginPreview } from '../api/client';
import { useAppStore } from '../stores/app-store';

const field = 'min-w-0 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[var(--text-primary)]';
const button = 'cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-40';

export function PluginAuthoringForm({ initialManifest, previous, onInstalled }: {
  initialManifest: string;
  previous?: PluginManifest;
  onInstalled: () => void;
}) {
  const { workspaces, harnesses, sessions, selectedSessionId, selectedWorkspaceId, installPlugin } = useAppStore();
  const selected = sessions.find(({ id }) => id === selectedSessionId);
  const [workspaceId, setWorkspaceId] = useState(selected?.workspaceId ?? selectedWorkspaceId ?? workspaces[0]?.id ?? '');
  const [harnessId, setHarnessId] = useState(selected?.harnessId ?? harnesses.find((harness) => harness.health === 'ready')?.id ?? harnesses[0]?.id ?? '');
  const [model, setModel] = useState(selected?.model ?? '');
  const [description, setDescription] = useState('');
  const [manifestJson, setManifestJson] = useState(initialManifest);
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<{ result: PluginPreview; request: InstallPluginRequest }>();
  const [trustCode, setTrustCode] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const generation = useRef<AbortController | null>(null);
  useEffect(() => () => generation.current?.abort(), []);

  const availableModels = harnesses.find(({ id }) => id === harnessId)?.models ?? [];
  const resetPreview = () => {
    setPreview(undefined);
    setTrustCode(false);
    setError('');
  };

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try { await action(); }
    catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally { setBusy(''); }
  };

  const generate = () => run('正在生成草稿…', async () => {
    const controller = new AbortController();
    generation.current = controller;
    resetPreview();
    try {
      const { manifest } = await daemonApi.generatePlugin({
        description: description.trim(), harnessId, workspaceId, model: model || undefined, previous,
      }, controller.signal);
      setManifestJson(JSON.stringify(manifest, null, 2));
      const request = { mode: 'manifest', manifest } as const;
      const result = await daemonApi.previewPlugin(request);
      setPreview({ request, result });
    } finally { generation.current = null; }
  });

  const review = (origin: 'directory' | 'manifest') => run('正在校验插件…', async () => {
    resetPreview();
    const request: InstallPluginRequest = origin === 'directory'
      ? { mode: 'local_dir', dirPath: directory.trim() }
      : { mode: 'manifest', manifest: JSON.parse(manifestJson) };
    const result = await daemonApi.previewPlugin(request);
    setPreview({ request, result });
  });

  return (
    <div className="space-y-4 text-[12px] text-[var(--text-secondary)]">
      <section className="space-y-2 rounded-xl border border-[var(--border-hairline)] p-3">
        <h4 className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]"><Sparkles size={14} /> {previous ? `用 AI 修改 ${previous.name}` : '用 AI 制作插件'}</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          <select aria-label="工作区" className={field} value={workspaceId} disabled={!!busy} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">选择工作区</option>
            {workspaces.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="Harness" className={field} value={harnessId} disabled={!!busy} onChange={(event) => { setHarnessId(event.target.value); setModel(''); }}>
            <option value="">选择 Harness</option>
            {harnesses.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}
          </select>
          <select aria-label="模型" className={field} value={model} disabled={!!busy} onChange={(event) => setModel(event.target.value)}>
            <option value="">Harness 默认模型</option>
            {model && !availableModels.some(({ id }) => id === model) && <option value={model}>{model}</option>}
            {availableModels.map(({ id, displayName }) => <option key={id} value={id}>{displayName}</option>)}
          </select>
        </div>
        <textarea aria-label="插件需求" rows={3} value={description} maxLength={6000} disabled={!!busy}
          onChange={(event) => setDescription(event.target.value)} className={`${field} w-full`}
          placeholder="例如，添加一个面板展示当前任务的改动文件和测试结果，再加一个指令生成交付摘要。" />
        <button type="button" className={button} disabled={!!busy || !workspaceId || !harnessId || description.trim().length < 3}
          onClick={() => void generate()}>生成草稿</button>
        {busy === '正在生成草稿…' && <button type="button" className={`${button} ml-2`} onClick={() => generation.current?.abort()}>取消生成</button>}
      </section>
      <section className="space-y-2">
        <label htmlFor="plugin-manifest" className="font-medium text-[var(--text-primary)]">插件清单</label>
        <textarea id="plugin-manifest" value={manifestJson} rows={8} spellCheck={false} disabled={!!busy}
          className={`${field} font-mono-code w-full`}
          onChange={(event) => { setManifestJson(event.target.value); resetPreview(); }} />
        <button type="button" className={button} disabled={!!busy || !manifestJson.trim()} onClick={() => void review('manifest')}>校验并预览清单</button>
      </section>
      <section className="space-y-2">
        <label htmlFor="plugin-directory" className="font-medium text-[var(--text-primary)]">从本地目录导入</label>
        <div className="flex flex-wrap gap-2">
          <input id="plugin-directory" className={`${field} flex-1`} value={directory} disabled={!!busy} placeholder="包含 harnessmate-plugin.json 的目录"
            onChange={(event) => { setDirectory(event.target.value); resetPreview(); }} />
          {window.harnessMateBridge && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在选择目录…', async () => {
            const selectedDirectory = await window.harnessMateBridge?.pickDirectory();
            if (selectedDirectory) { setDirectory(selectedDirectory); resetPreview(); }
          })}><FolderOpen size={13} aria-label="选择目录" /></button>}
          <button type="button" className={button} disabled={!!busy || !directory.trim()} onClick={() => void review('directory')}>预览目录</button>
        </div>
      </section>
      {preview && (
        <section className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3">
          <h4 className="font-medium text-[var(--text-primary)]">{preview.result.manifest.name} · {preview.result.manifest.version}</h4>
          <p>{preview.result.manifest.description}</p>
          {preview.result.installedVersion && <p>已安装 {preview.result.installedVersion}。替换后可回退至此版本。</p>}
          <div className="flex flex-wrap gap-x-3">
            {preview.result.manifest.contributes.slashCommands?.map(({ command }) => <code key={command}>/{command}</code>)}
            {preview.result.manifest.contributes.panels?.map(({ id, title }) => <span key={id}>面板 {title}</span>)}
            {preview.result.manifest.contributes.dataPanels?.map(({ id, title, copySummary }) =>
              <span key={id}>数据面板 {title}{copySummary?.command && <> · /{copySummary.command}</>}</span>)}
            {preview.result.manifest.contributes.projections?.map(({ id, scope, events }) =>
              <span key={id}>{scope === 'workspace' ? '当前工作区' : '当前会话'} · {events.join(' / ')}</span>)}
            {preview.result.manifest.contributes.harnesses?.map(({ id, command }) => <span key={id}>ACP {id} · {command}</span>)}
            {preview.result.manifest.contributes.mcpPresets?.map(({ name, command, url }) => <span key={name}>MCP {name} · {command || url}</span>)}
            {preview.result.manifest.contributes.hooks?.map((hook) => <code key={hook}>{hook}</code>)}
          </div>
          {preview.result.manifest.entry && <label className="flex items-start gap-2">
            <input type="checkbox" checked={trustCode} onChange={(event) => setTrustCode(event.target.checked)} />
            <span>我信任此目录中的 JavaScript。入口 {preview.result.manifest.entry} 以本机用户权限运行。</span>
          </label>}
          <button type="button" className={`${button} bg-[var(--accent-indigo)] text-white`}
            disabled={!!busy || (Boolean(preview.result.manifest.entry) && !trustCode)}
            onClick={() => void run('正在安装插件…', async () => {
              const request = preview.request.mode === 'local_dir'
                ? { ...preview.request, expectedDigest: preview.result.digest, trustCode }
                : preview.request;
              await installPlugin(request);
              onInstalled();
            })}>{preview.result.installedVersion ? '替换并热加载' : '安装并热加载'}</button>
        </section>
      )}
      {(busy || error) && <p role={error ? 'alert' : 'status'} className={error ? 'text-[var(--accent-rose)]' : undefined}>{error || busy}</p>}
    </div>
  );
}
