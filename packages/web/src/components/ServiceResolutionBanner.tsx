import type { InstalledPluginInfo } from '@harnessmate/protocol';
import { AlertTriangle, CheckCircle2, HelpCircle, PlugZap } from 'lucide-react';
import type { ReactNode } from 'react';
import { getPluginInstanceId, type ServiceResolutionV1 } from '../api/peer-contracts';
import { formatResolutionSummary, formatSelectionSource } from '../api/peer-workspace-client';

export function ServiceResolutionBanner({
  title,
  resolution,
  plugins,
  selectedInstanceId,
  onSelectInstance,
  workspaceName,
  onBindWorkspace,
  extraRight,
}: {
  title: string;
  resolution: ServiceResolutionV1;
  plugins: InstalledPluginInfo[];
  selectedInstanceId?: string | null;
  onSelectInstance?: (instanceId: string | null) => void;
  workspaceName?: string | null;
  onBindWorkspace?: (instanceId: string | null) => void;
  extraRight?: ReactNode;
}) {
  const summary = formatResolutionSummary(resolution);
  const pluginNames = new Map(
    plugins.map((p) => [getPluginInstanceId(p), p.name]),
  );

  const badgeColors =
    summary.tone === 'ready'
      ? { bg: 'var(--accent-emerald-soft)', fg: 'var(--accent-emerald)' }
      : summary.tone === 'warning'
        ? { bg: 'var(--accent-star-soft)', fg: 'var(--accent-star)' }
        : summary.tone === 'error'
          ? { bg: 'var(--accent-rose-soft)', fg: 'var(--accent-rose)' }
          : { bg: 'var(--bg-surface)', fg: 'var(--text-muted)' };

  const currentVal = selectedInstanceId ?? resolution.instanceId ?? '';
  const hasCurrentInCandidates = resolution.candidates.some(
    (c) => c.instanceId === currentVal,
  );

  return (
    <div
      data-testid={`resolution-banner-${resolution.contract}`}
      data-resolution-status={resolution.status}
      data-resolution-source={resolution.source}
      data-resolution-instance={resolution.instanceId ?? ''}
      className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl px-3.5 py-2.5 text-[12px]"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[var(--text-primary)]">{title}</span>
          <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
            {resolution.contract} ({resolution.versionRange})
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium"
            style={{ backgroundColor: badgeColors.bg, color: badgeColors.fg }}
          >
            {summary.tone === 'ready' ? (
              <CheckCircle2 size={11} />
            ) : summary.tone === 'muted' ? (
              <HelpCircle size={11} />
            ) : (
              <AlertTriangle size={11} />
            )}
            <span>{summary.label}</span>
          </span>
          {resolution.instanceId && (
            <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--text-secondary)]">
              {resolution.instanceId} · {formatSelectionSource(resolution.source)}
            </span>
          )}
        </div>
        <p className="text-[11.5px] text-[var(--text-secondary)]">{summary.detail}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {onSelectInstance && (resolution.candidates.length > 0 || Boolean(resolution.instanceId)) && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <PlugZap size={12} className="text-[var(--accent-indigo)]" />
            <span>实例</span>
            <select
              aria-label={`${title}实例选择`}
              value={currentVal}
              onChange={(event) => onSelectInstance(event.target.value || null)}
              className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 font-mono-code text-[11px] text-[var(--text-primary)]"
            >
              {!currentVal && <option value="">请选择实例...</option>}
              {currentVal && !hasCurrentInCandidates && (
                <option value={currentVal}>
                  {pluginNames.get(currentVal) ?? currentVal} ({currentVal} · {summary.label})
                </option>
              )}
              {resolution.candidates.map((cand) => (
                <option key={cand.instanceId} value={cand.instanceId}>
                  {pluginNames.get(cand.instanceId) ?? cand.pluginId} ({cand.instanceId} v{cand.version})
                </option>
              ))}
            </select>
          </label>
        )}
        {onBindWorkspace && workspaceName && resolution.instanceId && resolution.status === 'ready' && (
          <button
            type="button"
            onClick={() => onBindWorkspace(resolution.instanceId)}
            className="cursor-pointer rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
          >
            绑定到「{workspaceName}」
          </button>
        )}
        {extraRight}
      </div>
    </div>
  );
}
