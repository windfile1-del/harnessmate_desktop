export interface FileLink {
  path: string;
  line?: number;
}

export function parseFileLink(href: string): FileLink | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  let value = href;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  if (value.startsWith('/api/')) return null;
  const fragment = /#(?:L|line-?)?(\d+)(?:-L?\d+)?$/i.exec(value);
  if (fragment) value = value.slice(0, fragment.index);
  try { value = decodeURIComponent(value); } catch { return null; }
  const suffix = /:(\d+)(?::\d+)?$/.exec(value);
  if (suffix) value = value.slice(0, suffix.index);
  value = value.replace(/^\/(?=[a-z]:[\\/])/i, '').replaceAll('\\', '/');
  if (!value || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return null;
  const line = Number(fragment?.[1] ?? suffix?.[1]);
  return { path: value, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) };
}
