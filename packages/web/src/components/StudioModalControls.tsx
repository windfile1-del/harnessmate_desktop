import { X } from 'lucide-react';

export function StudioHeader({
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

export function MetricMini({ label, value }: { label: string; value: string }) {
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

export function PillTab({
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
