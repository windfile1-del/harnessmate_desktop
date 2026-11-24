import type {
  BuilderV2Result,
  InstallPluginRequest,
  PluginBuilderInstallMode,
  PluginBuilderTemplate,
  PluginBuilderTier,
  PluginManifest,
} from '@harnessmate/protocol';
import { FolderOpen, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { daemonApi, type PluginPreview } from '../api/client';
import { useAppStore } from '../stores/app-store';
import { PluginBuilderV2Review, PluginDraftReview } from './PluginDraftReview';

const field = 'min-w-0 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[var(--text-primary)]';
const button = 'cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-40';

type DraftInstallRequest = Exclude<InstallPluginRequest, { mode: 'catalog' }>;

export function PluginAuthoringForm({ initialManifest, editing, initialTier, onInstalled }: {
  initialManifest: string;
  editing?: { manifest: PluginManifest; digest: string };
  initialTier?: PluginBuilderTier;
  onInstalled: () => void;
}) {
  const { workspaces, harnesses, sessions, selectedSessionId, selectedWorkspaceId, installPlugin, refreshPlugins } = useAppStore();
  const selected = sessions.find(({ id }) => id === selectedSessionId);
  const [workspaceId, setWorkspaceId] = useState(selected?.workspaceId ?? selectedWorkspaceId ?? workspaces[0]?.id ?? '');
  const [harnessId, setHarnessId] = useState(selected?.harnessId ?? harnesses.find((harness) => harness.health === 'ready')?.id ?? harnesses[0]?.id ?? '');
  const [model, setModel] = useState(selected?.model ?? '');
  const [description, setDescription] = useState('');
  const [builderTier, setBuilderTier] = useState<PluginBuilderTier>(initialTier ?? (editing ? 'tier1' : 'auto'));
  const [builderTemplate, setBuilderTemplate] = useState<PluginBuilderTemplate>('isolated');
  const [manifestJson, setManifestJson] = useState(initialManifest);
  const [directory, setDirectory] = useState('');
  const [preview, setPreview] = useState<{ result: PluginPreview; request: DraftInstallRequest }>();
  const [builderV2Result, setBuilderV2Result] = useState<BuilderV2Result | null>(null);
  const [installModeV2, setInstallModeV2] = useState<PluginBuilderInstallMode>('local_install');
  const [editingDigest, setEditingDigest] = useState<string | null>(editing?.digest ?? null);
  const [trustCode, setTrustCode] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const generation = useRef<AbortController | null>(null);
  useEffect(() => () => generation.current?.abort(), []);

  const availableModels = harnesses.find(({ id }) => id === harnessId)?.models ?? [];
  const resetPreview = () => {
    setPreview(undefined);
    setBuilderV2Result(null);
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

  const readDraft = () => {
    let manifest: PluginManifest;
    try { manifest = JSON.parse(manifestJson); }
    catch { throw new Error('插件清单的 JSON 格式无效'); }
    if (editing && manifest?.id !== editing.manifest.id) throw new Error('修改插件时必须保留原插件 ID');
    return manifest;
  };

  const generate = () => run('正在生成插件…', async () => {
    const previous = manifestJson.trim() && manifestJson !== initialManifest ? readDraft() : undefined;
    const controller = new AbortController();
    generation.current = controller;
    resetPreview();
    try {
      // Preserve legacy Tier 1 endpoint cleanly when editing or explicitly Tier 1
      if (editing && builderTier === 'tier1') {
        const { manifest } = await daemonApi.generatePlugin({
          description: description.trim(),
          harnessId,
          workspaceId,
          model: model || undefined,
          previous,
          editing: editing && editingDigest ? { id: editing.manifest.id, digest: editingDigest } : undefined,
        }, controller.signal);
        setManifestJson(JSON.stringify(manifest, null, 2));
        const request = {
          mode: 'manifest',
          manifest,
          expectedInstalledDigest: editing ? editingDigest : undefined,
        } as const;
        const result = await daemonApi.previewPlugin(request);
        setPreview({ request, result });
        return;
      }

      const v2Result = await daemonApi.generatePluginV2({
        description: description.trim(),
        harnessId,
        workspaceId,
        model: model || undefined,
        tier: builderTier,
        ...(builderTier === 'tier2' ? { template: builderTemplate } : {}),
        previous: previous as Record<string, unknown> | undefined,
        maxAttempts: 3,
      }, controller.signal);

      if (v2Result.tierUsed === 'tier1' && v2Result.manifest) {
        const manifest = v2Result.manifest as unknown as PluginManifest;
        setManifestJson(JSON.stringify(manifest, null, 2));
        const request = {
          mode: 'manifest',
          manifest,
          expectedInstalledDigest: editing ? editingDigest : undefined,
        } as const;
        const result = await daemonApi.previewPlugin(request);
        setPreview({ request, result });
        return;
      }

      if (v2Result.manifest) {
        setManifestJson(JSON.stringify(v2Result.manifest, null, 2));
      }
      setBuilderV2Result(v2Result);
    } finally { generation.current = null; }
  });

  const review = (origin: 'directory' | 'manifest') => run('正在校验插件…', async () => {
    resetPreview();
    const request: DraftInstallRequest = origin === 'directory'
      ? { mode: 'local_dir', dirPath: directory.trim() }
      : { mode: 'manifest', manifest: readDraft() };
    const result = await daemonApi.previewPlugin(request);
    if (editing) setEditingDigest(result.installedDigest);
    setPreview({ request, result });
  });

  const installV2 = () => run('正在安装验证通过的插件…', async () => {
    if (!builderV2Result?.digest) throw new Error('缺少已验证插件包摘要');
    await daemonApi.installPluginV2({
      draftId: builderV2Result.draftId,
      files: builderV2Result.files,
      expectedDigest: builderV2Result.digest,
      trustCode,
      installMode: installModeV2,
    });
    await refreshPlugins();
    onInstalled();
  });

  return (
    <div className="space-y-4 text-[12px] text-[var(--text-secondary)]">
      <section className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] p-3">
        <h4 className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <Sparkles size={14} />
          {editing ? `用 AI 修改 ${editing.manifest.name}` : 'AI Plugin Builder v2 · 用自然语言生成插件'}
        </h4>

        {/* Tier 1 / Tier 2 Mode Switcher + Template Selector */}
        {!editing && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">生成模式（两级架构）</span>
              <select
                aria-label="Builder 模式"
                data-testid="builder-tier-select"
                className={`${field} w-full`}
                value={builderTier}
                disabled={!!busy}
                onChange={(e) => setBuilderTier(e.target.value as PluginBuilderTier)}
              >
                <option value="auto">Auto · 自动分类（声明式 vs 代码工程）</option>
                <option value="tier1">Tier 1 · 声明式快速草稿（斜杠命令 / 面板）</option>
                <option value="tier2">Tier 2 · 完整代码插件工程（4 步沙箱验证）</option>
              </select>
            </label>
            {builderTier === 'tier2' && (
              <label className="space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">Tier 2 代码模板</span>
                <select
                  aria-label="Tier 2 模板"
                  data-testid="builder-template-select"
                  className={`${field} w-full`}
                  value={builderTemplate}
                  disabled={!!busy}
                  onChange={(e) => setBuilderTemplate(e.target.value as PluginBuilderTemplate)}
                >
                  <option value="isolated">isolated · 隔离代码 + 沙箱 UI 插槽</option>
                  <option value="ui-slot">ui-slot · 纯沙箱 HTML UI 插槽</option>
                  <option value="service">service · 第三方服务提供方 (provides)</option>
                  <option value="harness-adapter">harness-adapter · 第三方 Harness Adapter 驱动</option>
                </select>
              </label>
            )}
          </div>
        )}

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

        <textarea aria-label="插件需求" rows={3} value={description} maxLength={8000} disabled={!!busy}
          onChange={(event) => setDescription(event.target.value)} className={`${field} w-full`}
          placeholder={
            builderTier === 'tier2'
              ? '例如：为本地 CLI 引擎创建一个 Harness Adapter 插件，并附加 chat.block 状态卡片与 harness.settings 配置面板。'
              : '例如：添加一个斜杠命令 /delivery 和数据面板；或描述外部 API / 沙箱 UI / Harness 适配器需求自动升级为 Tier 2 代码工程。'
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="builder-generate-btn" className={button} disabled={!!busy || !workspaceId || !harnessId || description.trim().length < 3}
            onClick={() => void generate()}>
            {builderTier === 'tier2'
              ? '生成并沙箱验证代码插件'
              : manifestJson.trim() && manifestJson !== initialManifest
                ? '继续修改草稿'
                : '生成插件'}
          </button>
          {busy === '正在生成插件…' && (
            <button type="button" className={button} onClick={() => generation.current?.abort()}>取消生成</button>
          )}
        </div>
      </section>

      {builderV2Result && (
        <PluginBuilderV2Review
          result={builderV2Result}
          trustCode={trustCode}
          onTrustCodeChange={setTrustCode}
          installMode={installModeV2}
          onInstallModeChange={setInstallModeV2}
          installing={busy === '正在安装验证通过的插件…'}
          onInstall={() => void installV2()}
        />
      )}

      <section className="space-y-2">
        <label htmlFor="plugin-manifest" className="font-medium text-[var(--text-primary)]">插件清单</label>
        <textarea id="plugin-manifest" value={manifestJson} rows={8} spellCheck={false} disabled={!!busy}
          className={`${field} font-mono-code w-full`}
          onChange={(event) => { setManifestJson(event.target.value); resetPreview(); }} />
        <button type="button" className={button} disabled={!!busy || !manifestJson.trim()} onClick={() => void review('manifest')}>校验并预览清单</button>
      </section>

      {!editing && <section className="space-y-2">
        <label htmlFor="plugin-directory" className="font-medium text-[var(--text-primary)]">从本地目录导入</label>
        <div className="flex flex-wrap gap-2">
          <input id="plugin-directory" className={`${field} flex-1`} value={directory} disabled={!!busy} placeholder="包含 harnessmate-plugin.json 的目录"
            onChange={(event) => { setDirectory(event.target.value); resetPreview(); }} />
          {typeof window !== 'undefined' && window.harnessMateBridge && <button type="button" className={button} disabled={!!busy} onClick={() => void run('正在选择目录…', async () => {
            const selectedDirectory = await window.harnessMateBridge?.pickDirectory();
            if (selectedDirectory) { setDirectory(selectedDirectory); resetPreview(); }
          })}><FolderOpen size={13} aria-label="选择目录" /></button>}
          <button type="button" className={button} disabled={!!busy || !directory.trim()} onClick={() => void review('directory')}>预览目录</button>
        </div>
      </section>}

      {preview && (
        <section className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3">
          <h4 className="font-medium text-[var(--text-primary)]">{preview.result.manifest.name} · {preview.result.manifest.version}</h4>
          <p>{preview.result.manifest.description}</p>
          {preview.result.installedVersion && <p>已安装 {preview.result.installedVersion} → 草稿 {preview.result.manifest.version}。替换后可回退至已安装版本。</p>}
          {preview.result.installedEnabled === false && <p>该插件当前停用。安装后可在已安装列表启用。</p>}
          {Boolean(preview.result.missingServices?.length) && <p>安装后等待服务 · {preview.result.missingServices?.join('、')}</p>}
          <PluginDraftReview preview={preview.result} workspaceId={workspaceId} />
          {preview.result.requiresTrust && <label className="flex items-start gap-2">
            <input type="checkbox" checked={trustCode} onChange={(event) => setTrustCode(event.target.checked)} />
            <span>我信任此插件包。
              {preview.result.manifest.entry && `JavaScript 入口 ${preview.result.manifest.entry} 以本机用户权限运行。`}
              {preview.result.manifest.contributes.harnesses?.map(({ id, command, args }) => ` ${id} 将启动 ${[command, ...args].join(' ')}。`)}
              {preview.result.manifest.contributes.mcpPresets?.map(({ name, command, args, url }) =>
                ` MCP 预设 ${name} 使用 ${command ? [command, ...(args ?? [])].join(' ') : url ?? '外部服务'}。`)}
            </span>
          </label>}
          <button type="button" className={`${button} bg-[var(--accent-indigo)] text-white`}
            disabled={!!busy || (Boolean(preview.result.requiresTrust) && !trustCode)}
            onClick={() => void run('正在安装插件…', async () => {
              const request = { ...preview.request, expectedDigest: preview.result.digest, trustCode,
                expectedInstalledDigest: preview.result.installedDigest };
              await installPlugin(request);
              onInstalled();
            })}>{preview.result.installedEnabled === false ? '保存版本' : preview.result.installedVersion ? '替换并热加载' : '安装并热加载'}</button>
        </section>
      )}
      {(busy || error) && <p role={error ? 'alert' : 'status'} className={error ? 'text-[var(--accent-rose)]' : undefined}>{error || busy}</p>}
    </div>
  );
}
