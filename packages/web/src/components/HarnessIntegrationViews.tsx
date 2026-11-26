import { Check, Loader2, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HarnessServiceScope } from '../api/client';
import { formatCountdown, formatTokenCount, getHarnessMeta, resolveHarnessMeta } from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';
import { HarnessBadge } from './BrandMark';
import { PillTab, StudioHeader } from './StudioModalControls';

// ── 2. Unified Cross-CLI MCP Hub ───────────────────────────────────────

export function McpHubModal({ onClose, scope }: { onClose: () => void; scope: HarnessServiceScope }) {
  const {
    harnesses,
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
  const [targets, setTargets] = useState<string[]>(['agy']);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void refreshMcpServers(scope);
  }, [refreshMcpServers, scope]);

  const filtered = mcpServers.filter((s) => filterHarness === 'all' || s.harnessId === filterHarness);

  const targetIds = [...new Set(['codex', 'agy', 'claude', ...harnesses
    .filter(({ kind }) => ['codex', 'agy', 'claude'].includes(kind)).map(({ id }) => id)])];

  const toggleTarget = (h: string) => {
    setTargets((prev) => (prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h]));
  };

  const handleAdd = async () => {
    if (!name.trim() || targets.length === 0) return;
    if (!window.confirm(`允许 ${targets.join('、')} 使用 MCP 服务器 ${name.trim()}？`)) return;
    setSubmitting(true);
    try {
      const results = await addMcpServer({
        targetHarnesses: targets,
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio' ? argsText.trim().split(/\s+/).filter(Boolean) : [],
        url: transport !== 'stdio' ? url.trim() : undefined,
      }, scope);
      const failed = results.filter(({ ok }) => !ok).map(({ harnessId }) => harnessId);
      if (failed.length) {
        setTargets(failed);
        return;
      }
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
          onClick={() => void refreshMcpServers(scope)}
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
              {['all', ...targetIds].map((k) => (
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
                        <span className="text-[11px] text-[var(--text-muted)]">{s.harnessId}</span>
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
                      {s.harnessKind === 'agy' && (
                        <button
                          type="button"
                          onClick={() =>
                            void toggleMcpServer({
                              harnessId: s.harnessId,
                              name: s.name,
                              enabled: s.status === 'disabled',
                            }, scope)
                          }
                          className="cursor-pointer rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                          style={{ border: '1px solid var(--border-hairline)' }}
                        >
                          {s.status === 'disabled' ? '启用' : '停用'}
                        </button>
                      )}
                      {targetIds.includes(s.harnessId) &&
                        s.commandOrUrl !== 'Codex Runtime MCP' && (
                          <button
                            type="button"
                            title="移除此 MCP"
                            onClick={() =>
                              void removeMcpServer(
                                s.harnessId,
                                s.name,
                                scope,
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
                {targetIds.map((h) => {
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
                      <span>{harnesses.find(({ id }) => id === h)?.displayName ?? getHarnessMeta(h).shortLabel}</span>
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

export function UsageDashboardModal({ onClose, scope }: { onClose: () => void; scope: HarnessServiceScope }) {
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
    void refreshAccountUsage(false, scope);
    void refreshFailoverPolicy(scope);
  }, [refreshAccountUsage, refreshFailoverPolicy, scope]);

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
      await updateFailoverPolicy(policyDraft, scope);
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
            onClick={() => void refreshAccountUsage(true, scope)}
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
