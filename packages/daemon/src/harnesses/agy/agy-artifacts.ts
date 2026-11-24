import fs from 'node:fs';
import path from 'node:path';
import { resolveManagedProfilePathSync } from './agy-profile-manager.js';

const MAX_ARTIFACT_FILES = 64;
const MAX_ARTIFACT_BYTES = 262_144;
const ALLOWED_EXTS = new Set(['.md', '.markdown', '.diff', '.patch', '.txt', '.json']);

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
  if (!cleanSess) return [];

  const brainDir = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess], 'directory');
  if (!brainDir) return [];

  const results: AgyArtifactSummary[] = [];
  for (const entry of fs.readdirSync(brainDir.path)) {
    if (results.length >= MAX_ARTIFACT_FILES) break;
    if (entry.startsWith('.')) continue;
    const ext = path.extname(entry).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) continue;

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
  if (!cleanSess || !cleanFile || cleanFile.startsWith('.')) return null;

  const safeFile = resolveManagedProfilePathSync(appDataPath, ['brain', cleanSess, cleanFile], 'file');
  if (!safeFile) return null;

  const bytes = Math.min(safeFile.info.size, MAX_ARTIFACT_BYTES);
  const fd = fs.openSync(safeFile.path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const readBytes = fs.readSync(fd, buf, 0, bytes, 0);
    return {
      name: cleanFile,
      kind: classifyArtifactKind(cleanFile),
      sizeBytes: safeFile.info.size,
      updatedAt: safeFile.info.mtimeMs,
      content: buf.subarray(0, readBytes).toString('utf8'),
      truncated: safeFile.info.size > MAX_ARTIFACT_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}
