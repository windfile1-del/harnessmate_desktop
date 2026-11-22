import type { HarnessKind } from '@harnessmate/protocol';
import { HARNESS_META } from '../lib/harness-meta';

export function StarLoomCrest({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sl-ring" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent-indigo)" />
          <stop offset="100%" stopColor="var(--accent-star)" />
        </linearGradient>
      </defs>
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="9"
        fill="var(--bg-elevated)"
        stroke="var(--border-strong)"
        strokeWidth="1"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="10"
        ry="4.8"
        transform="rotate(-32 16 16)"
        stroke="url(#sl-ring)"
        strokeWidth="1.25"
        strokeOpacity="0.85"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="10"
        ry="4.8"
        transform="rotate(32 16 16)"
        stroke="var(--accent-indigo)"
        strokeWidth="1.15"
        strokeOpacity="0.45"
      />
      <path
        d="M16 9.5L17.4 14.6L22.5 16L17.4 17.4L16 22.5L14.6 17.4L9.5 16L14.6 14.6L16 9.5Z"
        fill="var(--accent-star)"
      />
    </svg>
  );
}

export function HarnessBadge({
  kind,
  label,
  compact = false,
}: {
  kind: HarnessKind;
  label?: string;
  compact?: boolean;
}) {
  const meta = HARNESS_META[kind] ?? HARNESS_META.acp;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium tracking-tight ${
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-[11.5px]'
      }`}
      style={{
        backgroundColor: meta.softBg,
        color: meta.accentColor,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.accentColor }}
      />
      {label ?? meta.shortLabel}
    </span>
  );
}
