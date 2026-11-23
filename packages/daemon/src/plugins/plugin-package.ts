import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafePluginUiPath } from '@harnessmate/plugin-api';
import { PluginManifestSchema, type PluginManifest } from '@harnessmate/protocol';

export const MANIFEST_FILE = 'harnessmate-plugin.json';
const POINTER_FILE = '.harnessmate-active.json';
const REVISIONS_DIR = '.revisions';
const revisionPattern = /^[a-f0-9-]{36}$/;

export interface PluginPackage {
  manifest: PluginManifest;
  files: Map<string, Buffer>;
  digest: string;
}

export interface RevisionPointer {
  current: string;
  previous?: string;
  currentDigest?: string;
  previousDigest?: string;
  currentTrusted?: boolean;
  previousTrusted?: boolean;
}

export function manifestPluginPackage(manifest: PluginManifest): PluginPackage {
  const files = new Map([[MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))]]);
  return { manifest, files, digest: hashFiles(files) };
}

export function packageFromFilesRecord(record: Record<string, string | Buffer>): PluginPackage {
  const files = new Map<string, Buffer>();
  let totalSize = 0;
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 4096) throw new Error('插件文件数量超过限制');
  for (const [rawPath, rawContent] of entries) {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some((s) => !s || s === '.' || s === '..')) {
      throw new Error(`插件包包含非法文件路径: ${rawPath}`);
    }
    const buf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, 'utf8');
    totalSize += buf.length;
    if (totalSize > 24 * 1024 * 1024) throw new Error('插件包超过 24 MiB');
    files.set(normalized, buf);
  }
  const manifestFile = files.get(MANIFEST_FILE);
  if (!manifestFile) throw new Error(`插件包缺少 ${MANIFEST_FILE}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(manifestFile.toString('utf8').replace(/^\uFEFF/, '')));
  validatePackageReferencedFiles(manifest, files);
  return { manifest, files, digest: hashFiles(files) };
}

function validatePackageReferencedFiles(manifest: PluginManifest, files: Map<string, Buffer>): void {
  const entryFile = manifest.main ?? manifest.entry;
  if (entryFile) {
    const entry = entryFile.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!files.has(entry) || !/\.(?:cjs|mjs|js)$/i.test(entry)) {
      throw new Error('插件入口必须指向包内的 .js、.mjs 或 .cjs 文件');
    }
  }
  for (const slot of manifest.contributes.slots ?? []) {
    const uiPath = slot.ui.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!isSafePluginUiPath(uiPath) || !files.has(uiPath)) {
      throw new Error(`插件 UI 插槽 ${slot.id} 指向的入口文件不存在或路径无效: ${slot.ui}`);
    }
  }
}

export function requiresPluginTrust(manifest: PluginManifest): boolean {
  return Boolean(manifest.entry || manifest.main || manifest.contributes.harnesses?.length || manifest.contributes.mcpPresets?.length);
}

export function readPluginPackage(directory: string): PluginPackage {
  const files = new Map<string, Buffer>();
  let size = 0;
  let count = 0;
  const visit = (root: string, prefix: string, depth: number) => {
    if (depth > 24) throw new Error('插件目录层级过深');
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && [POINTER_FILE, REVISIONS_DIR].includes(entry.name)) continue;
      if (++count > 4096) throw new Error('插件文件数量超过限制');
      const absolute = path.join(root, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolute, relative, depth + 1);
      } else if (entry.isFile()) {
        size += fs.statSync(absolute).size;
        if (size > 24 * 1024 * 1024) throw new Error('插件包超过 24 MiB');
        files.set(relative, fs.readFileSync(absolute));
      } else {
        throw new Error(`插件包仅支持普通文件和目录，无法导入 ${relative}`);
      }
    }
  };
  visit(fs.realpathSync(directory), '', 0);
  const manifestFile = files.get(MANIFEST_FILE);
  if (!manifestFile) throw new Error(`插件目录缺少 ${MANIFEST_FILE}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(manifestFile.toString('utf8').replace(/^\uFEFF/, '')));
  validatePackageReferencedFiles(manifest, files);
  return { manifest, files, digest: hashFiles(files) };
}

export function hashFiles(files: Map<string, Buffer>): string {
  const hash = crypto.createHash('sha256');
  for (const [name, file] of files) {
    hash.update(JSON.stringify([name, file.length]));
    hash.update(file);
  }
  return hash.digest('hex');
}

export function readRevisionPointer(root: string): RevisionPointer | undefined {
  const file = path.join(root, POINTER_FILE);
  if (!fs.existsSync(file)) return;
  const pointer = JSON.parse(fs.readFileSync(file, 'utf8')) as RevisionPointer;
  if (!revisionPattern.test(pointer.current) || (pointer.previous && !revisionPattern.test(pointer.previous))) {
    throw new Error('插件版本记录无效');
  }
  for (const digest of [pointer.currentDigest, pointer.previousDigest]) {
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('插件版本摘要无效');
  }
  return pointer;
}

export function revisionDirectory(root: string, revision: string): string {
  if (!revisionPattern.test(revision)) throw new Error('插件版本无效');
  const revisions = path.join(root, REVISIONS_DIR);
  if (fs.existsSync(revisions) && fs.realpathSync(revisions) !== revisions) throw new Error('插件版本目录不能使用链接');
  const directory = path.join(revisions, revision);
  if (fs.existsSync(directory) && fs.realpathSync(directory) !== directory) {
    throw new Error('插件版本路径不能使用链接');
  }
  return directory;
}

export function writeRevisionPointer(root: string, pointer: RevisionPointer): void {
  const stagingFile = path.join(root, `${POINTER_FILE}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(stagingFile, JSON.stringify(pointer), { flag: 'wx' });
    fs.renameSync(stagingFile, path.join(root, POINTER_FILE));
  } finally {
    fs.rmSync(stagingFile, { force: true });
  }
}

export function writeRevision(root: string, files: Map<string, Buffer>): string {
  const revision = crypto.randomUUID();
  const directory = revisionDirectory(root, revision);
  try {
    for (const [relative, content] of files) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { flag: 'wx' });
    }
  } catch (error) {
    try { fs.rmSync(revisionDirectory(root, revision), { recursive: true, force: true }); } catch { /* Preserve the write error. */ }
    throw error;
  }
  return revision;
}
