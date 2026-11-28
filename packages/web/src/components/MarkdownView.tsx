import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { Check, Copy } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../lib/clipboard';
import { parseFileLink, type FileLink } from '../lib/file-links';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('ps1', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

// Bounded LRU cache for highlighted code HTML so repeated/re-rendered blocks cost 0ms.
const HIGHLIGHT_CACHE_LIMIT = 512;
const highlightCache = new Map<string, string>();

function getCachedHighlight(key: string): string | undefined {
  const hit = highlightCache.get(key);
  if (hit !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, hit);
  }
  return hit;
}

function setCachedHighlight(key: string, html: string): void {
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  highlightCache.set(key, html);
}

// Time-sliced async highlight scheduler (<= 5ms budget per slice) so syntax highlighting never causes >50ms long tasks.
interface HighlightJob {
  key: string;
  lang: string;
  code: string;
  onDone: (html: string) => void;
  cancelled: boolean;
}

const highlightQueue: HighlightJob[] = [];
let highlightScheduled = false;

function runHighlightSlice(): void {
  highlightScheduled = false;
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  while (highlightQueue.length > 0) {
    const job = highlightQueue.shift()!;
    if (job.cancelled) continue;
    let html = getCachedHighlight(job.key);
    if (html === undefined) {
      try {
        if (job.lang && job.lang !== 'code' && hljs.getLanguage(job.lang)) {
          html = hljs.highlight(job.code, { language: job.lang, ignoreIllegals: true }).value;
        } else {
          html = '';
        }
      } catch {
        html = '';
      }
      if (html) setCachedHighlight(job.key, html);
    }
    if (!job.cancelled && html) {
      job.onDone(html);
    }
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    if (elapsed >= 5) break;
  }
  if (highlightQueue.length > 0) {
    scheduleHighlightFlush();
  }
}

