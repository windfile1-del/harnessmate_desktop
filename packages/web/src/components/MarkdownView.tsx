import { Check, Copy } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { parseFileLink, type FileLink } from '../lib/file-links';
import { copyText } from '../lib/clipboard';

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const langMatch = /language-([\w-]+)/.exec(className ?? '');
  const lang = langMatch?.[1] ?? 'code';
  const rawText = extractText(children).replace(/\n$/, '');

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
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

type MarkdownElement = {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
};

export const MarkdownView = memo(function MarkdownView({ content, onOpenFile, filePreview }: {
  content: string;
  onOpenFile?: (file: FileLink) => void;
  filePreview?: { line?: number };
}) {
  const isFilePreview = Boolean(filePreview);
  const sourceLine = filePreview?.line;
  const rehypePlugins = useMemo(() => {
    if (!sourceLine) return [rehypeHighlight];
    return [rehypeHighlight, () => (tree: { children: MarkdownElement[] }) => {
      const block = tree.children.find((node) => node.type === 'element' && node.position
        && node.position.start.line <= sourceLine && node.position.end.line >= sourceLine);
      if (block?.properties) block.properties.dataFilePreviewLine = String(sourceLine);
    }];
  }, [sourceLine]);
  const components = useMemo<Components>(() => ({
          a({ href, children, title }) {
            if (isFilePreview && !href) return <>{children}</>;
            const file = onOpenFile && href ? parseFileLink(href) : null;
            if (file) return <button type="button" className="cursor-pointer break-all text-[var(--accent-indigo)] underline"
              title={title ?? file.path} onClick={() => onOpenFile?.(file)}>{children}</button>;
            return <a href={href} title={title} target={href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer"
              onClick={(event) => {
                if (href && /^https?:\/\//i.test(href) && window.harnessMateBridge) {
                  event.preventDefault();
                  void window.harnessMateBridge.openExternal(href);
                }
              }}>{children}</a>;
          },
          ...(isFilePreview && {
            img: ({ alt }: { alt?: string }) => alt ? <span>{alt}</span> : null,
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
  }), [onOpenFile, isFilePreview]);
  return (
    <div className="hm-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        urlTransform={(url, key) => key === 'href' && onOpenFile && parseFileLink(url) ? url : defaultUrlTransform(url)}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
