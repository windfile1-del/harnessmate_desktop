import fs from 'node:fs';
import path from 'node:path';
import { resolveManagedProfilePathSync } from './agy-profile-manager.js';

export const MAX_ARTIFACT_FILES = 64;
export const MAX_ARTIFACT_BYTES = 262_144;
export const ALLOWED_EXTS = new Set(['.md', '.markdown', '.diff', '.patch', '.txt', '.json']);

export interface AgyArtifactSummary {
  name: string;
  kind: 'markdown' | 'diff' | 'json' | 'text';
  sizeBytes: number;
  updatedAt: number;
}

export interface AgyArtifactContent extends AgyArtifactSummary {
  content: string;
  truncated: boolean;
}

export function isSafeArtifactSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment.startsWith('.')) return false;
  if (segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\') || segment.includes('..')) return false;
  if (segment.includes('\0') || segment.includes(':')) return false;
  // Reject ASCII control characters and trailing dots/spaces (Windows path normalization/ADS guard)
  if (/[\x00-\x1f\x7f]/.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  return true;
}

export function isAllowedArtifactExtension(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ALLOWED_EXTS.has(ext);
}

function classifyArtifactKind(fileName: string): AgyArtifactSummary['kind'] {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.diff' || ext === '.patch') return 'diff';
  if (ext === '.json') return 'json';
  return 'text';
}

/**
 * Strictly read-only enumeration of artifacts stored inside `<appDataPath>/brain/<nativeSessionId>/`.
 */
export function listAgySessionArtifacts(
  appDataPath: string,
  nativeSessionId: string,
): AgyArtifactSummary[] {
  const cleanSess = nativeSessionId.trim();
  if (!isSafeArtifactSegment(cleanSess)) return [];

  const brainDir = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess], 'directory');
  if (!brainDir) return [];

  const results: AgyArtifactSummary[] = [];
  for (const entry of fs.readdirSync(brainDir.path)) {
    if (results.length >= MAX_ARTIFACT_FILES) break;
    if (!isSafeArtifactSegment(entry)) continue;
    if (!isAllowedArtifactExtension(entry)) continue;

    const safeFile = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess, entry], 'file');
    if (!safeFile) continue;

    results.push({
      name: entry,
      kind: classifyArtifactKind(entry),
      sizeBytes: safeFile.info.size,
      updatedAt: safeFile.info.mtimeMs,
    });
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readAgySessionArtifact(
  appDataPath: string,
  nativeSessionId: string,
  fileName: string,
): AgyArtifactContent | null {
  const cleanSess = nativeSessionId.trim();
  const cleanFile = fileName.trim();
  if (!isSafeArtifactSegment(cleanSess) || !isSafeArtifactSegment(cleanFile)) return null;
  if (!isAllowedArtifactExtension(cleanFile)) return null;

  const safeFile = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess, cleanFile], 'file');
  if (!safeFile) return null;

  const bytes = Math.min(safeFile.info.size, MAX_ARTIFACT_BYTES);
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

    const buf = Buffer.alloc(bytes);
    const readBytes = fs.readSync(fd, buf, 0, bytes, 0);
    const slice = buf.subarray(0, readBytes);
    if (slice.includes(0)) {
      return null;
    }

    return {
      name: cleanFile,
      kind: classifyArtifactKind(cleanFile),
      sizeBytes: fdStat.size,
      updatedAt: fdStat.mtimeMs,
      content: slice.toString('utf8'),
      truncated: fdStat.size > MAX_ARTIFACT_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}
