import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DevPluginLink {
  id: string;
  dirPath: string;
  linkedAt: number;
}

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.revisions', '.harnessmate-active.json']);
const WATCH_DEBOUNCE_MS = 180;

export class PluginDevWatcher {
  private readonly storePath: string;
  private links = new Map<string, DevPluginLink>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    dataDir: string,
    private readonly onPluginChanged: (pluginId: string, filename?: string) => void,
  ) {
    this.storePath = path.join(dataDir, 'dev-plugins.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as DevPluginLink).id === 'string' &&
          typeof (item as DevPluginLink).dirPath === 'string'
        ) {
          const entry = item as DevPluginLink;
          this.links.set(entry.id, {
            id: entry.id,
            dirPath: entry.dirPath,
            linkedAt: typeof entry.linkedAt === 'number' ? entry.linkedAt : Date.now(),
          });
        }
      }
    } catch {
      // Ignore corrupt dev-plugins file
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.links.values()], null, 2), 'utf8');
    fs.renameSync(tmp, this.storePath);
  }

  list(): DevPluginLink[] {
    return [...this.links.values()];
  }

  get(pluginId: string): DevPluginLink | undefined {
    return this.links.get(pluginId);
  }

  has(pluginId: string): boolean {
    return this.links.has(pluginId);
  }

  link(pluginId: string, dirPath: string): DevPluginLink {
    const resolved = fs.realpathSync(dirPath);
    const entry: DevPluginLink = { id: pluginId, dirPath: resolved, linkedAt: Date.now() };
    this.links.set(pluginId, entry);
    this.save();
    this.startWatching(entry);
    return entry;
  }

  unlink(pluginId: string): boolean {
    const existed = this.links.delete(pluginId);
    this.stopWatching(pluginId);
    if (existed) this.save();
    return existed;
  }

  startAllWatchers(): void {
    for (const entry of this.links.values()) {
      this.startWatching(entry);
    }
  }

  private startWatching(entry: DevPluginLink): void {
    this.stopWatching(entry.id);
    if (!fs.existsSync(entry.dirPath)) return;
    try {
      const watcher = fs.watch(entry.dirPath, { recursive: true }, (_eventType, filename) => {
        const name = typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
        if (name && name.split('/').some((seg) => IGNORED_SEGMENTS.has(seg) || seg.endsWith('.tmp'))) {
          return;
        }
        const existingTimer = this.timers.get(entry.id);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          this.timers.delete(entry.id);
          this.onPluginChanged(entry.id, name || undefined);
        }, WATCH_DEBOUNCE_MS);
        this.timers.set(entry.id, timer);
      });
      watcher.on('error', () => {
        // Directory may have been removed; keep host stable
      });
      this.watchers.set(entry.id, watcher);
    } catch {
      // Fallback: manual reload remains available if fs.watch is unavailable
    }
  }

  private stopWatching(pluginId: string): void {
    const timer = this.timers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(pluginId);
    }
    const watcher = this.watchers.get(pluginId);
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      this.watchers.delete(pluginId);
    }
  }

  close(): void {
    for (const pluginId of [...this.watchers.keys()]) {
      this.stopWatching(pluginId);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
