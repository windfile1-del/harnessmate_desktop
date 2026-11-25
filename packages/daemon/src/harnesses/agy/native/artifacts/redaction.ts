import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAllowedArtifactExtension,
  isSafeArtifactSegment,
  MAX_ARTIFACT_BYTES,
} from '../../agy-artifacts.js';
import { resolveManagedProfilePathSync } from '../../agy-profile-manager.js';

export interface ContentRedactionResult {
  readonly content: string;
  readonly secretsRedactedCount: number;
  readonly hostPathsRedactedCount: number;
  readonly htmlStrippedOrEscaped: boolean;
  readonly unsafeLinksBlockedCount: number;
  readonly redactionNotes: readonly string[];
}

export interface ManagedTextArtifactReadResult {
  readonly name: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export type AllowlistedMediaMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'video/webm'
  | 'video/mp4';

export interface ManagedMediaReferenceInspectResult {
  readonly name: string;
  readonly mimeType: AllowlistedMediaMimeType;
  readonly sizeBytes: number;
  readonly updatedAt: number;
  readonly magicVerified: boolean;
  readonly sha256Prefix: string;
}

const WINDOWS_PATH_RE = /\b[a-zA-Z]:[\\/](?:[^\s"'`<>|*?]+)?/g;
const UNC_OR_DEVICE_PATH_RE = /\\\\(?:\?\\|\.\\|[a-zA-Z0-9._-]+\\)[^\s"'`<>|*?]+/g;
const FILE_URI_RE = /\bfile:\/\/\/?[^\s"'`<>)]+/gi;
const POSIX_USER_PATH_RE = /(?:^|[\s"'`(])(\/(?:Users|home|var\/folders|tmp)\/[^\s"'`<>)]+)/g;

const OAUTH_QUERY_SECRET_RE =
  /([?&](?:code|access_token|refresh_token|id_token|client_secret|token|state)=)([^&\s"'`<>]+)/gi;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const GOOGLE_KEY_OR_TOKEN_RE = /\b(?:AIza[0-9A-Za-z_-]{16,}|ya29\.[0-9A-Za-z_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g;
const AUTH_HEADER_RE = /\b((?:Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*)([^\r\n]+)/gi;
const PEM_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const RAW_HTML_OR_XSS_RE =
  /<\s*\/?\s*(?:script|iframe|object|embed|svg|img|style|link|meta|form|input|button)\b[^>]*>|on[a-z]{2,24}\s*=|(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/gi;
const EXTERNAL_MARKDOWN_LINK_RE = /(!?\[[^\]]*\]\()((?:https?|file|javascript|vbscript|data):[^)\s]+)(\))/gi;

const SAFE_DOC_HOSTS = new Set(['antigravity.google', 'agentclientprotocol.com']);

const ALLOWED_MEDIA_EXT_TO_MIME: Readonly<Record<string, AllowlistedMediaMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function isAllowlistedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && SAFE_DOC_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function containsRawHostPath(text: string): boolean {
  if (!text) return false;
  WINDOWS_PATH_RE.lastIndex = 0;
  UNC_OR_DEVICE_PATH_RE.lastIndex = 0;
  FILE_URI_RE.lastIndex = 0;
  POSIX_USER_PATH_RE.lastIndex = 0;
  return (
    WINDOWS_PATH_RE.test(text) ||
    UNC_OR_DEVICE_PATH_RE.test(text) ||
    FILE_URI_RE.test(text) ||
    POSIX_USER_PATH_RE.test(text)
  );
}

export function redactHostPaths(text: string): { readonly text: string; readonly count: number } {
  if (!text) return { text, count: 0 };
  let count = 0;
  let next = text.replace(FILE_URI_RE, () => {
    count += 1;
    return '[redacted-file-uri]';
  });
  next = next.replace(UNC_OR_DEVICE_PATH_RE, () => {
    count += 1;
    return '[redacted-unc-path]';
  });
  next = next.replace(WINDOWS_PATH_RE, () => {
    count += 1;
    return '[redacted-host-path]';
  });
  next = next.replace(POSIX_USER_PATH_RE, (full, captured: string) => {
    count += 1;
    return full.replace(captured, '[redacted-host-path]');
  });
  return { text: next, count };
}

/**
 * Redacts credentials, host filesystem paths, and marks HTML/XSS or unreviewed links
 * so artifact content can be rendered strictly as safe plain text / safe AST Markdown.
 */
export function redactSensitiveContent(text: string): ContentRedactionResult {
  let next = text;
  let secretsRedactedCount = 0;
  let unsafeLinksBlockedCount = 0;
  const notes = new Set<string>();

  next = next.replace(PEM_KEY_BLOCK_RE, () => {
    secretsRedactedCount += 1;
    notes.add('private_key_redacted');
    return '[redacted-private-key]';
  });

  next = next.replace(AUTH_HEADER_RE, (_m, prefix: string) => {
    secretsRedactedCount += 1;
    notes.add('auth_header_redacted');
    return `${prefix}[redacted-secret]`;
  });

  next = next.replace(BEARER_RE, (_m, prefix: string) => {
    secretsRedactedCount += 1;
    notes.add('bearer_token_redacted');
    return `${prefix}[redacted-token]`;
  });

  next = next.replace(OAUTH_QUERY_SECRET_RE, (_m, prefix: string) => {
    secretsRedactedCount += 1;
    notes.add('oauth_param_redacted');
    return `${prefix}[redacted]`;
  });

  next = next.replace(GOOGLE_KEY_OR_TOKEN_RE, () => {
    secretsRedactedCount += 1;
    notes.add('api_token_redacted');
    return '[redacted-token]';
  });

  const pathResult = redactHostPaths(next);
  next = pathResult.text;
  if (pathResult.count > 0) {
    notes.add('host_paths_redacted');
  }

  RAW_HTML_OR_XSS_RE.lastIndex = 0;
  const htmlStrippedOrEscaped = RAW_HTML_OR_XSS_RE.test(next);
  if (htmlStrippedOrEscaped) {
    notes.add('raw_html_neutralized_as_text');
  }

  next = next.replace(EXTERNAL_MARKDOWN_LINK_RE, (full, prefix: string, url: string, suffix: string) => {
    const isImage = prefix.startsWith('!');
    if (!isImage && isAllowlistedExternalUrl(url)) {
      return full;
    }
    unsafeLinksBlockedCount += 1;
    notes.add(isImage ? 'external_image_blocked' : 'unreviewed_link_blocked');
    return `${prefix}blocked://unreviewed-link${suffix}`;
  });

  return {
    content: next,
    secretsRedactedCount,
    hostPathsRedactedCount: pathResult.count,
    htmlStrippedOrEscaped,
    unsafeLinksBlockedCount,
    redactionNotes: [...notes],
  };
}

/**
 * Converts a candidate file path into a safe relative display label without host prefixes.
 */
export function sanitizeRelativeDisplayPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return 'unknown-file';

  const strippedUri = trimmed.replace(/^file:\/\/\/?/i, '');
  const normalized = strippedUri.replace(/\\/g, '/');
  const withoutDriveOrUnc = normalized
    .replace(/^\/\/[?./]?\/?/, '')
    .replace(/^[a-zA-Z]:\/+/, '')
    .replace(/^\/+/, '');

  const segments = withoutDriveOrUnc
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

  if (segments.length === 0) return 'redacted-path';
  const tail = segments.slice(-3).join('/');
  return tail.slice(0, 180);
}

/**
 * Safe bounded reader for text artifacts inside `<appDataPath>/brain/<nativeSessionId>/`.
 * Enforces segment allowlist, extension allowlist, non-reparse resolution, fd identity match,
 * and NUL-byte rejection.
 */
export function verifyManagedTextArtifactSync(
  appDataPath: string,
  nativeSessionId: string,
  fileName: string,
  maxBytes = MAX_ARTIFACT_BYTES,
): ManagedTextArtifactReadResult | null {
  const cleanSess = nativeSessionId.trim();
  const cleanFile = fileName.trim();
  if (!isSafeArtifactSegment(cleanSess) || !isSafeArtifactSegment(cleanFile)) return null;
  if (!isAllowedArtifactExtension(cleanFile)) return null;

  const safeFile = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess, cleanFile], 'file');
  if (!safeFile) return null;

  const boundedLimit = Math.max(1, Math.min(maxBytes, MAX_ARTIFACT_BYTES));
  const bytesToRead = Math.min(safeFile.info.size, boundedLimit);
  const fd = fs.openSync(safeFile.path, 'r');
  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (
      safeFile.info.ino !== 0 &&
      (fdStat.dev !== safeFile.info.dev || fdStat.ino !== safeFile.info.ino)
    ) {
      return null;
    }

    const buf = Buffer.alloc(bytesToRead);
    const readBytes = fs.readSync(fd, buf, 0, bytesToRead, 0);
    const slice = buf.subarray(0, readBytes);
    if (slice.includes(0)) return null;

    const sha256 = crypto.createHash('sha256').update(slice).digest('hex');
    return {
      name: cleanFile,
      content: slice.toString('utf8'),
      sizeBytes: fdStat.size,
      updatedAt: Math.floor(fdStat.mtimeMs),
      truncated: fdStat.size > boundedLimit,
      sha256,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function matchesMediaMagicHeader(buf: Buffer, mimeType: AllowlistedMediaMimeType): boolean {
  if (mimeType === 'image/png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (mimeType === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === 'image/webp') {
    return (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  if (mimeType === 'video/webm') {
    return (
      buf.length >= 4 &&
      buf[0] === 0x1a &&
      buf[1] === 0x45 &&
      buf[2] === 0xdf &&
      buf[3] === 0xa3
    );
  }
  if (mimeType === 'video/mp4') {
    return buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

/**
 * Inspects an allowlisted screenshot/recording inside `<appDataPath>/brain/<nativeSessionId>/`
 * without exposing OS paths, SVG/HTML files, or unverified binary bodies.
 */
export function inspectManagedMediaReferenceSync(
  appDataPath: string,
  nativeSessionId: string,
  fileName: string,
): ManagedMediaReferenceInspectResult | null {
  const cleanSess = nativeSessionId.trim();
  const cleanFile = fileName.trim();
  if (!isSafeArtifactSegment(cleanSess) || !isSafeArtifactSegment(cleanFile)) return null;

  const ext = path.extname(cleanFile).toLowerCase();
  const mimeType = ALLOWED_MEDIA_EXT_TO_MIME[ext];
  if (!mimeType) return null;

  const safeFile = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess, cleanFile], 'file');
  if (!safeFile) return null;

  const fd = fs.openSync(safeFile.path, 'r');
  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (
      safeFile.info.ino !== 0 &&
      (fdStat.dev !== safeFile.info.dev || fdStat.ino !== safeFile.info.ino)
    ) {
      return null;
    }

    const headerLen = Math.min(fdStat.size, 32);
    const headerBuf = Buffer.alloc(headerLen);
    const readBytes = fs.readSync(fd, headerBuf, 0, headerLen, 0);
    const slice = headerBuf.subarray(0, readBytes);
    const magicVerified = matchesMediaMagicHeader(slice, mimeType);
    const sha256Prefix = crypto
      .createHash('sha256')
      .update(`${cleanFile}:${fdStat.size}:${fdStat.mtimeMs}`)
      .digest('hex')
      .slice(0, 16);

    return {
      name: cleanFile,
      mimeType,
      sizeBytes: fdStat.size,
      updatedAt: Math.floor(fdStat.mtimeMs),
      magicVerified,
      sha256Prefix,
    };
  } finally {
    fs.closeSync(fd);
  }
}
