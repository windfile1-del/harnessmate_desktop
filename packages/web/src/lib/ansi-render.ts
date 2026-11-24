export interface AnsiTextStyle {
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiTextStyle;
}

const ANSI_FG_COLORS: Record<number, string> = {
  30: '#4b5563',
  31: '#f87171',
  32: '#34d399',
  33: '#fbbf24',
  34: '#60a5fa',
  35: '#c084fc',
  36: '#22d3ee',
  37: '#e5e7eb',
  90: '#6b7280',
  91: '#fca5a5',
  92: '#6ee7b7',
  93: '#fde68a',
  94: '#93c5fd',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#f9fafb',
};

const ANSI_BG_COLORS: Record<number, string> = {
  40: 'rgba(17, 24, 39, 0.45)',
  41: 'rgba(239, 68, 68, 0.22)',
  42: 'rgba(16, 185, 129, 0.22)',
  43: 'rgba(245, 158, 11, 0.22)',
  44: 'rgba(59, 130, 246, 0.22)',
  45: 'rgba(168, 85, 247, 0.22)',
  46: 'rgba(6, 182, 212, 0.22)',
  47: 'rgba(229, 231, 235, 0.2)',
  100: 'rgba(75, 85, 99, 0.35)',
  101: 'rgba(248, 113, 113, 0.25)',
  102: 'rgba(52, 211, 153, 0.25)',
  103: 'rgba(251, 191, 36, 0.25)',
  104: 'rgba(96, 165, 250, 0.25)',
  105: 'rgba(192, 132, 252, 0.25)',
  106: 'rgba(34, 211, 238, 0.25)',
  107: 'rgba(249, 250, 251, 0.25)',
};

// eslint-disable-next-line no-control-regex
const OSC_OR_DCS_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\/g;
// eslint-disable-next-line no-control-regex
const NON_SGR_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-ln-zA-LN-Z~`^{}|\\]|\x9b[0-?]*[ -/]*[@-~]|\x1b[()][0-2AB]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const STRAY_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const SGR_OR_ANY_CSI_PATTERN = /\x1b\[([0-9;:]*)m/g;

function stripNonSgrSequences(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC_OR_DCS_PATTERN, '')
    .replace(NON_SGR_ESCAPE_PATTERN, '')
    .replace(STRAY_CONTROL_PATTERN, '');
}

export function stripAnsiClient(raw: string): string {
  return stripNonSgrSequences(raw).replace(SGR_OR_ANY_CSI_PATTERN, '');
}

function sameStyle(a: AnsiTextStyle, b: AnsiTextStyle): boolean {
  return (
    a.color === b.color &&
    a.bgColor === b.bgColor &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim)
  );
}

function applySgrParams(current: AnsiTextStyle, rawParams: string): AnsiTextStyle {
  if (!rawParams.trim()) return {};
  const codes = rawParams.split(';').map((part) => (part === '' ? 0 : Number.parseInt(part, 10)));
  let next: AnsiTextStyle = { ...current };

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === undefined || !Number.isFinite(code)) continue;
    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.bgColor;
    } else if (code in ANSI_FG_COLORS) {
      next.color = ANSI_FG_COLORS[code];
    } else if (code in ANSI_BG_COLORS) {
      next.bgColor = ANSI_BG_COLORS[code];
    } else if (code === 38 && codes[i + 1] === 2 && codes.length >= i + 5) {
      const r = Math.min(255, Math.max(0, codes[i + 2] ?? 0));
      const g = Math.min(255, Math.max(0, codes[i + 3] ?? 0));
      const b = Math.min(255, Math.max(0, codes[i + 4] ?? 0));
      next.color = `rgb(${r}, ${g}, ${b})`;
      i += 4;
    } else if (code === 48 && codes[i + 1] === 2 && codes.length >= i + 5) {
      const r = Math.min(255, Math.max(0, codes[i + 2] ?? 0));
      const g = Math.min(255, Math.max(0, codes[i + 3] ?? 0));
      const b = Math.min(255, Math.max(0, codes[i + 4] ?? 0));
      next.bgColor = `rgb(${r}, ${g}, ${b})`;
      i += 4;
    } else if (code === 38 && codes[i + 1] === 5 && codes.length >= i + 3) {
      i += 2;
    } else if (code === 48 && codes[i + 1] === 5 && codes.length >= i + 3) {
      i += 2;
    }
  }
  return next;
}

/**
 * Safely parses ANSI SGR color sequences into plain React text segments.
 * Never produces raw HTML and never relies on dangerouslySetInnerHTML.
 */
export function parseAnsiSegments(raw: string): AnsiSegment[] {
  const sanitized = stripNonSgrSequences(raw);
  const segments: AnsiSegment[] = [];
  let currentStyle: AnsiTextStyle = {};
  let cursor = 0;

  SGR_OR_ANY_CSI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = SGR_OR_ANY_CSI_PATTERN.exec(sanitized);
  while (match !== null) {
    if (match.index > cursor) {
      const text = sanitized.slice(cursor, match.index).replace(/\x1b/g, '');
      if (text) {
        const last = segments[segments.length - 1];
        if (last && sameStyle(last.style, currentStyle)) {
          last.text += text;
        } else {
          segments.push({ text, style: currentStyle });
        }
      }
    }
    currentStyle = applySgrParams(currentStyle, match[1] ?? '');
    cursor = match.index + match[0].length;
    match = SGR_OR_ANY_CSI_PATTERN.exec(sanitized);
  }

  if (cursor < sanitized.length) {
    const tail = sanitized.slice(cursor).replace(/\x1b/g, '');
    if (tail) {
      const last = segments[segments.length - 1];
      if (last && sameStyle(last.style, currentStyle)) {
        last.text += tail;
      } else {
        segments.push({ text: tail, style: currentStyle });
      }
    }
  }

  return segments;
}
