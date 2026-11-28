export interface FileLink {
  path: string;
  line?: number;
  column?: number;
}

export function parseFileLink(href: string): FileLink | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  let value = href.trim();
  if (!value) return null;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  if (value.startsWith('/api/')) return null;

  let fragmentLine: number | undefined;
  let fragmentColumn: number | undefined;
  const fragment = /#(?:L|line-?)?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(value);
  if (fragment) {
    value = value.slice(0, fragment.index);
    const l = Number(fragment[1]);
    const c = fragment[2] ? Number(fragment[2]) : undefined;
    if (Number.isSafeInteger(l) && l > 0) fragmentLine = l;
    if (c !== undefined && Number.isSafeInteger(c) && c > 0) fragmentColumn = c;
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }

  let suffixLine: number | undefined;
  let suffixColumn: number | undefined;
  const suffix = /:(\d+)(?::(\d+))?$/.exec(value);
  if (suffix) {
    value = value.slice(0, suffix.index);
    const l = Number(suffix[1]);
    const c = suffix[2] ? Number(suffix[2]) : undefined;
    if (Number.isSafeInteger(l) && l > 0) suffixLine = l;
    if (c !== undefined && Number.isSafeInteger(c) && c > 0) suffixColumn = c;
  }

  value = value.replace(/^\/(?=[a-z]:[\\/])/i, '').replaceAll('\\', '/');
  if (!value || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return null;

  const line = fragmentLine ?? suffixLine;
  const column = fragmentColumn ?? suffixColumn;
  return {
    path: value,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
