import { Lock, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react';
import { EntityStatusBadge, EvidenceDetails } from '../shared';
import type { BoostEligibilityBannerModel } from './types';

export interface BoostEligibilityBannerProps {
  model: BoostEligibilityBannerModel;
  onRefresh?: () => void;
}

/**
 * Displays actual Boost plan/tier advertisement, capability gates, and deterministic
 * ineligibility / no-auto-upgrade guarantees.
 */
export function BoostEligibilityBanner({ model, onRefresh }: BoostEligibilityBannerProps) {
  const advertisedLabel =
    model.advertised === true
      ? '已广告 /boost'
      : model.advertised === false
        ? '未广告 / 已撤销'
        : '尚未收到广播';

  return (
    <section
      data-testid="np09-boost-eligibility-banner"
      data-boost-eligibility-reason={model.reasonCode}
      aria-label="Boost 资格与广告状态"
      className="space-y-2 rounded-2xl border p-3 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: model.isEligibleToLaunch
          ? 'color-mix(in srgb, var(--accent-emerald) 38%, transparent)'
          : 'var(--border-strong)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {model.isEligibleToLaunch ? (
            <ShieldCheck
              size={15}
              className="mt-0.5 shrink-0 text-[var(--accent-emerald)]"
              aria-hidden="true"
            />
          ) : model.launchGate === 'unsupported' ? (
            <ShieldOff
              size={15}
              className="mt-0.5 shrink-0 text-[var(--accent-rose)]"
              aria-hidden="true"
            />
          ) : (
            <Sparkles
              size={15}
              className="mt-0.5 shrink-0 text-[var(--accent-indigo)]"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {model.headline}
              </h3>
              <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--text-muted)]">
                {model.capabilityId} · rev #{model.snapshotRevision}
              </span>
            </div>
            <p className="mt-1 leading-relaxed text-[var(--text-secondary)]">
              {model.explanation}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <EntityStatusBadge kind="gate" gate={model.launchGate} compact />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px] sm:grid-cols-3">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            计划/等级提示
          </span>
          <div className="mt-0.5 font-medium text-[var(--text-primary)]">{model.tierHint}</div>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            运行时命令广告
          </span>
          <div className="mt-0.5 font-medium text-[var(--text-primary)]">{advertisedLabel}</div>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            观察 / 控制门控
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <EntityStatusBadge kind="gate" gate={model.observeGate} compact />
            <EntityStatusBadge kind="gate" gate={model.controlGate} compact />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span
          data-testid="np09-boost-no-auto-upgrade"
          className="inline-flex items-center gap-1 text-[var(--text-muted)]"
        >
          <Lock size={11} aria-hidden="true" />
          <span>{model.autoUpgradeNotice}</span>
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="cursor-pointer rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
          >
            刷新能力探测
          </button>
        )}
      </div>

      <EvidenceDetails
        evidenceRefs={model.evidenceRefs}
        reasonCode={model.reasonCode}
        label={`Boost 能力证据 (${model.verifiedLevel !== null ? `L${model.verifiedLevel}` : '未做真机定级'})`}
      />
    </section>
  );
}
