import type {
  ContextPreview,
  ContextSyncMode,
  PluginCatalogItem,
  PluginCategory,
  PluginRegistryStateDto,
} from '@harnessmate/protocol';
import { GeneratedPluginManifestSchema, PluginManifestSchema, type PluginManifest } from '@harnessmate/protocol';
import {
  ArrowRightLeft,
  Check,
  Copy,
  Download,
  GitBranch,
  Loader2,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import {
  formatCountdown,
  formatTokenCount,
  getHarnessMeta,
  resolveHarnessMeta,
} from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';
import { useSlotRegistry, useSlotRenderFailures } from '../slots';
import { HarnessBadge } from './BrandMark';
import { ModelPicker } from './ModelPicker';
import { PluginAuthoringForm } from './PluginAuthoringForm';
import { PluginDevPanel } from './PluginDevPanel';
import { PluginLogsPanel } from './PluginLogsPanel';
import { PluginPermissionsEditor } from './PluginPermissionsEditor';

function StudioHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 px-5 py-4"
      style={{ borderBottom: '1px solid var(--border-hairline)' }}
    >
      <div>
        <h3 className="text-[15.5px] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <X size={16} />
      </button>
    </div>
  );
}

// ── 1. Modular Plugin Studio ───────────────────────────────────────────

const CATEGORY_LABELS: Record<PluginCategory, string> = {
  harness: 'CLI 引擎',
  tool: '核心工具',
  mcp: 'MCP 扩展',
  telemetry: '用量遥测',
  ui: '界面面板',
  remote: '多端联动',
  workflow: '工作流',
};

const MANIFEST_TEMPLATE = `{
  "id": "user.my-workflow",
  "name": "我的自定义斜杠指令插件",
  "version": "1.0.0",
  "apiVersion": 4,
  "engines": { "pluginApi": "^4.0" },
  "description": "添加一个 /doc 斜杠指令快速生成代码文档",
  "author": "Local User",
  "category": "workflow",
  "contributes": {
    "slashCommands": [
      {
        "command": "doc",
        "description": "为指定模块生成清晰的架构与接口文档",
        "argumentHint": "[文件路径或模块名]",
        "template": "请阅读以下目标代码，生成结构清晰、带调用示例的 Markdown 技术文档：\\n\\n{{args}}"
      }
    ]
  }
}`;

