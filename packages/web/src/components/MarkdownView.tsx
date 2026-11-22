import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const langMatch = /language-([\w-]+)/.exec(className ?? '');
  const lang = langMatch?.[1] ?? 'code';
  const rawText = extractText(children).replace(/\n$/, '');

  const handleCopy = () => {
    void navigator.clipboard.writeText(rawText);
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

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="hm-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children }) {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
