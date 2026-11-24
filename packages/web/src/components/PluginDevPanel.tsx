import type { InstalledPluginInfo, PluginScaffoldTemplateDto } from '@harnessmate/protocol';
import { FolderOpen, Hammer, Link2, RefreshCw, Terminal, Unlink } from 'lucide-react';
import { useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

export function PluginDevPanel({
  plugins,
  onOpenLogs,
}: {
  plugins: InstalledPluginInfo[];
  onOpenLogs: (pluginId: string) => void;
}) {
  const { refreshPlugins, pushToast } = useAppStore();
  const [devDir, setDevDir] = useState('');
  const [busy, setBusy] = useState(false);

  // Scaffolder form state
  const [id, setId] = useState('user.my-v4-plugin');
  const [name, setName] = useState('我的 V4 插件');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<PluginScaffoldTemplateDto>('isolated');
  const [serviceName, setServiceName] = useState('acme.helper');
  const [targetDir, setTargetDir] = useState('');
  const [linkDevMode, setLinkDevMode] = useState(true);
  const [lastCreated, setLastCreated] = useState<{ dirPath: string; files: string[] } | null>(null);

  const devPlugins = plugins.filter((p) => p.devMode);

  const pickDirectory = async (setter: (path: string) => void) => {
    const picked = await window.harnessMateBridge?.pickDirectory();
    if (picked) setter(picked);
  };

  const handleLink = async () => {
    if (!devDir.trim()) return;
    setBusy(true);
    try {
      await daemonApi.linkDevPlugin(devDir.trim());
      await refreshPlugins();
      setDevDir('');
      pushToast({ kind: 'success', title: '已关联开发模式插件', body: '保存源码文件后将自动热重载' });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '关联开发目录失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReload = async (pluginId: string) => {
    setBusy(true);
    try {
      await daemonApi.reloadDevPlugin(pluginId);
      await refreshPlugins();
      pushToast({ kind: 'success', title: `已热重载 ${pluginId}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '热重载失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (pluginId: string) => {
    setBusy(true);
    try {
      await daemonApi.unlinkDevPlugin(pluginId);
      await refreshPlugins();
      pushToast({ kind: 'info', title: `已取消关联 ${pluginId}`, body: '本地源码目录保持不变' });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '取消关联失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleScaffold = async () => {
    setBusy(true);
    try {
      const res = await daemonApi.scaffoldPlugin({
        id: id.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        template,
        serviceName: template === 'service' ? serviceName.trim() : undefined,
        targetDir: targetDir.trim() || undefined,
        linkDevMode,
      });
      await refreshPlugins();
      setLastCreated({ dirPath: res.dirPath, files: res.files });
      pushToast({
        kind: 'success',
        title: `已生成插件脚手架 ${id.trim()}`,
        body: linkDevMode ? '已自动进入开发模式并监听文件变更' : `输出目录：${res.dirPath}`,
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '生成脚手架失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-[12px]">
      {/* Section 1: Dev Mode Link & Active Watchers */}
      <section className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
        <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <Link2 size={14} className="text-[var(--accent-indigo)]" />
          <span>开发模式（本地源码目录热重载）</span>
        </div>
        <p className="text-[11.5px] text-[var(--text-secondary)]">
          关联包含 <code>harnessmate-plugin.json</code> 的本地目录。保存代码或 HTML 后，宿主自动回滚旧实例 effect 并重载新版本（仅本机可用）。
        </p>
        <div className="flex gap-2">
          <input
            value={devDir}
            onChange={(e) => setDevDir(e.target.value)}
            placeholder="输入本地插件源码目录路径..."
            className="min-w-0 flex-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
          />
          {window.harnessMateBridge?.pickDirectory && (
            <button
              type="button"
              onClick={() => void pickDirectory(setDevDir)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            >
              <FolderOpen size={12.5} />
              浏览
            </button>
          )}
          <button
            type="button"
            disabled={busy || !devDir.trim()}
            onClick={() => void handleLink()}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            关联开发目录
          </button>
        </div>

        {devPlugins.length > 0 && (
          <div className="space-y-2 pt-1">
            {devPlugins.map((p) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--text-primary)]">{p.name}</span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ backgroundColor: 'var(--accent-star-soft)', color: 'var(--accent-star)' }}
                    >
                      开发中
                    </span>
                    <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                      {p.runtimeState ?? (p.enabled ? 'ACTIVE' : 'DISABLED')}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono-code text-[10.5px] text-[var(--text-muted)]">
                    {p.devSourceDir}
                  </div>
                  {p.loadError && (
                    <div className="mt-1 break-words text-[11px] text-[var(--accent-rose)]">{p.loadError}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onOpenLogs(p.id)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Terminal size={11} />
                    日志
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleReload(p.id)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
                  >
                    <RefreshCw size={11} />
                    重载
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlink(p.id)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-rose)] hover:bg-[var(--accent-rose-soft)]"
                  >
                    <Unlink size={11} />
                    取消关联
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: V4 Plugin Scaffolder */}
      <section className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5">
        <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
          <Hammer size={14} className="text-[var(--accent-emerald)]" />
          <span>创建 V4 插件脚手架</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-[var(--text-secondary)]">插件 ID</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="user.my-plugin"
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-code text-[11.5px] text-[var(--text-primary)]"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-[var(--text-secondary)]">显示名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="我的插件"
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-[var(--text-secondary)]">模板类型</span>
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value as PluginScaffoldTemplateDto)}
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]"
            >
              <option value="isolated">隔离代码 + 沙箱 UI 插槽 (推荐)</option>
              <option value="harness-adapter">第三方 Harness 引擎驱动 (V5 Adapter)</option>
              <option value="ui-slot">纯声明式沙箱 UI 插槽</option>
              <option value="browser-preview">浏览器预览</option>
              <option value="service">第三方服务提供方 (provides)</option>
              <option value="declarative">纯声明式斜杠命令 + 数据面板</option>
            </select>
          </label>
          {template === 'service' ? (
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-secondary)]">提供服务名 (带命名空间前缀)</span>
              <input
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="acme.helper"
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-code text-[11.5px] text-[var(--text-primary)]"
              />
            </label>
          ) : (
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-secondary)]">输出目录（留空则默认写入数据目录）</span>
              <input
                value={targetDir}
                onChange={(e) => setTargetDir(e.target.value)}
                placeholder="可选：自定义空目录路径"
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono-code text-[11.5px] text-[var(--text-primary)]"
              />
            </label>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] text-[var(--text-secondary)]">简介（可选）</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话说明插件用途"
            className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={linkDevMode}
              onChange={(e) => setLinkDevMode(e.target.checked)}
            />
            创建后立即以开发模式关联并监听变更
          </label>
          <button
            type="button"
            disabled={busy || !id.trim() || !name.trim()}
            onClick={() => void handleScaffold()}
            className="cursor-pointer rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-emerald)' }}
          >
            生成脚手架
          </button>
        </div>

        {lastCreated && (
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 font-mono-code text-[11px] text-[var(--text-secondary)]">
            <div className="text-[var(--accent-emerald)]">已生成：{lastCreated.dirPath}</div>
            <div className="mt-1 text-[var(--text-muted)]">文件：{lastCreated.files.join(', ')}</div>
          </div>
        )}
      </section>
    </div>
  );
}
