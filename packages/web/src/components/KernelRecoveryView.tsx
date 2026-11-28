import type { InstalledPluginInfo } from '@harnessmate/protocol';
import {
  AlertTriangle,
  LayoutGrid,
  PowerOff,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  APPLICATION_VIEW_CONTRACT,
  getPluginInstanceId,
  pluginProvidesContract,
} from '../api/peer-contracts';
import {
  kernelRecoveryClient,
  type KernelCompositionSnapshot,
} from '../kernel/recovery-client';

export interface KernelRecoveryViewProps {
  reasonKind?:
    | 'manual'
    | 'empty_composition'
    | 'entry_unbound'
    | 'entry_disabled'
    | 'entry_unavailable'
    | 'load_failed'
    | 'runtime_error';
  failedInstanceId?: string;
  errorMessage?: string;
  restartRequired?: boolean;
  restartReason?: string;
  onRecovered?: () => void;
}

const REASON_HEADINGS: Record<NonNullable<KernelRecoveryViewProps['reasonKind']>, { title: string; summary: string }> = {
  manual: { title: '内核恢复模式（手动打开）', summary: '此界面独立于管理插件，可安装、启停、恢复修订及组合。当前已启用的后台插件仍由组合管理。' },
  empty_composition: {
    title: '内核恢复模式（空业务组合）',
    summary: '当前未装配任何业务插件，仅保留内核装配、诊断与恢复能力。可启用预装组合、恢复上一套配置，或选择应用布局入口。',
  },
  entry_unbound: {
    title: '内核恢复模式（未绑定应用布局入口）',
    summary: '当前组合尚未显式绑定 application.view.v1 应用入口，宿主不提供隐式默认界面回退。请在下方选择一个布局实例或恢复组合。',
  },
  entry_disabled: {
    title: '内核恢复模式（当前应用布局已停用）',
    summary: '当前绑定的 application.view.v1 布局已被停用，宿主不会自动复活旧界面。可重新启用该布局、切换到其他布局，或恢复组合。',
  },
  entry_unavailable: {
    title: '内核恢复模式（应用布局不可用）',
    summary: '组合绑定的 application.view.v1 实例缺失、未声明应用入口或运行异常。可回退修订、停用异常实例或切换其他布局。',
  },
  load_failed: {
    title: '内核恢复模式（应用布局加载失败）',
    summary: '当前应用布局入口加载失败，已隔离至最小恢复界面。可回退该布局上一修订、停用异常实例、切换到备用布局或恢复组合。',
  },
  runtime_error: {
    title: '内核恢复模式（应用布局运行异常）',
    summary: '当前应用布局渲染时抛出未捕获异常，已安全切换至最小恢复界面。可回退修订、停用实例或恢复上一套配置。',
  },
};

/**
 * Standalone kernel recovery view.
 * Uses only `kernelRecoveryClient` and minimal local state — never imports
 * business `app-store`, `ModalHost`, `Sidebar`, or chat modules.
 */
