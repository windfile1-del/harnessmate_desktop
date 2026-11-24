import { useShallow } from 'zustand/react/shallow';
import {
  Activity,
  Command,
  Cpu,
  FolderGit2,
  FolderPlus,
  Moon,
  Plug,
  Plus,
  Puzzle,
  Search,
  Smartphone,
  Sun,
  Trash2,
} from 'lucide-react';
import { formatRelativeTime, resolveHarnessMeta } from '../lib/harness-meta';
import { Slot, useSlotItems } from '../slots';
import { useAppStore } from '../stores/app-store';
import { StarLoomCrest } from './BrandMark';

export function Sidebar() {
  const {
    theme,
    toggleTheme,
    connected,
    harnesses,
    workspaces,
    sessions,
    plugins,
    remoteStatus,
    selectedWorkspaceId,
    searchQuery,
    selectedSessionId,
    setSelectedWorkspaceId,
    setSearchQuery,
    selectSession,
    deleteSession,
    openModal,
    isPluginEnabled,
  } = useAppStore(useShallow((state) => ({
    theme: state.theme,
    toggleTheme: state.toggleTheme,
    connected: state.connected,
    harnesses: state.harnesses,
    workspaces: state.workspaces,
    sessions: state.sessions,
    plugins: state.plugins,
    remoteStatus: state.remoteStatus,
    selectedWorkspaceId: state.selectedWorkspaceId,
    searchQuery: state.searchQuery,
    selectedSessionId: state.selectedSessionId,
    setSelectedWorkspaceId: state.setSelectedWorkspaceId,
    setSearchQuery: state.setSearchQuery,
    selectSession: state.selectSession,
    deleteSession: state.deleteSession,
    openModal: state.openModal,
    isPluginEnabled: state.isPluginEnabled,
  })));

  const readyCount = harnesses.filter((h) => h.health === 'ready').length;
  const enabledPluginsCount = plugins.filter((p) => p.enabled).length;
  const activeDevicesCount = (remoteStatus?.pairedDevices ?? []).filter((d) => !d.revokedAt).length;

  const filteredSessions = sessions.filter((s) => {
    if (selectedWorkspaceId && s.workspaceId !== selectedWorkspaceId) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const participating = (s.participatingHarnesses ?? [s.harnessId]).join(' ').toLowerCase();
      if (
        !s.title.toLowerCase().includes(q) &&
        !s.harnessId.toLowerCase().includes(q) &&
        !participating.includes(q)
      ) {
        return false;
      }
    }
    return true;
  });

  const harnessById = new Map(harnesses.map((h) => [h.id, h]));
  const sidebarToolSlots = useSlotItems('sidebar.tools');
  const panelSession = filteredSessions.find(({ id }) => id === selectedSessionId)
    ?? sessions.find(({ workspaceId }) => !selectedWorkspaceId || workspaceId === selectedWorkspaceId);

  const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

  return (
    <aside
      className="flex h-full w-[268px] shrink-0 flex-col select-none"
      style={{
        backgroundColor: 'var(--bg-rail)',
        borderRight: '1px solid var(--border-hairline)',
      }}
    >
      {/* Top Brand Header */}
      <div className="app-drag flex items-center justify-between px-4 pt-4 pb-3">
        <button
          type="button"
          onClick={() => void selectSession(null)}
          className="app-no-drag flex cursor-pointer items-center gap-2.5 text-left"
        >
          <StarLoomCrest size={28} />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[14px] font-semibold tracking-tight text-[var(--text-primary)]">
                HarnessMate
              </span>
              <span
                className="h-1.5 w-1.5 rounded-full"
                title={connected ? '本地守护服务已连接' : '重连中...'}
                style={{
                  backgroundColor: connected ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                }}
              />
            </div>
            <p className="text-[10px] tracking-widest text-[var(--text-muted)]">
              MODULAR HARNESS ATELIER
            </p>
          </div>
        </button>

        <div className="app-no-drag flex items-center gap-1">
          <button
            type="button"
            onClick={() => openModal('harnesses')}
            title={`CLI 引擎 (${readyCount}/${harnesses.length} 就绪)`}
            className="flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 font-mono-code text-[10.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <Cpu size={12} className="text-[var(--accent-emerald)]" />
            <span>
              {readyCount}/{harnesses.length}
            </span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换暖宣浅色主题' : '切换夜织深色主题'}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </div>

      {/* Primary New Session CTA + Command Palette */}
      <div className="flex items-center gap-1.5 px-3.5 pb-3">
        <button
          type="button"
          onClick={() => openModal('new_session')}
          className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl px-3 py-2 text-[12.8px] font-medium text-white transition-all active:scale-[0.99]"
          style={{
            background:
              'linear-gradient(135deg, var(--accent-indigo) 0%, color-mix(in srgb, var(--accent-indigo) 78%, #9b7bff) 100%)',
            boxShadow: '0 6px 20px -6px color-mix(in srgb, var(--accent-indigo) 65%, transparent)',
          }}
        >
          <Plus size={14.5} strokeWidth={2.2} />
          <span>新建会话</span>
        </button>

        <button
          type="button"
          onClick={() => openModal('command_palette')}
          title="全局命令面板 (Ctrl+K)"
          className="flex h-[36px] cursor-pointer items-center gap-1 rounded-xl px-2.5 text-[11px] font-mono-code text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <Command size={12} />
          <span>K</span>
        </button>
      </div>

      {sidebarToolSlots.length > 0 && (
        <div className="max-h-36 space-y-1 overflow-y-auto px-3.5 pb-2">
          <Slot
            name="sidebar.tools"
            slotProps={{ session: panelSession ?? null }}
            compactErrors
            className="space-y-1"
          />
        </div>
      )}

      {/* Workspaces Strip */}
      <div className="px-3.5 pb-2.5">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[10.5px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
            工作区
          </span>
          <button
            type="button"
            onClick={() => openModal('add_workspace')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <FolderPlus size={12} />
            <span>添加</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedWorkspaceId(null)}
            className="cursor-pointer rounded-lg px-2.5 py-1 text-[11.5px] transition-colors"
            style={{
              backgroundColor: selectedWorkspaceId === null ? 'var(--bg-active)' : 'transparent',
              color: selectedWorkspaceId === null ? 'var(--accent-indigo)' : 'var(--text-secondary)',
              border: `1px solid ${selectedWorkspaceId === null ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            全部
          </button>
          {workspaces.map((ws) => {
            const active = selectedWorkspaceId === ws.id;
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => setSelectedWorkspaceId(active ? null : ws.id)}
                title={ws.rootPath}
                className="inline-flex max-w-[138px] cursor-pointer items-center gap-1 truncate rounded-lg px-2.5 py-1 text-[11.5px] transition-colors"
                style={{
                  backgroundColor: active ? 'var(--bg-active)' : 'transparent',
                  color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                  border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                }}
              >
                <FolderGit2 size={11.5} className="shrink-0 opacity-75" />
                <span className="truncate">{ws.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Unified Session Search (No Harness Silos) */}
      <div className="space-y-2 px-3.5 pb-2">
        <div
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索共享任务会话..."
            className="w-full bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-between px-1">
          <span className="text-[10.5px] font-medium uppercase tracking-widest text-[var(--text-muted)]">
            统一任务会话 ({filteredSessions.length})
          </span>
          <span className="text-[10px] text-[var(--text-muted)] opacity-80">
            多引擎共享
          </span>
        </div>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto px-2.5 py-1">
        {filteredSessions.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-[12.5px] text-[var(--text-muted)]">暂无匹配的会话</p>
            <p className="mt-1 text-[11px] text-[var(--text-muted)] opacity-80">
              点击上方新建，会话内可随时无缝切换引擎
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredSessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const sessionHarness = harnessById.get(session.harnessId);
              const meta = resolveHarnessMeta(
                { harness: sessionHarness, harnessId: session.harnessId, harnessKind: session.harnessKind },
                harnesses,
              );
              const ws = workspaceMap.get(session.workspaceId);
              const needsApproval =
                session.status === 'awaiting_approval' || session.pendingApprovalCount > 0;
              const isRunning = session.status === 'running';
              const participants =
                session.participatingHarnesses && session.participatingHarnesses.length > 0
                  ? session.participatingHarnesses
                  : [session.harnessId];

              return (
                <div
                  key={session.id}
                  onClick={() => void selectSession(session.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') void selectSession(session.id);
                  }}
                  className="group relative flex cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 transition-all"
                  style={{
                    backgroundColor: selected ? 'var(--bg-surface)' : 'transparent',
                    border: `1px solid ${
                      needsApproval
                        ? 'color-mix(in srgb, var(--accent-star) 48%, transparent)'
                        : selected
                          ? 'var(--border-strong)'
                          : 'transparent'
                    }`,
                    boxShadow: selected ? 'var(--shadow-card)' : 'none',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                          needsApproval || isRunning ? 'animate-pulse-halo' : ''
                        }`}
                        style={{
                          backgroundColor: needsApproval
                            ? 'var(--accent-star)'
                            : session.status === 'error'
                              ? 'var(--accent-rose)'
                              : meta.accentColor,
                        }}
                      />
                      <span className="truncate text-[12.6px] font-medium text-[var(--text-primary)]">
                        {session.title}
                      </span>
                      <Slot
                        name="session.sidebar.badge"
                        slotProps={{ session }}
                        compactErrors
                        className="inline-flex shrink-0 items-center gap-1"
                      />
                    </div>

                    <button
                      type="button"
                      title="删除会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteSession(session.id);
                      }}
                      className="opacity-0 transition-opacity group-hover:opacity-100 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)]"
                    >
                      <Trash2 size={12.5} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-2 pl-4 text-[11px] text-[var(--text-muted)]">
                    <div className="flex min-w-0 items-center gap-1.5 truncate">
                      {/* Multi-Harness Collaboration Constellation */}
                      <span
                        className="inline-flex shrink-0 items-center gap-1"
                        title={`协作引擎: ${participants.join(' · ')}（当前激活: ${session.harnessId}）`}
                      >
                        {participants.map((pid) => {
                          const pInfo = harnessById.get(pid);
                          const pKind = pInfo?.kind ?? (pid === session.harnessId ? session.harnessKind : 'acp');
                          const pMeta = resolveHarnessMeta(
                            { harness: pInfo, harnessId: pid, harnessKind: pKind },
                            harnesses,
                          );
                          const isCurrent = pid === session.harnessId;
                          return (
                            <span
                              key={pid}
                              className="inline-flex items-center gap-0.5 font-medium"
                              style={{
                                color: isCurrent ? pMeta.accentColor : 'var(--text-muted)',
                                opacity: isCurrent ? 1 : 0.72,
                              }}
                            >
                              {!isCurrent && (
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: pMeta.accentColor }}
                                />
                              )}
                              {isCurrent && <span>{pMeta.shortLabel}</span>}
                            </span>
                          );
                        })}
                      </span>
                      {ws && (
                        <>
                          <span className="opacity-40">·</span>
                          <span className="truncate">{ws.name}</span>
                        </>
                      )}
                    </div>
                    <span className="shrink-0 tabular-nums text-[10.5px]">
                      {needsApproval
                        ? '待审批'
                        : isRunning
                          ? '运行中'
                          : formatRelativeTime(session.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom 2x2 Modular Plugin Dock */}
      <div
        className="grid grid-cols-2 gap-1.5 p-2.5"
        style={{ borderTop: '1px solid var(--border-hairline)' }}
      >
        <DockTile
          icon={<Puzzle size={13.5} style={{ color: 'var(--accent-indigo)' }} />}
          title="插件中心"
          subtitle={`${enabledPluginsCount} 已启用`}
          onClick={() => openModal('plugins')}
        />

        {isPluginEnabled('core.mcp-hub') && (
          <DockTile
            icon={<Plug size={13.5} style={{ color: 'var(--accent-emerald)' }} />}
            title="MCP 中心"
            subtitle="跨 CLI 管理"
            onClick={() => openModal('mcp')}
          />
        )}

        {isPluginEnabled('core.account-usage') && (
          <DockTile
            icon={<Activity size={13.5} style={{ color: 'var(--accent-clay)' }} />}
            title="账号用量"
            subtitle="限额与统计"
            onClick={() => openModal('usage')}
          />
        )}

        {isPluginEnabled('core.remote-mobile') && (
          <DockTile
            icon={
              <Smartphone
                size={13.5}
                style={{
                  color: remoteStatus?.lanEnabled ? 'var(--accent-emerald)' : 'var(--accent-star)',
                }}
              />
            }
            title="手机联动"
            subtitle={
              remoteStatus?.lanEnabled
                ? activeDevicesCount > 0
                  ? `${activeDevicesCount} 台已配对`
                  : '局域网已开'
                : '仅本机'
            }
            highlight={Boolean(remoteStatus?.lanEnabled)}
            onClick={() => openModal('remote_pairing')}
          />
        )}
      </div>
    </aside>
  );
}

function DockTile({
  icon,
  title,
  subtitle,
  highlight = false,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  highlight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1px solid ${
          highlight
            ? 'color-mix(in srgb, var(--accent-emerald) 40%, transparent)'
            : 'var(--border-hairline)'
        }`,
      }}
    >
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-[11.5px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="truncate text-[10px] text-[var(--text-muted)]">{subtitle}</div>
      </div>
    </button>
  );
}
