export type SafeInlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'safe_doc_link'; readonly label: string; readonly href: string }
  | { readonly kind: 'blocked_link'; readonly label: string; readonly reason: string };

export type SafeMarkdownBlock =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4;
      readonly lineNumber: number;
      readonly tokens: readonly SafeInlineToken[];
    }
  | {
      readonly kind: 'list_item';
      readonly lineNumber: number;
      readonly tokens: readonly SafeInlineToken[];
    }
  | {
      readonly kind: 'code_block';
      readonly language: string;
      readonly startLine: number;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: 'paragraph';
      readonly lineNumber: number;
      readonly tokens: readonly SafeInlineToken[];
    }
  | {
      readonly kind: 'blank';
      readonly lineNumber: number;
    };

export interface SafeMarkdownParseResult {
  readonly blocks: readonly SafeMarkdownBlock[];
  readonly rawHtmlDetected: boolean;
  readonly blockedLinksCount: number;
  readonly blockedImagesCount: number;
}

export interface SafeDiffLine {
  readonly lineNo: number;
  readonly text: string;
  readonly kind: 'hunk' | 'add' | 'del' | 'meta' | 'context';
}

const ALLOWED_DOC_HOSTS = new Set(['antigravity.google', 'agentclientprotocol.com']);

const RAW_HTML_OR_XSS_PATTERN =
  /<\s*\/?\s*(?:script|iframe|object|embed|svg|img|style|link|meta|form|input|button)\b[^>]*>|on[a-z]{2,24}\s*=|(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/i;

export function isAllowlistedOfficialDocUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' && ALLOWED_DOC_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function tokenizeSafeInline(
  line: string,
  counters: { blockedLinks: number; blockedImages: number; htmlDetected: boolean },
): SafeInlineToken[] {
  if (RAW_HTML_OR_XSS_PATTERN.test(line)) {
    counters.htmlDetected = true;
  }

  const tokens: SafeInlineToken[] = [];
  // Matches markdown images ![alt](url), markdown links [label](url), inline code `x`, bold **x**
  const pattern = /(!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]*\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;

  for (const match of line.matchAll(pattern)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      tokens.push({ kind: 'text', text: line.slice(lastIndex, idx) });
    }
    const raw = match[0];

    if (raw.startsWith('![')) {
      const inner = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(raw);
      const alt = inner?.[1]?.trim() || '图片';
      counters.blockedImages += 1;
      tokens.push({
        kind: 'blocked_link',
        label: `[已拦截外部图片: ${alt}]`,
        reason: 'external_image_blocked',
      });
    } else if (raw.startsWith('[')) {
      const inner = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(raw);
      const label = inner?.[1] ?? raw;
      const href = inner?.[2]?.trim() ?? '';
      if (isAllowlistedOfficialDocUrl(href)) {
        tokens.push({ kind: 'safe_doc_link', label, href });
      } else {
        counters.blockedLinks += 1;
        tokens.push({
          kind: 'blocked_link',
          label: `[未审查链接已禁用: ${label}]`,
          reason: 'unreviewed_or_unsafe_link',
        });
      }
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ kind: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ kind: 'strong', text: raw.slice(2, -2) });
    } else {
      tokens.push({ kind: 'text', text: raw });
    }

    lastIndex = idx + raw.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ kind: 'text', text: line.slice(lastIndex) });
  }

  if (tokens.length === 0) {
    tokens.push({ kind: 'text', text: '' });
  }
  return tokens;
}

/**
 * Parses Markdown into a strictly safe, text-only React AST.
 * Never outputs raw HTML, never loads external images, and blocks unreviewed URLs.
 */
export function parseSafeMarkdown(content: string): SafeMarkdownParseResult {
  const rawLines = content.split(/\r?\n/);
  const blocks: SafeMarkdownBlock[] = [];
  const counters = {
    blockedLinks: 0,
    blockedImages: 0,
    htmlDetected: RAW_HTML_OR_XSS_PATTERN.test(content),
  };

  let inFence = false;
  let fenceLang = 'text';
  let fenceStartLine = 1;
  let fenceLines: string[] = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i] ?? '';
    const lineNumber = i + 1;

    if (line.trimStart().startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.trimStart().slice(3).trim() || 'text';
        fenceStartLine = lineNumber;
        fenceLines = [];
      } else {
        blocks.push({
          kind: 'code_block',
          language: fenceLang,
          startLine: fenceStartLine,
          lines: fenceLines,
        });
        inFence = false;
        fenceLines = [];
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (!line.trim()) {
      blocks.push({ kind: 'blank', lineNumber });
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1]!.length) as 1 | 2 | 3 | 4;
      blocks.push({
        kind: 'heading',
        level,
        lineNumber,
        tokens: tokenizeSafeInline(headingMatch[2]!, counters),
      });
      continue;
    }

    const listMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (listMatch) {
      blocks.push({
        kind: 'list_item',
        lineNumber,
        tokens: tokenizeSafeInline(listMatch[1]!, counters),
      });
      continue;
    }

    blocks.push({
      kind: 'paragraph',
      lineNumber,
      tokens: tokenizeSafeInline(line, counters),
    });
  }

  if (inFence) {
    blocks.push({
      kind: 'code_block',
      language: fenceLang,
      startLine: fenceStartLine,
      lines: fenceLines,
    });
  }

  return {
    blocks,
    rawHtmlDetected: counters.htmlDetected,
    blockedLinksCount: counters.blockedLinks,
    blockedImagesCount: counters.blockedImages,
  };
}

export function formatSafeUnifiedDiffLines(unifiedDiff: string): SafeDiffLine[] {
  return unifiedDiff.split(/\r?\n/).map((line, idx) => {
    const kind: SafeDiffLine['kind'] = line.startsWith('@@')
      ? 'hunk'
      : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git ')
        ? 'meta'
        : line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : 'context';
    return {
      lineNo: idx + 1,
      text: line,
      kind,
    };
  });
}
