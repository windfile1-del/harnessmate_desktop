export const requires = ['ui.filePreview.v1'];

export function renderFilePreview(file) {
  return {
    version: 1,
    format: 'text',
    content: file.content,
    ...(typeof file.line === 'number' && file.line > 0 ? { line: file.line } : {}),
  };
}

export function apply(ctx) {
  ctx.provide(
    'filePreview.v1',
    {
      getCapabilities() {
        return { viewerKind: 'text', extensions: ['*'], title: '文本文件预览' };
      },
      renderFilePreview,
    },
    { version: '1.0.0', metadata: { viewerKind: 'text', extensions: ['*'] } },
  );
}