export function KernelRecoveryView({
  reasonKind = 'empty_composition',
  failedInstanceId,
  errorMessage,
  restartRequired = false,
  restartReason,
  onRecovered,
}: KernelRecoveryViewProps) {
  const [plugins, setPlugins] = useState<InstalledPluginInfo[]>([]);
  const [composition, setComposition] = useState<KernelCompositionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(null);
  const [needsRestart, setNeedsRestart] = useState(restartRequired);
  const [restartHint, setRestartHint] = useState(restartReason ?? '');

  useEffect(() => {
    setNeedsRestart(restartRequired);
    setRestartHint(restartReason ?? '');
  }, [restartRequired, restartReason]);

  const loadDiagnostics = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [pluginsRes, compRes] = await Promise.all([
        kernelRecoveryClient.listPlugins(signal),
        kernelRecoveryClient.getComposition(signal).catch(() => null),
      ]);
      if (signal?.aborted) return;
      setPlugins(pluginsRes.plugins ?? []);
      setComposition(compRes);
    } catch (err) {
      if (signal?.aborted) return;
      setFeedback({
        kind: 'error',
        text: `无法读取内核装配状态: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDiagnostics(controller.signal);
    return () => controller.abort();
  }, [loadDiagnostics]);

  const layoutPlugins = useMemo(
    () => plugins.filter((plugin) => pluginProvidesContract(plugin, APPLICATION_VIEW_CONTRACT)),
    [plugins],
  );
  const erroredPlugins = useMemo(
    () => plugins.filter((plugin) => Boolean(plugin.loadError) || plugin.runtimeState === 'FAILED'),
    [plugins],
  );
  const boundLayoutId = failedInstanceId ?? composition?.bindings?.[APPLICATION_VIEW_CONTRACT] ?? null;
  const boundLayoutPlugin = useMemo(
    () =>
      boundLayoutId
        ? plugins.find((p) => getPluginInstanceId(p) === boundLayoutId || p.id === boundLayoutId)
        : undefined,
    [plugins, boundLayoutId],
  );

  const runAction = async (label: string, fn: () => Promise<void>, successMessage: string) => {
    setBusyAction(label);
    setFeedback(null);
    try {
      await fn();
      await loadDiagnostics();
      setFeedback({ kind: 'success', text: successMessage });
      onRecovered?.();
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: `${label}失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSelectLayout = async (plugin: InstalledPluginInfo) => {
    const instanceId = getPluginInstanceId(plugin);
    await runAction(
      `切换布局 ${plugin.name}`,
      async () => {
        if (!plugin.enabled) {
          await kernelRecoveryClient.togglePlugin(plugin.id, true);
        }
        await kernelRecoveryClient.setCompositionBinding(APPLICATION_VIEW_CONTRACT, instanceId);
      },
      `已绑定应用布局 ${plugin.name} (${instanceId})`,
    );
  };

  const handleRestart = async () => {
    setBusyAction('restart');
    setFeedback(null);
    try {
      const res = await kernelRecoveryClient.requestRestart();
      if (!res.initiated) {
        setNeedsRestart(true);
        setRestartHint(res.reason ?? '请手动刷新或重启应用窗口。');
        setFeedback({ kind: 'info', text: res.reason ?? '请手动刷新或重启应用窗口。' });
      }
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: `重启请求失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const [recoveryId, setRecoveryId] = useState('');
  const [recoveryContract, setRecoveryContract] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [installPreview, setInstallPreview] = useState<Awaited<ReturnType<typeof kernelRecoveryClient.previewInstall>>>();
  const [trustInstall, setTrustInstall] = useState(false);
  const heading = REASON_HEADINGS[reasonKind] ?? REASON_HEADINGS.empty_composition;
  const busy = busyAction !== null;

  return (
    <main
      aria-label="内核恢复模式"
      data-testid="kernel-recovery-view"
      data-recovery-reason={reasonKind}
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6"
      style={{ backgroundColor: 'var(--bg-canvas)' }}
    >
      <div
        className="w-full max-w-2xl space-y-5 rounded-2xl p-6"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-float)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{
              backgroundColor: 'var(--accent-indigo-soft)',
              color: 'var(--accent-indigo)',
            }}
          >
            <ShieldAlert size={20} />
          </div>
          <div className="min-w-0 space-y-1">
            <h1 className="text-[16px] font-semibold text-[var(--text-primary)]">{heading.title}</h1>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{heading.summary}</p>
            {(boundLayoutId || errorMessage) && (
              <div
                role="alert"
                className="mt-2 rounded-xl px-3 py-2 text-[11.5px] text-[var(--accent-rose)]"
                style={{
                  backgroundColor: 'var(--accent-rose-soft)',
                  border: '1px solid color-mix(in srgb, var(--accent-rose) 35%, transparent)',
                }}
              >
                {boundLayoutId && (
                  <div className="font-mono-code">目标入口实例: {boundLayoutId}</div>
                )}
                {errorMessage && <div className="mt-0.5 break-words">{errorMessage}</div>}
              </div>
            )}
          </div>
        </div>

        {needsRestart && (
          <div
            role="status"
            data-testid="kernel-restart-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-[12px]"
            style={{
              backgroundColor: 'var(--accent-star-soft)',
              border: '1px solid color-mix(in srgb, var(--accent-star) 45%, transparent)',
              color: 'var(--text-primary)',
            }}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} style={{ color: 'var(--accent-star)' }} />
              <span>{restartHint || '当前变更需要重启宿主窗口以完整生效。'}</span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRestart()}
              className="cursor-pointer rounded-lg px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              立即重启
            </button>
          </div>
        )}

        {feedback && (
          <div
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className="rounded-xl px-3 py-2 text-[12px]"
            style={{
              backgroundColor:
                feedback.kind === 'error'
                  ? 'var(--accent-rose-soft)'
                  : feedback.kind === 'success'
                    ? 'var(--accent-emerald-soft)'
                    : 'var(--bg-elevated)',
              color:
                feedback.kind === 'error'
                  ? 'var(--accent-rose)'
                  : feedback.kind === 'success'
                    ? 'var(--accent-emerald)'
                    : 'var(--text-primary)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            {feedback.text}
          </div>
        )}

        <section className="space-y-2 rounded-xl border p-3">
          <h2>从本地目录安装恢复插件</h2>
          <input aria-label="恢复插件目录" value={installPath} onChange={e => { setInstallPath(e.target.value); setInstallPreview(undefined); setTrustInstall(false); }} className="w-full bg-transparent border p-2" placeholder="D:/plugins/management-lite" />
          <button disabled={busy || !installPath.trim()} onClick={() => void runAction('预览安装', async () => { setInstallPreview(await kernelRecoveryClient.previewInstall({ mode: 'local_dir', dirPath: installPath.trim() })); }, '已读取包摘要，请核对来源')}>预览包</button>
          {installPreview && <div><p>{installPreview.manifest.name} · {installPreview.manifest.version} · {installPreview.digest}</p>
            {installPreview.requiresTrust && <label><input type="checkbox" checked={trustInstall} onChange={e => setTrustInstall(e.target.checked)} />信任此代码来源</label>}
            <button disabled={busy || (installPreview.requiresTrust && !trustInstall)} onClick={() => void runAction('安装恢复插件', async () => { await kernelRecoveryClient.install({ mode: 'local_dir', dirPath: installPath.trim(), expectedDigest: installPreview.digest, expectedInstalledDigest: installPreview.installedDigest, trustCode: trustInstall }); setInstallPreview(undefined); }, '插件已安装，可启用并选择实例绑定')}>安装此修订</button>
          </div>}
        </section>
        <section className="flex flex-wrap items-center gap-2 rounded border p-3"><h2 className="w-full">实例恢复</h2>
          <select className="w-full rounded border bg-transparent p-2" aria-label="恢复实例" value={recoveryId} onChange={e => setRecoveryId(e.target.value)}><option value="">选择实例</option>{plugins.map(p => <option key={getPluginInstanceId(p)} value={getPluginInstanceId(p)}>{p.name} · {getPluginInstanceId(p)} · {p.enabled ? '启用' : '停用'}</option>)}</select>
          <button className="rounded-lg border px-3 py-1.5" disabled={busy || !recoveryId} onClick={() => void runAction('启用实例', () => kernelRecoveryClient.togglePlugin(recoveryId, true).then(() => {}), '已启用实例')}>启用</button>
          <button className="rounded-lg border px-3 py-1.5" disabled={busy || !recoveryId} onClick={() => void runAction('停用实例', () => kernelRecoveryClient.togglePlugin(recoveryId, false).then(() => {}), '已停用实例')}>停用</button>
          <button className="rounded-lg border px-3 py-1.5" disabled={busy || !recoveryId} onClick={() => void runAction('回退实例', () => kernelRecoveryClient.rollbackPlugin(recoveryId).then(() => {}), '已回退实例')}>上一修订</button>
          <input className="rounded border bg-transparent p-2" aria-label="恢复绑定契约" placeholder="能力契约" value={recoveryContract} onChange={e => setRecoveryContract(e.target.value)} />
          <button className="rounded-lg border px-3 py-1.5" disabled={busy || !recoveryId || !recoveryContract} onClick={() => void runAction('恢复能力绑定', () => kernelRecoveryClient.setCompositionBinding(recoveryContract, recoveryId).then(() => {}), '已恢复能力绑定')}>绑定选中实例</button>
        </section>
        {/* Primary Composition Recovery Actions */}
        <section className="space-y-2">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
            组合与修订恢复
          </h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  '恢复预装组合',
                  () => kernelRecoveryClient.restoreComposition('builtin').then(() => undefined),
                  '已重新启用预装组合',
                )
              }
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12px] font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              <RotateCcw size={13} />
              重新启用预装组合
            </button>

            <button
              type="button"
              disabled={busy || composition?.canRestore === false}
              onClick={() =>
                void runAction(
                  '恢复上一套配置',
                  () => kernelRecoveryClient.restoreComposition('previous').then(() => undefined),
                  '已恢复上一套可用组合配置',
                )
              }
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3.5 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
            >
              恢复上一套配置
            </button>

            {boundLayoutPlugin && boundLayoutPlugin.enabled && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    `停用 ${boundLayoutPlugin.name}`,
                    () => kernelRecoveryClient.togglePlugin(boundLayoutPlugin.id, false).then(() => undefined),
                    `已停用异常布局实例 ${boundLayoutPlugin.id}`,
                  )
                }
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3 py-2 text-[12px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                <PowerOff size={13} />
                停用当前布局
              </button>
            )}

            {boundLayoutPlugin && !boundLayoutPlugin.builtin && boundLayoutPlugin.sourceKind !== 'bundled' && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    `回退修订 ${boundLayoutPlugin.name}`,
                    () => kernelRecoveryClient.rollbackPlugin(boundLayoutPlugin.id).then(() => undefined),
                    `已将 ${boundLayoutPlugin.id} 回退到上一修订`,
                  )
                }
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
              >
                <Undo2 size={13} />
                回退上一修订
              </button>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  '重新加载插件',
                  () => kernelRecoveryClient.reloadPlugins().then(() => undefined),
                  '已重新加载插件清单与状态',
                )
              }
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-45"
            >
              <RefreshCw size={13} />
              刷新诊断
            </button>
          </div>
        </section>

        {/* Available Application Layout Entries */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
              <LayoutGrid size={12} />
              可用应用布局入口 ({APPLICATION_VIEW_CONTRACT})
            </h2>
            {loading && <span className="text-[11px] text-[var(--text-muted)]">加载中…</span>}
          </div>

          {layoutPlugins.length === 0 ? (
            <div
              className="rounded-xl px-3.5 py-3 text-[12px] text-[var(--text-muted)]"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              当前未发现提供 <code>{APPLICATION_VIEW_CONTRACT}</code> 的插件包。可点击上方“重新启用预装组合”或“恢复上一套配置”。
            </div>
          ) : (
            <div className="space-y-2">
              {layoutPlugins.map((plugin) => {
                const instanceId = getPluginInstanceId(plugin);
                const isBound = composition?.bindings?.[APPLICATION_VIEW_CONTRACT] === instanceId;
                const isReady = plugin.enabled && (!plugin.runtimeState || plugin.runtimeState === 'ACTIVE');
                return (
                  <div
                    key={instanceId}
                    data-testid={`recovery-layout-candidate-${instanceId}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: `1px solid ${isBound ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--text-primary)]">
                        <span>{plugin.name}</span>
                        <code className="text-[10.5px] text-[var(--text-muted)]">{instanceId}</code>
                        <span className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]" style={{ backgroundColor: 'var(--bg-surface)' }}>
                          {isReady ? '已就绪' : plugin.enabled ? (plugin.runtimeState ?? '异常') : '已停用'}
                        </span>
                      </div>
                      {plugin.loadError && (
                        <p className="mt-0.5 text-[11px] text-[var(--accent-rose)]">{plugin.loadError}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSelectLayout(plugin)}
                        className="cursor-pointer rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-50"
                        style={{ backgroundColor: 'var(--accent-indigo)' }}
                      >
                        {plugin.enabled ? '切换为此布局' : '启用并切换'}
                      </button>
                      {!plugin.builtin && plugin.sourceKind !== 'bundled' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void runAction(
                              `回退 ${plugin.id}`,
                              () => kernelRecoveryClient.rollbackPlugin(plugin.id).then(() => undefined),
                              `已回退 ${plugin.id} 至上一修订`,
                            )
                          }
                          className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
                        >
                          回退修订
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Diagnostic Summary for Errored Plugins */}
        {erroredPlugins.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[11px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
              加载异常插件诊断 ({erroredPlugins.length})
            </h2>
            <div className="max-h-40 space-y-1.5 overflow-y-auto">
              {erroredPlugins.map((plugin) => (
                <div
                  key={getPluginInstanceId(plugin)}
                  className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
                  style={{
                    backgroundColor: 'var(--accent-rose-soft)',
                    border: '1px solid color-mix(in srgb, var(--accent-rose) 28%, transparent)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--text-primary)]">
                      {plugin.name} <code className="text-[10.5px] opacity-75">({plugin.id})</code>
                    </div>
                    <div className="truncate text-[11px] text-[var(--accent-rose)]">
                      {plugin.loadError ?? `状态: ${plugin.runtimeState}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {plugin.enabled && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            `停用 ${plugin.id}`,
                            () => kernelRecoveryClient.togglePlugin(plugin.id, false).then(() => undefined),
                            `已停用 ${plugin.id}`,
                          )
                        }
                        className="cursor-pointer rounded-lg bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        停用
                      </button>
                    )}
                    {!plugin.builtin && plugin.sourceKind !== 'bundled' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            `回退 ${plugin.id}`,
                            () => kernelRecoveryClient.rollbackPlugin(plugin.id).then(() => undefined),
                            `已回退 ${plugin.id}`,
                          )
                        }
                        className="cursor-pointer rounded-lg bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        回退
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="flex items-center justify-between border-t border-[var(--border-hairline)] pt-3 text-[11px] text-[var(--text-muted)]">
          <span>
            组合包: {composition?.bundles?.length ? composition.bundles.join(', ') : '空组合'} · 已发现插件 {plugins.length} 个
          </span>
          <span>恢复模式不依赖完整插件管理中心</span>
        </footer>
      </div>
    </main>
  );
}