function scheduleHighlightFlush(): void {
  if (highlightScheduled) return;
  highlightScheduled = true;
  if (typeof window !== 'undefined' && typeof (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback === 'function') {
    (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(runHighlightSlice, { timeout: 60 });
  } else {
    setTimeout(runHighlightSlice, 0);
  }
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

const CodeBlock = memo(function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const langMatch = /language-([\w-]+)/.exec(className ?? '');
  const lang = (langMatch?.[1] ?? 'code').toLowerCase();
  const rawText = useMemo(() => extractText(children).replace(/\n$/, ''), [children]);
  const cacheKey = `${lang}\0${rawText}`;
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(() => getCachedHighlight(cacheKey) ?? null);

  useEffect(() => {
    const cached = getCachedHighlight(cacheKey);
    if (cached !== undefined) {
      setHighlightedHtml(cached);
      return;
    }
    setHighlightedHtml(null);
    if (!lang || lang === 'code' || !rawText || rawText.length > 32_768 || !hljs.getLanguage(lang)) {
      return;
    }
    const job: HighlightJob = {
      key: cacheKey,
      lang,
      code: rawText,
      cancelled: false,
      onDone: (html) => setHighlightedHtml(html),
    };
    highlightQueue.push(job);
    scheduleHighlightFlush();
    return () => {
      job.cancelled = true;
    };
  }, [cacheKey, lang, rawText]);

  const handleCopy = () => {
    void copyText(rawText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className="my-3 overflow-hidden rounded-xl"
      style={{
        border: '1px solid var(--border-hairline)',
        backgroundColor: 'var(--code-bg)',
      }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-1.5 text-[11px]"
        style={{
          borderBottom: '1px solid var(--border-hairline)',
          color: 'var(--text-muted)',
        }}
      >
        <span className="font-mono-code uppercase tracking-wider">{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: copied ? 'var(--accent-emerald)' : 'var(--text-secondary)' }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="!m-0 !border-0 !bg-transparent !p-3.5 font-mono-code text-[12.6px] leading-relaxed overflow-x-auto">
        {highlightedHtml ? (
          <code
            className={`${className ?? ''} hljs`}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <code className={className}>{children}</code>
        )}
      </pre>
    </div>
  );
});

type MarkdownElement = {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
};

const REMARK_PLUGINS = [remarkGfm];

/**
 * Splits large markdown documents into independent top-level chunks (respecting fenced code blocks)
 * so streaming/long messages can memoize completed chunks without re-parsing the whole document.
 */
function splitMarkdownChunks(content: string): string[] {
  if (content.length < 4096) return [content];
  const lines = content.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let charCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (!inFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
    } else if (inFence && trimmed.startsWith(fenceMarker)) {
      inFence = false;
      fenceMarker = '';
    }
    buf.push(line);
    charCount += line.length + 1;
    if (!inFence && line === '' && charCount >= 2048) {
      chunks.push(buf.join('\n'));
      buf = [];
      charCount = 0;
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n'));
  return chunks.length > 0 ? chunks : [content];
}

const MarkdownChunk = memo(function MarkdownChunk({
  chunk,
  components,
  onOpenFile,
  rehypePlugins,
}: {
  chunk: string;
  components: Components;
  onOpenFile?: (file: FileLink) => void;
  rehypePlugins: Array<() => (tree: { children: MarkdownElement[] }) => void>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      urlTransform={(url, key) =>
        key === 'href' && onOpenFile && parseFileLink(url) ? url : defaultUrlTransform(url)
      }
      components={components}
    >
      {chunk}
    </ReactMarkdown>
  );
});

export const MarkdownView = memo(function MarkdownView({
  content,
  onOpenFile,
  filePreview,
}: {
  content: string;
  onOpenFile?: (file: FileLink) => void;
  filePreview?: { line?: number };
}) {
  const isFilePreview = Boolean(filePreview);
  const sourceLine = filePreview?.line;
  const rehypePlugins = useMemo(() => {
    if (!sourceLine) return [];
    return [
      () => (tree: { children: MarkdownElement[] }) => {
        const block = tree.children.find(
          (node) =>
            node.type === 'element' &&
            node.position &&
            node.position.start.line <= sourceLine &&
            node.position.end.line >= sourceLine,
        );
        if (block?.properties) block.properties.dataFilePreviewLine = String(sourceLine);
      },
    ];
  }, [sourceLine]);

  const components = useMemo<Components>(
    () => ({
      a({ href, children, title }) {
        if (isFilePreview && !href) return <>{children}</>;
        const file = onOpenFile && href ? parseFileLink(href) : null;
        if (file) {
          return (
            <button
              type="button"
              className="cursor-pointer break-all text-[var(--accent-indigo)] underline"
              title={title ?? file.path}
              onClick={() => onOpenFile?.(file)}
            >
              {children}
            </button>
          );
        }
        return (
          <a
            href={href}
            title={title}
            target={href?.startsWith('#') ? undefined : '_blank'}
            rel="noreferrer"
            onClick={(event) => {
              if (href && /^https?:\/\//i.test(href) && window.harnessMateBridge) {
                event.preventDefault();
                void window.harnessMateBridge.openExternal(href);
              }
            }}
          >
            {children}
          </a>
        );
      },
      ...(isFilePreview && {
        img: ({ alt }: { alt?: string }) => (alt ? <span>{alt}</span> : null),
      }),
      pre({ children, node }) {
        const line = node?.properties.dataFilePreviewLine;
        if (line) return <div data-file-preview-line={line}>{children}</div>;
        return <>{children}</>;
      },
      code({ className, children, ...rest }) {
        const isBlock = Boolean(className) || String(children).includes('\n');
        if (!isBlock) {
          return (
            <code className="font-mono-code" {...rest}>
              {children}
            </code>
          );
        }
        return <CodeBlock className={className}>{children}</CodeBlock>;
      },
    }),
    [onOpenFile, isFilePreview],
  );

  const chunks = useMemo(
    () => (sourceLine ? [content] : splitMarkdownChunks(content)),
    [content, sourceLine],
  );

  return (
    <div className="hm-prose">
      {chunks.map((chunk, idx) => (
        <MarkdownChunk
          key={idx}
          chunk={chunk}
          components={components}
          onOpenFile={onOpenFile}
          rehypePlugins={rehypePlugins}
        />
      ))}
    </div>
  );
});
