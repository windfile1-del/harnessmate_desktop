import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ValidatedProjectRoot } from './types.js';

const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /^antigravity-oauth-token$/i,
  /^\.env(\..+)?$/i,
  /credentials/i,
  /(^|[._-])(token|secret|apikey|api_key|oauth)([._-]|$)/i,
  /\.(pem|key|p12|pfx)$/i,
];

export function isSensitiveFileName(fileName: string): boolean {
  const base = path.basename(fileName);
  return SENSITIVE_NAME_PATTERNS.some((re) => re.test(base));
}

export function normalizePathForCompare(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(absPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function hashNormalizedPath(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const norm = normalizePathForCompare(absPath, platform);
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

export function isPathWithinRoot(
  candidateCanonical: string,
  rootCanonical: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const cand = normalizePathForCompare(candidateCanonical, platform);
  const root = normalizePathForCompare(rootCanonical, platform);
  if (cand === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return cand.startsWith(prefix);
}

function hasDotDotTraversal(rawPath: string): boolean {
  const segments = rawPath.split(/[\\/]+/);
  return segments.some((seg) => seg === '..');
}

export function validateAuthorizedDirectory(
  rawPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    allowSymlinkWithinRoots?: readonly string[];
  },
): {
  readonly allowed: boolean;
  readonly canonicalPath?: string;
  readonly reasonCode: ValidatedProjectRoot['reasonCode'];
} {
  const platform = opts?.platform ?? process.platform;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0') || hasDotDotTraversal(trimmed)) {
    return { allowed: false, reasonCode: 'traversal_rejected' };
  }

  const resolvedInput = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedInput);
  } catch {
    return { allowed: false, reasonCode: 'missing' };
  }

  const isSymlink = stat.isSymbolicLink();
  if (!isSymlink && !stat.isDirectory()) {
    return { allowed: false, reasonCode: 'not_directory' };
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(resolvedInput);
    const targetStat = fs.statSync(canonical);
    if (!targetStat.isDirectory()) {
      return { allowed: false, reasonCode: 'not_directory' };
    }
  } catch {
    return { allowed: false, reasonCode: 'missing' };
  }

  if (isSymlink) {
    const allowedRoots = opts?.allowSymlinkWithinRoots ?? [];
    const insideAllowed = allowedRoots.some((root) => {
      try {
        const rootCanonical = fs.realpathSync(root);
        return isPathWithinRoot(canonical, rootCanonical, platform);
      } catch {
        return false;
      }
    });
    if (!insideAllowed) {
      return { allowed: false, reasonCode: 'symlink_escape_rejected' };
    }
  }

  return {
    allowed: true,
    canonicalPath: canonical,
    reasonCode: 'ok',
  };
}

