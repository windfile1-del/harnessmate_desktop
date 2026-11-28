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
  Plus,
  Puzzle,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { daemonApi } from '../../api/client';
import {
  formatTokenCount,
  getHarnessMeta,
  resolveHarnessMeta,
} from '../../lib/harness-meta';
import { useManagementStore as useAppStore } from './store';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { HarnessBadge } from '../../components/BrandMark';
import { ModelPicker } from '../../components/ModelPicker';
import { MetricMini, PillTab, StudioHeader } from '../../components/StudioModalControls';
import { LocalInstallForm } from './LocalInstallForm';

import { PluginLogsPanel } from './PluginLogsPanel';
import { PluginPermissionsEditor } from './PluginPermissionsEditor';

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

export function PluginStudioModal({ onClose, bridge }: { onClose: () => void; bridge: TrustedModulePageBridge }) {
  const {
    openDeveloperTools,
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
    selectedWorkspaceId,
    selectedSessionId,
    sessionBindingsBySession,
    refreshSessionBindings,
    setSessionBinding,
    workspaces,
    pluginPermissionRevision,
  } = useAppStore();

  const previewWorkspace = workspaces.find(({ id }) => id === selectedWorkspaceId) ?? workspaces[0];
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
  const [renderFailures, setRenderFailures] = useState(() => bridge.surfaces.getRenderFailures());
  useEffect(() => bridge.surfaces.onSlotsChanged(() => setRenderFailures(bridge.surfaces.getRenderFailures())), [bridge]);
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
    void daemonApi.getPluginComposition(previewWorkspace?.id).then((result) => { if (current) setComposition(result); })
      .catch((error: Error) => { if (current) pushToast({ kind: 'error', title: '无法读取组合', body: error.message }); });
    return () => { current = false; };
  }, [plugins, pluginPermissionRevision, previewWorkspace?.id, pushToast]);

  useEffect(() => {
    if (selectedSessionId) void refreshSessionBindings(selectedSessionId).catch(() => {});
  }, [selectedSessionId, plugins, refreshSessionBindings]);

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
          <button type="button" onClick={() => void openDeveloperTools()}>AI 插件开发</button>
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
                    onClick={() => bridge.surfaces.clearRenderFailure()}
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
                      onClick={() => bridge.surfaces.clearRenderFailure(failure.id)}
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
                      onClick={() => void openDeveloperTools({ editing: { manifest: PluginManifestSchema.parse(p), digest: p.packageDigest! } })}>AI 改版</button>
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
          <LocalInstallForm initialManifest={editing ? JSON.stringify(editing.manifest, null, 2) : MANIFEST_TEMPLATE} onInstalled={() => { setEditing(undefined); setTab('installed'); }} />
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
              <button type="button" disabled={busy}
                className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[var(--accent-rose)] disabled:opacity-50"
                onClick={() => {
                  if (window.confirm('切换到空业务组合（仅保留内核恢复页面）？插件文件和历史数据会保留。')) {
                    void runPluginAction(() => restorePluginComposition('empty'));
                  }
                }}>进入空业务组合（仅内核）</button>
            </div>
            <div className="space-y-2 rounded-xl border border-[var(--border-hairline)] p-3">
              <p className="font-medium text-[var(--text-primary)]">能力依赖绑定（平级实例选择）</p>
              {[...new Set((composition.serviceProviders ?? []).map(p => p.contract))].sort().map((contract) => {
                const providers = (composition.serviceProviders ?? []).filter((item) => item.contract === contract);
                const label = contract;
                const sessionValue = selectedSessionId ? (sessionBindingsBySession[selectedSessionId]?.[contract] ?? '') : '';
                return (
                  <div key={contract} className="space-y-1 border-t border-[var(--border-hairline)] pt-2 first:border-t-0 first:pt-0">
                    <label className="flex flex-wrap items-center justify-between gap-2">
                      <span>{label}</span>
                      <select
                        aria-label={`组合默认 ${contract}`}
                        value={composition.bindings?.[contract] ?? ''}
                        disabled={busy || composition.safeMode || Boolean(composition.error)}
                        className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 disabled:opacity-50"
                        onChange={(event) => {
                          const instanceId = event.target.value || null;
                          void runPluginAction(async () => {
                            await daemonApi.setCompositionBinding(contract, instanceId);
                            await refreshPlugins();
                          });
                        }}
                      >
                        <option value="">自动选择默认实现</option>
                        {providers.map((provider) => (
                          <option key={provider.instanceId} value={provider.instanceId}>
                            {provider.name} ({provider.instanceId}){provider.state === 'ACTIVE' ? '' : ` · ${provider.state}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedSessionId && (
                      <label className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                        <span>当前会话绑定</span>
                        <select
                          aria-label={`当前会话 ${contract}`}
                          value={sessionValue}
                          disabled={busy}
                          className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 disabled:opacity-50"
                          onChange={(event) => {
                            const instanceId = event.target.value || null;
                            void runPluginAction(() => setSessionBinding(selectedSessionId, contract, instanceId));
                          }}
                        >
                          <option value="">跟随组合/工作区默认</option>
                          {providers.map((provider) => (
                            <option key={provider.instanceId} value={provider.instanceId}>
                              {provider.name} ({provider.instanceId})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="space-y-1 rounded-xl border border-[var(--border-hairline)] p-3">
              <label className="flex flex-wrap items-center justify-between gap-2">
                <span>右侧文件预览</span>
                <select
                  value={composition.extensions?.filePreviewProvider ?? ''}
                  disabled={busy || composition.safeMode || Boolean(composition.error)}
                  className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 disabled:opacity-50"
                  onChange={(event) => {
                    const provider = event.target.value || null;
                    void runPluginAction(async () => {
                      await daemonApi.setFilePreviewProvider(provider, previewWorkspace?.id);
                      await refreshPlugins();
                    });
                  }}
                >
                  <option value="">内置文本预览</option>
                  {composition.extensions?.filePreviewProvider && !composition.filePreviewProviders.some(
                    ({ id }) => id === composition.extensions?.filePreviewProvider,
                  ) && <option value={composition.extensions.filePreviewProvider} disabled>{composition.extensions.filePreviewProvider}（未安装）</option>}
                  {composition.filePreviewProviders.map(({ id, name, extensions, ready, authorized }) => (
                    <option key={id} value={id} disabled={!ready || !authorized}>
                      {name} · {extensions.join('、')}{ready ? (authorized ? '' : '（待授权）') : '（未就绪）'}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[var(--text-muted)]">
                {previewWorkspace ? `按「${previewWorkspace.name}」检查工作区授权。` : '创建工作区后可为预览插件授权。'}
              </p>
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
                {entry.bindings && Object.keys(entry.bindings).length > 0 && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    依赖绑定：{Object.entries(entry.bindings).map(([k, v]) => `${k} → ${v}`).join(' · ')}
                  </p>
                )}
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
