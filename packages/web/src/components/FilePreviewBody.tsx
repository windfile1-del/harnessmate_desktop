import { Component, memo, useEffect, useRef, type ReactNode } from 'react';
import type { RenderedFilePreview } from '../api/client';
import type { FileLink } from '../lib/file-links';
import { MarkdownView } from './MarkdownView';

class PreviewBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function TextPreview({ content, line, truncated }: { content: string; line?: number; truncated: boolean }) {
  const lines = line ? content.split('\n') : [];
  const index = line ? line - 1 : -1;
  return (
    <pre className="m-0 p-3 font-mono-code text-[11px] leading-relaxed text-[var(--text-secondary)]">
      {index >= 0 && index < lines.length ? (
        <>
          {index > 0 ? `${lines.slice(0, index).join('\n')}\n` : ''}
          <mark data-file-preview-line={line} className="bg-[var(--accent-indigo-soft)] text-[var(--text-primary)]">
            {lines[index] || ' '}
          </mark>
          {index + 1 < lines.length ? `\n${lines.slice(index + 1).join('\n')}` : ''}
        </>
      ) : content}
      {truncated ? '\n\n... [文件过大已截断]' : ''}
    </pre>
  );
}

export const FilePreviewBody = memo(function FilePreviewBody({ content, line, truncated, preview, onOpenFile, onRenderError }: {
  content: string;
  line?: number;
  truncated: boolean;
  preview?: RenderedFilePreview;
  onOpenFile: (file: FileLink) => void;
  onRenderError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    const selected = element?.querySelector<HTMLElement>('[data-file-preview-line]');
    if (element) element.scrollTop = selected ? Math.max(0, selected.offsetTop - 45) : 0;
  }, [content, line, preview]);

  const fallback = <TextPreview content={content} line={line} truncated={truncated} />;
  return (
    <div ref={container} className="relative max-h-[260px] overflow-auto">
      {preview ? (
        <PreviewBoundary key={preview.pluginId} fallback={fallback} onError={onRenderError}>
          {preview.format === 'markdown' ? (
            <div className="p-3 [&_[data-file-preview-line]]:rounded-sm [&_[data-file-preview-line]]:bg-[var(--accent-indigo-soft)]">
              <MarkdownView content={preview.content} onOpenFile={onOpenFile} filePreview={{ line: preview.line }} />
              {truncated && <p className="mt-3 text-[11px] text-[var(--text-muted)]">文件过大，预览已截断</p>}
            </div>
          ) : <TextPreview content={preview.content} line={preview.line} truncated={truncated} />}
        </PreviewBoundary>
      ) : fallback}
    </div>
  );
});