export function PluginStudioModal({ onClose }: { onClose: () => void }) {
  const {
    plugins,
    pluginCatalog,
    pluginsDir,
    refreshPlugins,
    togglePlugin,
    installPlugin,
    uninstallPlugin,
    reloadPlugins,
    restorePluginComposition,
    rollbackPlugin,
    pushToast,
  } = useAppStore();

  const [tab, setTab] = useState<'installed' | 'catalog' | 'install' | 'dev' | 'logs' | 'composition'>('installed');
  const [composition, setComposition] = useState<Awaited<ReturnType<typeof daemonApi.getPluginComposition>>>();
  const [registryState, setRegistryState] = useState<PluginRegistryStateDto>();
  const [registryUrlsInput, setRegistryUrlsInput] = useState('');
  const [requireSigned, setRequireSigned] = useState(true);
  const [pubId, setPubId] = useState('');
  const [pubName, setPubName] = useState('');
  const [pubKeyPem, setPubKeyPem] = useState('');
  const [showRegistryConfig, setShowRegistryConfig] = useState(false);
  const [logTargetPluginId, setLogTargetPluginId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ manifest: PluginManifest; digest: string }>();
  const [permissionPluginId, setPermissionPluginId] = useState<string>();
  const permissionPlugin = plugins.find(({ id }) => id === permissionPluginId);
  const slotRegistry = useSlotRegistry();
  const renderFailures = useSlotRenderFailures();
  const runPluginAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); }
    catch (err) { pushToast({ kind: 'error', title: '插件操作失败', body: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    void refreshPlugins().catch((err: Error) => pushToast({ kind: 'error', title: '无法读取插件', body: err.message }));
  }, [refreshPlugins, pushToast]);

  useEffect(() => {
    let current = true;
    void daemonApi.getPluginComposition().then((result) => { if (current) setComposition(result); })
      .catch((error: Error) => { if (current) pushToast({ kind: 'error', title: '无法读取组合', body: error.message }); });
    return () => { current = false; };
  }, [plugins, pushToast]);

  useEffect(() => {
    if (tab !== 'catalog') return;
    let current = true;
    void daemonApi.getPluginRegistry().then(({ registry }) => {
      if (!current) return;
      setRegistryState(registry);
      setRegistryUrlsInput(registry.indexUrls.join('\n'));
      setRequireSigned(registry.requireSigned);
    }).catch(() => {});
    return () => { current = false; };
  }, [tab]);

  const handleInstallCatalog = async (item: PluginCatalogItem) => {
    setBusy(true);
    try {
      const request = item.source === 'remote'
        ? ({ mode: 'remote_index', pluginId: item.id, version: item.version } as const)
        : ({ mode: 'catalog', catalogId: item.id } as const);
      const preview = await daemonApi.previewPlugin(request);
      if (preview.requiresTrust) {
        const { harnesses, mcpPresets } = preview.manifest.contributes;
        const targets = [
          ...(preview.manifest.main ? [`隔离代码入口: ${preview.manifest.main}`] : []),
          ...(harnesses ?? []).map(({ command, args }) => [command, ...args].join(' ')),
          ...(mcpPresets ?? []).map(({ name, command, args, url }) =>
            name + ' · ' + (command ? [command, ...(args ?? [])].join(' ') : url ?? '')),
        ];
        if (!window.confirm([`信任并安装 ${preview.manifest.name}？`, ...targets].join('\n'))) return;
      }
      await installPlugin({ ...request, expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest,
        trustCode: preview.requiresTrust });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '安装失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveRegistry = async () => {
    setBusy(true);
    try {
      const urls = registryUrlsInput
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await daemonApi.updatePluginRegistryConfig({ indexUrls: urls, requireSigned });
      setRegistryState(res.registry);
      await refreshPlugins();
      pushToast({ kind: 'success', title: '远程插件索引已更新并同步' });
    } catch (err) {
      pushToast({ kind: 'error', title: '更新索引配置失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshRegistry = async () => {
    setBusy(true);
    try {
      const res = await daemonApi.refreshPluginRegistry();
      setRegistryState(res.registry);
      await refreshPlugins();
      pushToast({ kind: 'success', title: '已完成远程索引同步' });
    } catch (err) {
      pushToast({ kind: 'error', title: '同步索引失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleAddPublisher = async () => {
    if (!pubId.trim() || !pubName.trim() || !pubKeyPem.trim()) return;
    setBusy(true);
    try {
      const res = await daemonApi.addTrustedPublisher({
        id: pubId.trim(),
        name: pubName.trim(),
        publicKeyPem: pubKeyPem.trim(),
      });
      setRegistryState(res.registry);
      await refreshPlugins();
      setPubId('');
      setPubName('');
      setPubKeyPem('');
      pushToast({ kind: 'success', title: '已添加信任发布者公钥' });
    } catch (err) {
      pushToast({ kind: 'error', title: '添加发布者失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemovePublisher = async (id: string) => {
    setBusy(true);
    try {
      const res = await daemonApi.removeTrustedPublisher(id);
      setRegistryState(res.registry);
      await refreshPlugins();
    } catch (err) {
      pushToast({ kind: 'error', title: '移除发布者失败', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StudioHeader
        title="插件中心"
        onClose={onClose}
      />

      <div className="flex items-center justify-between gap-2 px-5 pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <PillTab active={tab === 'installed'} onClick={() => setTab('installed')}>
            已安装 ({plugins.length})
          </PillTab>
          <PillTab active={tab === 'catalog'} onClick={() => setTab('catalog')}>
            扩展市场 ({pluginCatalog.length})
          </PillTab>
          <PillTab active={tab === 'install'} onClick={() => { setEditing(undefined); setTab('install'); }}>
            安装 / 创建插件
          </PillTab>
          <PillTab active={tab === 'dev'} onClick={() => setTab('dev')}>
            开发 / 脚手架
          </PillTab>
          <PillTab active={tab === 'logs'} onClick={() => setTab('logs')}>
            日志
          </PillTab>
          <PillTab active={tab === 'composition'} onClick={() => setTab('composition')}>
            查看完整组合
          </PillTab>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void runPluginAction(reloadPlugins)}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          style={{ border: '1px solid var(--border-hairline)' }}
        >
          <RefreshCw size={12} />
          热重载
        </button>
      </div>

      <div className="max-h-[480px] overflow-y-auto p-5">
        {composition?.safeMode && (
          <p role="status" className="mb-3 text-[12px] text-[var(--text-secondary)]">
            安全模式正在使用内置组合。恢复完成后，可从托盘重新正常启动。
          </p>
        )}
        {tab === 'installed' && (
          <div className="space-y-2.5">
            {permissionPlugin && <PluginPermissionsEditor key={permissionPlugin.id} plugin={permissionPlugin}
              onClose={() => setPermissionPluginId(undefined)} />}
            {pluginsDir && (
              <div className="rounded-xl px-3 py-2 font-mono-code text-[11px] text-[var(--text-muted)]" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                外部插件目录：{pluginsDir}
              </div>
            )}
            {renderFailures.length > 0 && (
              <div
                role="alert"
                className="space-y-1.5 rounded-xl p-3 text-[11.5px] text-[var(--accent-rose)]"
                style={{
                  backgroundColor: 'var(--accent-rose-soft)',
                  border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">界面插槽渲染异常 ({renderFailures.length})</span>
                  <button
                    type="button"
                    onClick={() => slotRegistry.clearAllRenderFailures()}
                    className="cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] hover:bg-[var(--bg-hover)]"
                  >
                    全部清除
                  </button>
                </div>
                {renderFailures.slice(0, 6).map((failure) => (
                  <div key={failure.id} className="flex items-start justify-between gap-2 text-[11px]">
                    <span className="min-w-0 break-words">
                      <strong className="font-medium">{failure.pluginName}</strong> · <code>{failure.slot}/{failure.slotItemId}</code>：{failure.message}
                    </span>
                    <button
                      type="button"
                      onClick={() => slotRegistry.clearRenderFailure(failure.id)}
                      className="shrink-0 cursor-pointer opacity-75 hover:opacity-100"
                    >
                      忽略
                    </button>
                  </div>
                ))}
              </div>
            )}
            {plugins.map((p) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-3 rounded-xl p-3.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                  opacity: p.enabled ? 1 : 0.62,
                }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Puzzle size={13.5} className="shrink-0 text-[var(--accent-indigo)]" />
                    <span className="text-[13px] font-medium text-[var(--text-primary)]">{p.name}</span>
                    <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                      v{p.version}
                    </span>
                    <span
                      className="rounded-md px-1.5 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--accent-indigo)',
                      }}
                    >
                      {CATEGORY_LABELS[p.category] ?? p.category}
                    </span>
                    {!p.builtin && (
                      <span
                        className="rounded-md px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: 'var(--accent-star-soft)',
                          color: 'var(--accent-star)',
                        }}
                      >
                        {p.devTrustedLocal ? '可信本地' :
                          p.devMode ? '开发中' : p.runtimeMode === 'isolated' ? '隔离进程' : '外部插件'}
                      </span>
                    )}
                    {p.devMode && p.runtimeMode === 'isolated' && (
                      <span
                        className="rounded-md px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        隔离进程
                      </span>
                    )}
                  </div>

                  <p className="mt-1 text-[11.8px] leading-relaxed text-[var(--text-secondary)]">
                    {p.description}
                  </p>
                  {p.loadError && <p className="mt-1 break-words text-[11.8px] text-[var(--accent-rose)]">{p.loadError}</p>}
                  {renderFailures.filter((f) => f.pluginId === p.id).map((failure) => (
                    <p key={failure.id} className="mt-1 break-words text-[11px] text-[var(--accent-rose)]">
                      插槽 {failure.slot}/{failure.slotItemId} 渲染失败：{failure.message}
                    </p>
                  ))}
                  {p.runtimeState === 'PENDING' && (
                    <p className="mt-1 text-[11.8px] text-[var(--text-secondary)]">等待服务 · {p.missingServices?.join('、')}</p>
                  )}

                  {/* Contributed items preview */}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.contributes.dataPanels?.map(({ id, title, copySummary }) => (
                      <span key={id} className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]">
                        {title}{copySummary?.command && ` · /${copySummary.command}`}
                      </span>
                    ))}
                    {[...(p.contributes.slots ?? []), ...(p.runtimeSlots ?? [])].map((s, idx) => (
                      <span
                        key={`${s.slot}:${s.id}:${idx}`}
                        className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--accent-indigo)]"
                        style={{ backgroundColor: 'var(--accent-indigo-soft)' }}
                      >
                        UI:{s.slot} ({s.title})
                      </span>
                    ))}
                    {(p.contributes.slashCommands ?? []).map((c) => (
                      <span
                        key={c.command}
                        className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--accent-indigo)]"
                        style={{ backgroundColor: 'var(--accent-indigo-soft)' }}
                      >
                        /{c.command}
                      </span>
                    ))}
                    {(p.contributes.mcpPresets ?? []).map((m) => (
                      <span
                        key={m.name}
                        className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--accent-emerald)]"
                        style={{ backgroundColor: 'var(--accent-emerald-soft)' }}
                      >
                        MCP:{m.name}
                      </span>
                    ))}
                    {(p.contributes.harnesses ?? []).map((h) => (
                      <span
                        key={h.id}
                        className="rounded px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--accent-clay)]"
                        style={{ backgroundColor: 'var(--accent-clay-soft)' }}
                      >
                        ACP:{h.displayName}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {!p.builtin && (
                    <button
                      type="button"
                      className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      onClick={() => { setLogTargetPluginId(p.id); setTab('logs'); }}
                    >
                      日志
                    </button>
                  )}
                  {p.devMode && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-[11px] text-[var(--accent-emerald)]"
                      onClick={() => void runPluginAction(async () => {
                        await daemonApi.reloadDevPlugin(p.id);
                        await refreshPlugins();
                      })}
                    >
                      重载
                    </button>
                  )}
                  {(!!p.permissions?.length || !!p.provides?.length || !!p.contributes.actions?.length || p.contributes.programs?.some(({ exposeToModel }) => exposeToModel)) &&
                    <button type="button" className="text-[11px] text-[var(--accent-indigo)]"
                      onClick={() => setPermissionPluginId(p.id)}>工作区授权</button>}
                  {p.canRollback && <button type="button" disabled={busy} className="text-[11px] text-[var(--accent-indigo)]"
                    onClick={() => void runPluginAction(() => rollbackPlugin(p.id))}>回退</button>}
                  {!p.builtin && !p.loadError && p.packageDigest && GeneratedPluginManifestSchema.safeParse(PluginManifestSchema.parse(p)).success && (
                    <button type="button" disabled={busy} className="text-[11px] text-[var(--accent-indigo)]"
                      onClick={() => { setEditing({ manifest: PluginManifestSchema.parse(p), digest: p.packageDigest! }); setTab('install'); }}>AI 改版</button>
                  )}
                  {!p.builtin && (
                    <button
                      type="button"
                      title="卸载插件"
                      disabled={busy}
                      onClick={() => void runPluginAction(() => uninstallPlugin(p.id))}
                      className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--accent-rose-soft)] hover:text-[var(--accent-rose)]"
                    >
                      <Trash2 size={13.5} />
                    </button>
                  )}
                  {composition?.safeMode && !p.builtin && (
                    <button type="button" disabled={busy || Boolean(composition.error)}
                      className="text-[11px] text-[var(--text-secondary)]"
                      onClick={() => void runPluginAction(() => togglePlugin(p.id, false))}>下次启动停用</button>
                  )}
                  {!composition?.safeMode && <button
                    type="button"
                    role="switch"
                    aria-checked={p.enabled}
                    aria-label={`启用 ${p.name}`}
                    disabled={busy}
                    onClick={() => void runPluginAction(() => togglePlugin(p.id, !p.enabled))}
                    className="relative h-5 w-10 cursor-pointer rounded-full transition-colors"
                    style={{
                      backgroundColor: p.enabled ? 'var(--accent-emerald)' : 'var(--border-strong)',
                    }}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform"
                      style={{ transform: p.enabled ? 'translateX(20px)' : 'translateX(0)' }}
                    />
                  </button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'catalog' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2 text-[11.5px]">
              <div className="text-[var(--text-secondary)]">
                远程索引：{registryState?.indexUrls.length ?? 0} 个 · 信任发布者：{registryState?.trustedPublishers.length ?? 0} 个
                {registryState?.lastSyncedAt && (
                  <span className="ml-2 text-[10.5px] text-[var(--text-muted)]">
                    上次同步 {new Date(registryState.lastSyncedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRefreshRegistry()}
                  className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  同步远程索引
                </button>
                <button
                  type="button"
                  onClick={() => setShowRegistryConfig((v) => !v)}
                  className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                >
                  {showRegistryConfig ? '收起索引与签名配置' : '配置远程索引与公钥'}
                </button>
              </div>
            </div>

            {registryState?.errors && registryState.errors.length > 0 && (
              <div
                role="alert"
                className="space-y-1 rounded-xl p-2.5 text-[11px] text-[var(--accent-rose)]"
                style={{ backgroundColor: 'var(--accent-rose-soft)', border: '1px solid color-mix(in srgb, var(--accent-rose) 30%, transparent)' }}
              >
                {registryState.errors.map((e, i) => (
                  <div key={i}>索引同步失败 ({e.url})：{e.error}</div>
                ))}
              </div>
            )}

            {showRegistryConfig && (
              <div className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3 text-[11.5px]">
                <label className="block space-y-1">
                  <span className="text-[var(--text-secondary)]">远程插件索引 URL（每行一个，支持 https/http/file）</span>
                  <textarea
                    rows={2}
                    value={registryUrlsInput}
                    onChange={(e) => setRegistryUrlsInput(e.target.value)}
                    placeholder="https://plugins.example.com/index.json"
                    className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono-code text-[11px] text-[var(--text-primary)]"
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[var(--text-secondary)]">
                    <input type="checkbox" checked={requireSigned} onChange={(e) => setRequireSigned(e.target.checked)} />
                    仅允许受信任发布者的 Ed25519 验签插件
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSaveRegistry()}
                    className="cursor-pointer rounded-lg px-3 py-1 text-[11px] font-medium text-white"
                    style={{ backgroundColor: 'var(--accent-indigo)' }}
                  >
                    保存并同步
                  </button>
                </div>

                <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2.5">
                  <div className="font-medium text-[var(--text-primary)]">信任的发布者 Ed25519 公钥</div>
                  {(registryState?.trustedPublishers ?? []).map((pub) => (
                    <div key={pub.id} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5">
                      <span>
                        <strong className="text-[var(--text-primary)]">{pub.name}</strong>{' '}
                        <code className="text-[10.5px] text-[var(--text-muted)]">{pub.id}</code>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRemovePublisher(pub.id)}
                        className="cursor-pointer text-[11px] text-[var(--accent-rose)]"
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <input
                      value={pubId}
                      onChange={(e) => setPubId(e.target.value)}
                      placeholder="发布者 ID (如 acme)"
                      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono-code text-[11px]"
                    />
                    <input
                      value={pubName}
                      onChange={(e) => setPubName(e.target.value)}
                      placeholder="发布者名称"
                      className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px]"
                    />
                  </div>
                  <textarea
                    rows={2}
                    value={pubKeyPem}
                    onChange={(e) => setPubKeyPem(e.target.value)}
                    placeholder="-----BEGIN PUBLIC KEY----- ..."
                    className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2 font-mono-code text-[10.5px]"
                  />
                  <button
                    type="button"
                    disabled={busy || !pubId.trim() || !pubName.trim() || !pubKeyPem.trim()}
                    onClick={() => void handleAddPublisher()}
                    className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--accent-emerald)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
                  >
                    添加信任发布者
                  </button>
                </div>
              </div>
            )}

            {pluginCatalog.map((item) => {
              const incompatible = item.compatible === false;
              const invalidSig = item.signatureStatus === 'invalid';
              const blocked = incompatible || invalidSig;
              return (
                <div
                  key={`${item.source ?? 'builtin'}:${item.id}:${item.version}`}
                  className="flex items-start justify-between gap-3 rounded-xl p-3.5"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                    opacity: blocked ? 0.68 : 1,
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Sparkles size={13.5} className="text-[var(--accent-star)]" />
                      <span className="text-[13px] font-medium text-[var(--text-primary)]">
                        {item.name}
                      </span>
                      <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">v{item.version}</span>
                      {item.source === 'remote' && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-indigo)]" style={{ backgroundColor: 'var(--accent-indigo-soft)' }}>
                          远程索引
                        </span>
                      )}
                      {item.signatureStatus === 'verified' && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-emerald)]" style={{ backgroundColor: 'var(--accent-emerald-soft)' }}>
                          已验签 · {item.publisherName ?? item.publisherId}
                        </span>
                      )}
                      {item.signatureStatus === 'untrusted_publisher' && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-star)]" style={{ backgroundColor: 'var(--accent-star-soft)' }}>
                          未信任发布者 · {item.publisherName ?? item.publisherId}
                        </span>
                      )}
                      {item.signatureStatus === 'invalid' && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-rose)]" style={{ backgroundColor: 'var(--accent-rose-soft)' }}>
                          签名无效
                        </span>
                      )}
                      {incompatible && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--accent-rose)]" style={{ backgroundColor: 'var(--accent-rose-soft)' }}>
                          不兼容
                        </span>
                      )}
                      {item.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]"
                          style={{ backgroundColor: 'var(--bg-surface)' }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1 text-[11.8px] leading-relaxed text-[var(--text-secondary)]">
                      {item.description}
                    </p>
                    {incompatible && item.incompatibleReason && (
                      <p className="mt-1 text-[11px] text-[var(--accent-rose)]">{item.incompatibleReason}</p>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={busy || item.installed || blocked}
                    title={incompatible ? (item.incompatibleReason ?? '与当前插件 API 不兼容') : invalidSig ? '发布者签名校验失败' : undefined}
                    onClick={() => void handleInstallCatalog(item)}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-xl px-3 py-1.5 text-[12px] font-medium transition-opacity disabled:cursor-default disabled:opacity-55"
                    style={{
                      backgroundColor: item.installed ? 'var(--bg-surface)' : blocked ? 'var(--bg-surface)' : 'var(--accent-indigo)',
                      color: item.installed ? 'var(--accent-emerald)' : blocked ? 'var(--text-muted)' : '#fff',
                      border: item.installed || blocked ? '1px solid var(--border-hairline)' : 'none',
                    }}
                  >
                    {item.installed ? (
                      <>
                        <Check size={12.5} /> 已安装
                      </>
                    ) : incompatible ? (
                      <>不兼容</>
                    ) : invalidSig ? (
                      <>签名无效</>
                    ) : (
                      <>
                        <Download size={12.5} /> 安装
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'install' && (
          <PluginAuthoringForm key={editing?.manifest.id ?? 'new'} editing={editing}
            initialManifest={editing ? JSON.stringify(editing.manifest, null, 2) : MANIFEST_TEMPLATE}
            onInstalled={() => { setEditing(undefined); setTab('installed'); }} />
        )}
        {tab === 'dev' && (
          <PluginDevPanel
            plugins={plugins}
            onOpenLogs={(pid) => { setLogTargetPluginId(pid); setTab('logs'); }}
          />
        )}
        {tab === 'logs' && (
          <PluginLogsPanel plugins={plugins} initialPluginId={logTargetPluginId} />
        )}
        {tab === 'composition' && composition && (
          <div className="space-y-2 text-[12px]">
            <p className="text-[var(--text-secondary)]">组合包 · {composition.bundles.join(' → ') || '无'}</p>
            {composition.error && <p role="alert" className="text-[var(--accent-rose)]">{composition.error}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || !composition.canRestore}
                className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 disabled:opacity-50"
                onClick={() => {
                  if (window.confirm('恢复上一套组合配置？恢复后插件启停状态可能变化。')) {
                    void runPluginAction(() => restorePluginComposition('previous'));
                  }
                }}>恢复上一套配置</button>
              <button type="button" disabled={busy}
                className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 disabled:opacity-50"
                onClick={() => {
                  if (window.confirm('恢复内置组合并停用第三方插件？插件文件和历史数据会保留。')) {
                    void runPluginAction(() => restorePluginComposition('builtin'));
                  }
                }}>恢复内置组合</button>
            </div>
            {composition.entries.map((entry) => {
              const plugin = plugins.find(({ id }) => id === entry.name);
              return <div key={entry.id} className="rounded-xl border border-[var(--border-hairline)] p-3">
                <div className="flex flex-wrap justify-between gap-2 text-[var(--text-primary)]">
                  <span>{plugin?.name ?? entry.name} <span className="text-[var(--text-muted)]">· {entry.id}</span></span>
                  <span>{entry.disabled ? '已停用' : !plugin ? '未安装'
                    : plugin.runtimeState === 'PENDING' ? '等待服务' : plugin.runtimeState === 'FAILED' ? '加载失败' : '已启用'}</span>
                </div>
                <p className="mt-1 text-[var(--text-secondary)]">{entry.sources.join(' → ')}</p>
                {Object.keys(entry.config).length > 0 && <details className="mt-2">
                  <summary className="cursor-pointer text-[var(--accent-indigo)]">查看配置</summary>
                  <pre className="overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(entry.config, null, 2)}</pre>
                </details>}
              </div>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 2. Unified Cross-CLI MCP Hub ───────────────────────────────────────

export function McpHubModal({ onClose }: { onClose: () => void }) {
  const {
    mcpServers,
    mcpPresets,
    mcpLoading,
    refreshMcpServers,
    addMcpServer,
    toggleMcpServer,
    removeMcpServer,
  } = useAppStore();

  const [tab, setTab] = useState<'list' | 'add'>('list');
  const [filterHarness, setFilterHarness] = useState<string>('all');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [command, setCommand] = useState('npx');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [targets, setTargets] = useState<Array<'codex' | 'agy' | 'claude'>>(['agy']);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void refreshMcpServers();
  }, [refreshMcpServers]);

  const filtered = mcpServers.filter((s) => filterHarness === 'all' || s.harnessId === filterHarness);

  const toggleTarget = (h: 'codex' | 'agy' | 'claude') => {
    setTargets((prev) => (prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h]));
  };

  const handleAdd = async () => {
    if (!name.trim() || targets.length === 0) return;
    setSubmitting(true);
    try {
      await addMcpServer({
        targetHarnesses: targets,
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio' ? argsText.trim().split(/\s+/).filter(Boolean) : [],
        url: transport !== 'stdio' ? url.trim() : undefined,
      });
      setName('');
      setArgsText('');
      setUrl('');
      setTab('list');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <StudioHeader
        title="跨 CLI MCP 统一管理中心"
        subtitle="集中查看 Codex / AGY / Claude 已配置的 MCP 服务器，支持一键写入并跨 CLI 同步"
        onClose={onClose}
      />

      <div className="flex items-center justify-between gap-2 px-5 pt-3">
        <div className="flex items-center gap-1.5">
          <PillTab active={tab === 'list'} onClick={() => setTab('list')}>
            已配置 ({mcpServers.length})
          </PillTab>
          <PillTab active={tab === 'add'} onClick={() => setTab('add')}>
            <Plus size={12} /> 添加 / 同步 MCP
          </PillTab>
        </div>

        <button
          type="button"
          onClick={() => void refreshMcpServers()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          style={{ border: '1px solid var(--border-hairline)' }}
        >
          <RefreshCw size={12} className={mcpLoading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="max-h-[480px] overflow-y-auto p-5">
        {tab === 'list' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {['all', 'codex', 'agy', 'claude'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilterHarness(k)}
                  className="cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium"
                  style={{
                    backgroundColor: filterHarness === k ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    color: filterHarness === k ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                    border: `1px solid ${filterHarness === k ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                  }}
                >
                  {k === 'all' ? '全部 CLI' : k.toUpperCase()}
                </button>
              ))}
            </div>

            {mcpLoading ? (
              <div className="py-10 text-center text-[12px] text-[var(--text-muted)]">
                <Loader2 size={16} className="mx-auto mb-2 animate-spin text-[var(--accent-indigo)]" />
                正在实时读取各 CLI 的 MCP 配置...
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-xl p-6 text-center text-[12.5px] text-[var(--text-muted)]" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                当前筛选下暂无 MCP 服务器，可点击上方「添加 / 同步 MCP」快速配置。
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-start justify-between gap-3 rounded-xl p-3.5"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Plug size={13} className="text-[var(--accent-emerald)]" />
                        <span className="font-mono-code text-[12.8px] font-semibold text-[var(--text-primary)]">
                          {s.name}
                        </span>
                        <HarnessBadge kind={s.harnessKind} compact />
                        <span
                          className="rounded px-1.5 py-0.5 font-mono-code text-[10px]"
                          style={{
                            backgroundColor: 'var(--bg-surface)',
                            color:
                              s.status === 'enabled' || s.status === 'connected'
                                ? 'var(--accent-emerald)'
                                : s.status === 'disabled'
                                  ? 'var(--text-muted)'
                                  : 'var(--accent-star)',
                          }}
                        >
                          {s.status}
                        </span>
                        {s.toolCount !== undefined && s.toolCount > 0 && (
                          <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                            {s.toolCount} tools
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono-code text-[11px] text-[var(--text-muted)]">
                        [{s.transport}] {s.commandOrUrl} {s.args?.join(' ') ?? ''}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {s.harnessId === 'agy' && (
                        <button
                          type="button"
                          onClick={() =>
                            void toggleMcpServer({
                              harnessId: 'agy',
                              name: s.name,
                              enabled: s.status === 'disabled',
                            })
                          }
                          className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          style={{ border: '1px solid var(--border-hairline)' }}
                        >
                          {s.status === 'disabled' ? '启用' : '停用'}
                        </button>
                      )}
                      {(s.harnessId === 'codex' || s.harnessId === 'agy' || s.harnessId === 'claude') &&
                        s.commandOrUrl !== 'Codex Runtime MCP' && (
                          <button
                            type="button"
                            title="移除此 MCP"
                            onClick={() =>
                              void removeMcpServer(
                                s.harnessId as 'codex' | 'agy' | 'claude',
                                s.name,
                              )
                            }
                            className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--accent-rose-soft)] hover:text-[var(--accent-rose)]"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Plugin-provided MCP Presets */}
            {mcpPresets.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium text-[var(--text-muted)]">
                  来自已启用插件的一键 MCP 预设（点击自动填充）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {mcpPresets.map((p) => (
                    <button
                      key={`${p.pluginId}-${p.name}`}
                      type="button"
                      onClick={() => {
                        setName(p.name);
                        setTransport(p.transport);
                        setCommand(p.command ?? 'npx');
                        setArgsText((p.args ?? []).join(' '));
                        setUrl(p.url ?? '');
                      }}
                      className="cursor-pointer rounded-xl px-2.5 py-1.5 text-[11.5px] text-[var(--accent-indigo)] hover:bg-[var(--bg-active)]"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-focus)',
                      }}
                    >
                      + {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] text-[var(--text-muted)]">服务器名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 context7"
                  className="font-mono-code w-full rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[var(--text-muted)]">传输协议</label>
                <select
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as 'stdio' | 'http' | 'sse')}
                  className="w-full rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  <option value="stdio">stdio（本地命令）</option>
                  <option value="http">http（远程端点）</option>
                  <option value="sse">sse（Server-Sent Events）</option>
                </select>
              </div>
            </div>

            {transport === 'stdio' ? (
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="mb-1 block text-[11px] text-[var(--text-muted)]">命令</label>
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx / uvx / node"
                    className="font-mono-code w-full rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-[11px] text-[var(--text-muted)]">参数（空格分隔）</label>
                  <input
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder="-y @upstash/context7-mcp"
                    className="font-mono-code w-full rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-[11px] text-[var(--text-muted)]">服务器 URL</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:3000/mcp"
                  className="font-mono-code w-full rounded-xl px-3 py-2 text-[12px] text-[var(--text-primary)] focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--border-hairline)',
                  }}
                />
              </div>
            )}

            <div>
              <label className="mb-1.5 block text-[11px] text-[var(--text-muted)]">
                同步写入目标 CLI（可多选）
              </label>
              <div className="flex gap-2">
                {(['codex', 'agy', 'claude'] as const).map((h) => {
                  const checked = targets.includes(h);
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => toggleTarget(h)}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium"
                      style={{
                        backgroundColor: checked ? 'var(--bg-active)' : 'var(--bg-elevated)',
                        color: checked ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                        border: `1px solid ${checked ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                      }}
                    >
                      {checked && <Check size={12} />}
                      <span>{getHarnessMeta(h).shortLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={submitting || !name.trim() || targets.length === 0}
                onClick={() => void handleAdd()}
                className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                {submitting ? '写入中...' : '立即安装到所选 CLI'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 3. Multi-Account & Quota / Usage Dashboard ─────────────────────────

export function UsageDashboardModal({ onClose }: { onClose: () => void }) {
  const {
    harnesses,
    selectedSessionId,
    switchHarness,
    accountUsage,
    usageLoading,
    failoverPolicy,
    refreshAccountUsage,
    refreshFailoverPolicy,
    updateFailoverPolicy,
  } = useAppStore();

  const [policyDraft, setPolicyDraft] = useState({
    mode: failoverPolicy?.mode ?? ('manual_one_click' as const),
    priorityChain: failoverPolicy?.priorityChain ?? harnesses.map((h) => h.id),
    maxAutoSwitchesPerSession: failoverPolicy?.maxAutoSwitchesPerSession ?? 2,
    autoRetryInterruptedPrompt: failoverPolicy?.autoRetryInterruptedPrompt ?? true,
    notifyOnQuotaReset: failoverPolicy?.notifyOnQuotaReset ?? true,
  });
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    void refreshAccountUsage(false);
    void refreshFailoverPolicy();
  }, [refreshAccountUsage, refreshFailoverPolicy]);

  useEffect(() => {
    if (failoverPolicy) {
      const knownIds = harnesses.map((h) => h.id);
      const mergedChain = [
        ...failoverPolicy.priorityChain.filter((id) => knownIds.includes(id)),
        ...knownIds.filter((id) => !failoverPolicy.priorityChain.includes(id)),
      ];
      setPolicyDraft({
        ...failoverPolicy,
        priorityChain: mergedChain,
      });
    } else if (harnesses.length > 0) {
      setPolicyDraft((prev) => ({
        ...prev,
        priorityChain: prev.priorityChain.length > 0 ? prev.priorityChain : harnesses.map((h) => h.id),
      }));
    }
  }, [failoverPolicy, harnesses]);

  const movePriority = (index: number, dir: -1 | 1) => {
    const nextIdx = index + dir;
    if (nextIdx < 0 || nextIdx >= policyDraft.priorityChain.length) return;
    const copy = [...policyDraft.priorityChain];
    const [moved] = copy.splice(index, 1);
    copy.splice(nextIdx, 0, moved!);
    setPolicyDraft((prev) => ({ ...prev, priorityChain: copy }));
  };

  const handleSavePolicy = async () => {
    setSavingPolicy(true);
    try {
      await updateFailoverPolicy(policyDraft);
    } finally {
      setSavingPolicy(false);
    }
  };

  return (
    <div>
      <StudioHeader
        title="多实例用量与 Failover 接力看板"
        subtitle="按已注册 Harness 实例聚合实时配额窗口、Prompt Cache 命中、本地 Token 账本与接力优先级链"
        onClose={onClose}
      />

      <div className="max-h-[540px] space-y-3.5 overflow-y-auto p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">
            已注册 {accountUsage.length || harnesses.length} 个实例 · 默认 60s TTL 缓存防探活限流
          </span>
          <button
            type="button"
            onClick={() => void refreshAccountUsage(true)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <RefreshCw size={12.5} className={usageLoading ? 'animate-spin' : ''} />
            强制刷新配额
          </button>
        </div>

        {usageLoading && accountUsage.length === 0 ? (
          <div className="py-12 text-center text-[12.5px] text-[var(--text-muted)]">
            <Loader2 size={18} className="mx-auto mb-2 animate-spin text-[var(--accent-indigo)]" />
            正在采集全部已注册实例的账号与配额信息...
          </div>
        ) : (
          accountUsage.map((acc) => {
            const matchedHarness = harnesses.find((h) => h.id === (acc.instanceId ?? acc.harnessId));
            const maxDaily = Math.max(1, ...acc.dailyBuckets.map((b) => b.tokens));
            const cacheHitPct =
              acc.localInputTokens > 0 && acc.localCachedTokens > 0
                ? Math.min(100, Math.round((acc.localCachedTokens / acc.localInputTokens) * 100))
                : null;
            return (
              <div
                key={acc.instanceId ?? acc.harnessId}
                className="space-y-3 rounded-2xl p-4"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <HarnessBadge
                      kind={acc.driverId ?? acc.harnessKind}
                      label={acc.displayName}
                      presentation={matchedHarness?.presentation}
                    />
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      {acc.accountLabel ?? (acc.loggedIn ? '已登录' : '本地统计')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {acc.billingTier && acc.billingTier !== 'unknown' && (
                      <span
                        className="rounded-full px-2 py-0.5 font-mono-code text-[10px]"
                        style={{
                          backgroundColor: 'var(--bg-surface)',
                          color: 'var(--text-secondary)',
                          border: '1px solid var(--border-hairline)',
                        }}
                      >
                        {acc.billingTier === 'subscription'
                          ? '订阅包月'
                          : acc.billingTier === 'api_payg'
                            ? 'API 按量'
                            : '本地免费'}
                      </span>
                    )}
                    {acc.planType && (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase"
                        style={{
                          backgroundColor: 'var(--accent-star-soft)',
                          color: 'var(--accent-star)',
                        }}
                      >
                        {acc.planType}
                      </span>
                    )}
                    <span
                      className="rounded-full px-2 py-0.5 text-[10.5px]"
                      style={{
                        backgroundColor: acc.loggedIn
                          ? 'var(--accent-emerald-soft)'
                          : 'var(--accent-rose-soft)',
                        color: acc.loggedIn ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                      }}
                    >
                      {acc.loggedIn ? '在线' : '未认证'}
                    </span>
                  </div>
                </div>

                {/* Rate Limit Windows */}
                {acc.rateLimits.length > 0 && (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {acc.rateLimits.map((rl) => {
                      const barColor =
                        rl.usedPercent >= 90
                          ? 'var(--accent-rose)'
                          : rl.usedPercent >= 65
                            ? 'var(--accent-star)'
                            : 'var(--accent-emerald)';
                      return (
                        <div
                          key={rl.label}
                          className="rounded-xl p-2.5"
                          style={{ backgroundColor: 'var(--bg-surface)' }}
                        >
                          <div className="mb-1.5 flex items-center justify-between text-[11px]">
                            <span className="text-[var(--text-secondary)]">{rl.label}</span>
                            <span className="font-mono-code font-semibold" style={{ color: barColor }}>
                              {rl.usedPercent}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${rl.usedPercent}%`, backgroundColor: barColor }}
                            />
                          </div>
                          {rl.resetsAt && (
                            <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                              重置：{formatCountdown(rl.resetsAt)} (
                              {new Date(rl.resetsAt).toLocaleString('zh-CN', {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              )
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Lifetime & Daily Sparkline */}
                {(acc.lifetimeTokens !== undefined || acc.dailyBuckets.length > 0) && (
                  <div
                    className="space-y-2 rounded-xl p-3"
                    style={{ backgroundColor: 'var(--bg-surface)' }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      {acc.lifetimeTokens !== undefined && (
                        <span className="text-[var(--text-muted)]">
                          累计历史 Token：
                          <strong className="font-mono-code text-[var(--text-primary)]">
                            {formatTokenCount(acc.lifetimeTokens)}
                          </strong>
                        </span>
                      )}
                      {acc.currentStreakDays !== undefined && (
                        <span className="text-[var(--text-muted)]">
                          连续活跃 <strong className="text-[var(--accent-star)]">{acc.currentStreakDays}</strong> 天
                        </span>
                      )}
                      {acc.resetCreditsAvailable !== undefined && acc.resetCreditsAvailable > 0 && (
                        <span className="text-[var(--accent-emerald)]">
                          可用限额重置券：{acc.resetCreditsAvailable}
                        </span>
                      )}
                    </div>

                    {acc.dailyBuckets.length > 0 && (
                      <div className="flex h-12 items-end gap-1 pt-1">
                        {acc.dailyBuckets.map((b) => {
                          const hPct = Math.max(8, Math.round((b.tokens / maxDaily) * 100));
                          return (
                            <div
                              key={b.date}
                              title={`${b.date}: ${formatTokenCount(b.tokens)} tokens`}
                              className="flex-1 rounded-t-sm transition-opacity hover:opacity-80"
                              style={{
                                height: `${hPct}%`,
                                backgroundColor: 'var(--accent-indigo)',
                                opacity: 0.78,
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Local Desktop Session Ledger */}
                <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--text-muted)]">
                  <span>本机桌面会话：{acc.localSessionCount} 个</span>
                  <span className="font-mono-code">
                    ↑{formatTokenCount(acc.localInputTokens)} / ↓{formatTokenCount(acc.localOutputTokens)}
                  </span>
                  {cacheHitPct !== null && (
                    <span className="font-mono-code text-[var(--accent-emerald)]">
                      Prompt Cache {cacheHitPct}%
                    </span>
                  )}
                  {acc.localCostUsd > 0 && (
                    <span className="font-mono-code text-[var(--accent-star)]">
                      本机估算 ${acc.localCostUsd.toFixed(4)}
                    </span>
                  )}
                </div>

                {acc.error && (
                  <div className="text-[11px] text-[var(--accent-rose)]">{acc.error}</div>
                )}
                {(acc.driverId === 'agy' || acc.harnessKind === 'agy') && (
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-1.5 text-[11px] text-[var(--text-muted)]">
                    <span>多 AGY Google 账号禁止自动额度轮换，仅支持手动一键切换。</span>
                    {selectedSessionId && (
                      <button
                        type="button"
                        onClick={() => {
                          void switchHarness(selectedSessionId, {
                            targetHarnessId: acc.instanceId ?? acc.harnessId,
                          });
                          onClose();
                        }}
                        className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        手动切换至该账号
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* Failover Priority Chain & Guardrail Configurator */}
        <div
          className="space-y-3 rounded-2xl p-4"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                Failover 限额接力策略与优先级链
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                当实例遇到 usage_limit / rate_limited / provider_unavailable 时按链推荐备选实例
              </div>
            </div>
            <button
              type="button"
              disabled={savingPolicy}
              onClick={() => void handleSavePolicy()}
              className="cursor-pointer rounded-xl px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {savingPolicy ? '保存中...' : '保存策略'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] text-[var(--text-secondary)]">
              <span>接力模式</span>
              <select
                value={policyDraft.mode}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({
                    ...prev,
                    mode: e.target.value as typeof prev.mode,
                  }))
                }
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
              >
                <option value="manual_one_click">一键确认接力（推荐）</option>
                <option value="auto_same_tier">同档位自动接力（防包月切付费 API）</option>
                <option value="auto_any">任意可用实例自动接力</option>
              </select>
            </label>
            <label className="space-y-1 text-[11px] text-[var(--text-secondary)]">
              <span>单会话最大自动切换次数（防乒乓循环）</span>
              <input
                type="number"
                min={0}
                max={10}
                value={policyDraft.maxAutoSwitchesPerSession}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({
                    ...prev,
                    maxAutoSwitchesPerSession: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                  }))
                }
                className="font-mono-code w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]"
              />
            </label>
          </div>

          {policyDraft.priorityChain.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-[var(--text-muted)]">备选实例接力顺序：</div>
              {policyDraft.priorityChain.map((id, idx) => {
                const h = harnesses.find((item) => item.id === id);
                const meta = resolveHarnessMeta({ harness: h, harnessId: id }, harnesses);
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11.5px]"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                        #{idx + 1}
                      </span>
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: meta.accentColor }}
                      />
                      <span className="font-medium text-[var(--text-primary)]">
                        {h?.displayName ?? id}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => movePriority(idx, -1)}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30"
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        disabled={idx === policyDraft.priorityChain.length - 1}
                        onClick={() => movePriority(idx, 1)}
                        className="cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30"
                      >
                        下移
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 4. Cross-Harness Switch & Fork Modal ───────────────────────────────

export function HandoffModal({ onClose }: { onClose: () => void }) {
  const { sessions, harnesses, selectedSessionId, switchHarness, handoffSession, pushToast } =
    useAppStore();
  const source = sessions.find((s) => s.id === selectedSessionId);
  const [mode, setMode] = useState<'in_session' | 'fork'>('in_session');
  const [targetHarnessId, setTargetHarnessId] = useState(
    harnesses.find((h) => h.id !== source?.harnessId && h.health === 'ready')?.id ??
      harnesses[0]?.id ??
      '',
  );
  const [targetModel, setTargetModel] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<ContextSyncMode>('auto');
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedHarness = harnesses.find((h) => h.id === targetHarnessId);

  useEffect(() => {
    if (!source || !targetHarnessId) return;
    let active = true;
    void daemonApi
      .getContextPreview(source.id, targetHarnessId, syncMode)
      .then((res) => {
        if (active) setPreview(res.preview);
      })
      .catch(() => {
        if (active) setPreview(null);
      });
    return () => {
      active = false;
    };
  }, [source, targetHarnessId, syncMode]);

  if (!source) return null;

  const handleGo = async () => {
    setBusy(true);
    try {
      if (mode === 'in_session') {
        await switchHarness(source.id, {
          targetHarnessId,
          targetModel,
          syncMode,
        });
        onClose();
      } else {
        await handoffSession(source.id, targetHarnessId, targetModel);
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        title: mode === 'in_session' ? '切换引擎失败' : '分支失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StudioHeader
        title="跨 Harness 无缝交接"
        subtitle="默认在当前会话内无缝切换引擎，完整保留历史聊天记录与任务账本；也可分支出独立会话"
        onClose={onClose}
      />
      <div className="space-y-4 p-5">
        {/* Mode Switcher */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('in_session')}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors"
            style={{
              backgroundColor: mode === 'in_session' ? 'var(--bg-active)' : 'var(--bg-elevated)',
              border: `1px solid ${mode === 'in_session' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <Sparkles size={14} className="shrink-0 text-[var(--accent-indigo)]" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                会话内无缝切换（推荐）
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)]">
                同窗口延续历史 + 增量同步上下文
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode('fork')}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors"
            style={{
              backgroundColor: mode === 'fork' ? 'var(--bg-active)' : 'var(--bg-elevated)',
              border: `1px solid ${mode === 'fork' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <GitBranch size={14} className="shrink-0 text-[var(--accent-star)]" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                分支为新会话 (Fork)
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)]">
                复制任务账本与上下文另开分支
              </div>
            </div>
          </button>
        </div>

        <div>
          <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
            选择目标 CLI 引擎
          </label>
          <div className="grid grid-cols-3 gap-2">
            {harnesses.map((h) => {
              const active = targetHarnessId === h.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setTargetHarnessId(h.id);
                    setTargetModel(null);
                  }}
                  className="flex cursor-pointer flex-col gap-1 rounded-xl p-2.5 text-left"
                  style={{
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                  }}
                >
                  <HarnessBadge kind={h.kind} label={h.displayName} presentation={h.presentation} compact />
                  <span className="text-[10.5px] text-[var(--text-muted)]">
                    {h.models.length} 个模型
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {selectedHarness && selectedHarness.models.length > 0 && (
            <div>
              <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
                目标模型（可选）
              </label>
              <ModelPicker
                models={selectedHarness.models}
                value={targetModel}
                defaultModelId={selectedHarness.defaultModelId}
                placement="bottom"
                onChange={setTargetModel}
              />
            </div>
          )}

          {mode === 'in_session' && (
            <div>
              <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
                上下文同步策略
              </label>
              <select
                value={syncMode}
                onChange={(e) => setSyncMode(e.target.value as ContextSyncMode)}
                className="w-full rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <option value="auto">智能增量同步（推荐 · 复用热记忆）</option>
                <option value="full_ledger">全量账本 + 最近窗口重新同步</option>
                <option value="delta_only">仅增量未同步轮次</option>
              </select>
            </div>
          )}
        </div>

        {preview && (
          <div
            className="rounded-xl px-3.5 py-2.5 text-[11.5px] text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                同步预估：
                <strong className="text-[var(--text-primary)]">
                  {preview.unsyncedTurnCount} 轮增量对话
                </strong>{' '}
                · 约{' '}
                <strong className="font-mono-code text-[var(--accent-indigo)]">
                  {formatTokenCount(preview.estimatedTokens)} tokens
                </strong>
              </span>
              <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                驱动：{preview.driverPlanned}
              </span>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] text-[var(--text-secondary)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleGo()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            <ArrowRightLeft size={13.5} />
            {busy
              ? '处理中...'
              : mode === 'in_session'
                ? '立即无缝切换'
                : '创建分支会话'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 4b. Context Bridge Transparency Preview Modal ──────────────────────

export function ContextPreviewModal({ onClose }: { onClose: () => void }) {
  const { sessions, harnesses, selectedSessionId, pushToast } = useAppStore();
  const session = sessions.find((s) => s.id === selectedSessionId);
  const [targetHarnessId, setTargetHarnessId] = useState(session?.harnessId ?? harnesses[0]?.id ?? '');
  const [syncMode, setSyncMode] = useState<ContextSyncMode>(session?.contextSyncMode ?? 'auto');
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    void daemonApi
      .getContextPreview(session.id, targetHarnessId, syncMode)
      .then((res) => setPreview(res.preview))
      .catch(() => setPreview(null))
      .finally(() => setLoading(false));
  }, [session, targetHarnessId, syncMode]);

  if (!session) return null;

  const handleCopy = () => {
    if (!preview) return;
    void navigator.clipboard.writeText(preview.compiledMarkdown);
    setCopied(true);
    pushToast({ kind: 'info', title: '已复制完整编译上下文包' });
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div>
      <StudioHeader
        title="上下文同步透视 (Context Bridge Preview)"
        subtitle="透明查看切换引擎时即将注入的工作区真值、任务账本与增量对话内容"
        onClose={onClose}
      />

      <div className="space-y-3.5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {harnesses.map((h) => {
              const active = targetHarnessId === h.id;
              const meta = resolveHarnessMeta({ harness: h }, harnesses);
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setTargetHarnessId(h.id)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                    border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: meta.accentColor }}
                  />
                  {meta.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <select
              value={syncMode}
              onChange={(e) => setSyncMode(e.target.value as ContextSyncMode)}
              className="rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <option value="auto">智能增量</option>
              <option value="full_ledger">全量账本</option>
              <option value="delta_only">仅增量</option>
            </select>

            <button
              type="button"
              onClick={handleCopy}
              disabled={!preview}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              {copied ? <Check size={12} className="text-[var(--accent-emerald)]" /> : <Copy size={12} />}
              复制
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
            <Loader2 size={18} className="mx-auto mb-2 animate-spin text-[var(--accent-indigo)]" />
            正在编译增量上下文包...
          </div>
        ) : preview ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricMini label="已同步水位" value={`#${preview.syncedUpToSeq} / #${preview.currentLastSeq}`} />
              <MetricMini label="待同步轮次" value={`${preview.unsyncedTurnCount} 轮`} />
              <MetricMini
                label="预算占用"
                value={`${formatTokenCount(preview.estimatedTokens)} / ${formatTokenCount(preview.budgetTokens)}`}
              />
              <MetricMini label="注入协议驱动" value={preview.driverPlanned} />
            </div>

            <div
              className="max-h-[340px] overflow-auto rounded-xl p-3 font-mono-code text-[11.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
              style={{
                backgroundColor: 'var(--code-bg)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {preview.compiledMarkdown}
            </div>
          </>
        ) : (
          <div className="py-10 text-center text-[12px] text-[var(--text-muted)]">
            无法加载上下文预览。
          </div>
        )}
      </div>
    </div>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
      <div className="mt-0.5 truncate font-mono-code text-[11.5px] font-semibold text-[var(--text-primary)]">
        {value}
      </div>
    </div>
  );
}

function PillTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
      style={{
        backgroundColor: active ? 'var(--bg-active)' : 'transparent',
        color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
      }}
    >
      {children}
    </button>
  );
}