export function resolveSafeChildPath(
  rootDir: string,
  relativeSegments: readonly string[],
  kind: 'file' | 'directory',
  opts?: {
    allowSymlinkWithinRoots?: readonly string[];
    platform?: NodeJS.Platform;
  },
): { readonly ok: true; readonly canonicalPath: string; readonly isSymlink: boolean } | { readonly ok: false; readonly reasonCode: string } {
  const platform = opts?.platform ?? process.platform;
  let rootCanonical: string;
  try {
    rootCanonical = fs.realpathSync(rootDir);
  } catch {
    return { ok: false, reasonCode: 'root_missing' };
  }

  const allowedRoots = [rootCanonical];
  for (const extraRoot of opts?.allowSymlinkWithinRoots ?? []) {
    try {
      allowedRoots.push(fs.realpathSync(extraRoot));
    } catch {
      // ignore unavailable extra root
    }
  }

  let current = rootCanonical;
  let sawSymlink = false;
  for (let i = 0; i < relativeSegments.length; i++) {
    const seg = relativeSegments[i]!;
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      return { ok: false, reasonCode: 'invalid_segment' };
    }
    if (isSensitiveFileName(seg)) {
      return { ok: false, reasonCode: 'sensitive_file_denied' };
    }
    current = path.join(current, seg);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { ok: false, reasonCode: 'not_found' };
    }

    const isLast = i === relativeSegments.length - 1;
    const expectFile = kind === 'file' && isLast;
    if (stat.isSymbolicLink()) {
      sawSymlink = true;
      let resolved: string;
      try {
        resolved = fs.realpathSync(current);
      } catch {
        return { ok: false, reasonCode: 'broken_symlink' };
      }
      const withinAllowed = allowedRoots.some((r) => isPathWithinRoot(resolved, r, platform));
      if (!withinAllowed) {
        return { ok: false, reasonCode: 'symlink_escape_rejected' };
      }
      let resolvedStat: fs.Stats;
      try {
        resolvedStat = fs.statSync(resolved);
      } catch {
        return { ok: false, reasonCode: 'broken_symlink' };
      }
      if (expectFile ? !resolvedStat.isFile() : !resolvedStat.isDirectory()) {
        return { ok: false, reasonCode: 'unexpected_entry_type' };
      }
      current = resolved;
    } else if (expectFile ? !stat.isFile() : !stat.isDirectory()) {
      return { ok: false, reasonCode: 'unexpected_entry_type' };
    }
  }

  try {
    const finalCanonical = fs.realpathSync(current);
    const withinAllowed = allowedRoots.some((r) => isPathWithinRoot(finalCanonical, r, platform));
    if (!withinAllowed) {
      return { ok: false, reasonCode: 'symlink_escape_rejected' };
    }
    return { ok: true, canonicalPath: finalCanonical, isSymlink: sawSymlink };
  } catch {
    return { ok: false, reasonCode: 'unresolvable_path' };
  }
}

export function readSafeBoundedFile(
  rootDir: string,
  relativeSegments: readonly string[],
  opts?: {
    maxBytes?: number;
    allowSymlinkWithinRoots?: readonly string[];
    platform?: NodeJS.Platform;
  },
):
  | { readonly ok: true; readonly content: string; readonly canonicalPath: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reasonCode: string } {
  const maxBytes = opts?.maxBytes ?? 65_536;
  const resolved = resolveSafeChildPath(rootDir, relativeSegments, 'file', opts);
  if (!resolved.ok) return resolved;

  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved.canonicalPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, reasonCode: 'unexpected_entry_type' };
    }
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(bytesToRead);
    const readBytes = bytesToRead > 0 ? fs.readSync(fd, buf, 0, bytesToRead, 0) : 0;
    return {
      ok: true,
      content: buf.subarray(0, readBytes).toString('utf8'),
      canonicalPath: resolved.canonicalPath,
      truncated: stat.size > maxBytes,
    };
  } catch {
    return { ok: false, reasonCode: 'read_failed' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

export function redactPathForDto(
  absPath: string,
  roots: {
    readonly workspaceRoot?: string;
    readonly geminiDir?: string;
    readonly userHome?: string;
    readonly platform?: NodeJS.Platform;
  },
): string {
  const platform = roots.platform ?? process.platform;
  const resolved = path.resolve(absPath);

  const tryRelative = (base: string | undefined, tag: string): string | null => {
    if (!base) return null;
    const baseResolved = path.resolve(base);
    if (!isPathWithinRoot(resolved, baseResolved, platform)) return null;
    const rel = path.relative(baseResolved, resolved).split(path.sep).filter(Boolean).join('/');
    return rel ? `${tag}/${rel}` : tag;
  };

  const candidates: Array<[string | undefined, string]> = [
    [roots.workspaceRoot, '<workspace>'],
    [roots.geminiDir, '<profile-gemini>'],
    [roots.userHome ? path.join(roots.userHome, '.gemini') : undefined, '<global-gemini>'],
    [roots.userHome ? path.join(roots.userHome, '.agents') : undefined, '<global-agents>'],
    [roots.userHome, '<home>'],
  ];

  for (const [base, tag] of candidates) {
    const hit = tryRelative(base, tag);
    if (hit !== null) return hit;
  }

  return `<external-root:${hashNormalizedPath(resolved, platform).slice(0, 8)}>`;
}
