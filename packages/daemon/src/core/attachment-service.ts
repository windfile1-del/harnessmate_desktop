import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, UploadAttachmentRequest, WorkspaceFileEntry } from '@harnessmate/protocol';

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_PREVIEW_BYTES = 200 * 1024; // 200 KiB

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'release',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
]);

export interface ProjectInstructionInfo {
  name: string;
  relativePath: string;
  kind: 'rules' | 'skill';
  sizeBytes: number;
}

export class AttachmentService {
  constructor(private readonly attachmentsRoot: string) {
    fs.mkdirSync(this.attachmentsRoot, { recursive: true });
  }

  saveSessionAttachment(sessionId: string, req: UploadAttachmentRequest): Attachment {
    const safeSession = sanitizeSegment(sessionId);
    const sessionDir = path.join(this.attachmentsRoot, safeSession);
    fs.mkdirSync(sessionDir, { recursive: true });

    const id = `att_${crypto.randomBytes(5).toString('hex')}`;
    const safeName = sanitizeFilename(req.name);

    // Reference an existing workspace file directly without copying
    if (req.kind === 'file_ref' && req.sourcePath && !req.dataBase64) {
      const resolved = path.resolve(req.sourcePath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
      }
      const stat = fs.statSync(resolved);
      return {
        id,
        kind: 'file_ref',
        name: path.basename(resolved),
        path: resolved,
        mimeType: req.mimeType,
        sizeBytes: stat.size,
      };
    }

    if (!req.dataBase64) {
      throw new Error('Attachment requires dataBase64 or sourcePath');
    }

    const stripped = req.dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(stripped, 'base64');
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB limit`);
    }

    const storedName = `${id}-${safeName}`;
    const fullPath = path.join(sessionDir, storedName);
    fs.writeFileSync(fullPath, buffer);

    return {
      id,
      kind: req.kind,
      name: safeName,
      path: fullPath,
      mimeType: req.mimeType ?? inferMimeType(safeName),
      sizeBytes: buffer.byteLength,
      previewUrl: `/api/v1/attachments/${encodeURIComponent(safeSession)}/${encodeURIComponent(storedName)}`,
    };
  }

  resolveAttachmentFile(sessionId: string, storedName: string): string | null {
    const safeSession = sanitizeSegment(sessionId);
    const safeFile = path.basename(storedName);
    const full = path.resolve(this.attachmentsRoot, safeSession, safeFile);
    if (!full.startsWith(path.resolve(this.attachmentsRoot))) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
  }
}

export function searchWorkspaceFiles(
  cwd: string,
  query = '',
  limit = 120,
): WorkspaceFileEntry[] {
  if (!fs.existsSync(cwd)) return [];
  const root = path.resolve(cwd);
  const q = query.trim().toLowerCase();
  const out: WorkspaceFileEntry[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= limit * 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= limit * 3) return;
      if (ent.name.startsWith('.build-')) continue;
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), depth + 1);
      } else if (ent.isFile()) {
        const fullPath = path.join(dir, ent.name);
        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
        if (!q || relativePath.toLowerCase().includes(q)) {
          try {
            const stat = fs.statSync(fullPath);
            out.push({
              relativePath,
              fullPath,
              name: ent.name,
              sizeBytes: stat.size,
            });
          } catch {
            // skip
          }
        }
      }
    }
  };

  walk(root, 0);
  out.sort((a, b) => {
    if (q) {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
    }
    return a.relativePath.localeCompare(b.relativePath);
  });
  return out.slice(0, limit);
}

export function readWorkspaceFilePreview(
  cwd: string,
  relativePath: string,
): { relativePath: string; content: string; truncated: boolean; sizeBytes: number } {
  const root = path.resolve(cwd);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error('Path traversal rejected');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`File not found: ${relativePath}`);
  }
  const stat = fs.statSync(target);
  const truncated = stat.size > MAX_PREVIEW_BYTES;
  const fd = fs.openSync(target, 'r');
  try {
    const len = Math.min(stat.size, MAX_PREVIEW_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return {
      relativePath: path.relative(root, target).replace(/\\/g, '/'),
      content: buf.toString('utf8'),
      truncated,
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function discoverProjectRulesAndSkills(cwd: string): ProjectInstructionInfo[] {
  if (!fs.existsSync(cwd)) return [];
  const root = path.resolve(cwd);
  const found: ProjectInstructionInfo[] = [];

  const ruleFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'agent.md',
    '.cursorrules',
    '.github/copilot-instructions.md',
  ];

  for (const rel of ruleFiles) {
    const full = path.join(root, rel);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        found.push({
          name: path.basename(rel),
          relativePath: rel,
          kind: 'rules',
          sizeBytes: fs.statSync(full).size,
        });
      }
    } catch {
      // ignore
    }
  }

  const skillDirs = ['.claude/skills', '.gemini/skills', '.agents/skills', 'skills'];
  for (const relDir of skillDirs) {
    const fullDir = path.join(root, relDir);
    try {
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
      for (const ent of fs.readdirSync(fullDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillMd = path.join(fullDir, ent.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          found.push({
            name: ent.name,
            relativePath: `${relDir}/${ent.name}/SKILL.md`,
            kind: 'skill',
            sizeBytes: fs.statSync(skillMd).size,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return found;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_');
  return base.slice(0, 120) || 'file';
}

export function inferMimeType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    default:
      return 'application/octet-stream';
  }
}
