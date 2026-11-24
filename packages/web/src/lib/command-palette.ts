export interface CommandPaletteEntry {
  id: string;
  sourcePluginId: string;
  category: 'session' | 'harness' | 'plugin_action' | 'navigation' | 'theme';
  title: string;
  subtitle?: string;
  keywords: string[];
  shortcutHint?: string;
  priority?: number;
  slashCommand?: string;
  execute: () => Promise<void> | void;
}

export interface CommandUsage {
  count: number;
  lastUsedAt: number;
}

export type CommandMru = Record<string, CommandUsage>;
const mruKey = 'hm_desktop_palette_mru';
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

export class CommandPaletteRegistry {
  private readonly byKey = new Map<string, CommandPaletteEntry>();
  private readonly listeners = new Set<() => void>();
  private entries: readonly CommandPaletteEntry[] = [];

  getSnapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  register(entry: CommandPaletteEntry): () => void {
    const key = commandKey(entry);
    this.byKey.set(key, entry);
    this.publish();
    return () => {
      if (this.byKey.get(key) !== entry) return;
      this.byKey.delete(key);
      this.publish();
    };
  }

  private publish(): void {
    this.entries = [...this.byKey.values()];
    this.listeners.forEach((listener) => listener());
  }
}

export const commandPaletteRegistry = new CommandPaletteRegistry();
export const commandKey = (entry: CommandPaletteEntry) => `${entry.sourcePluginId}:${entry.id}`;

export function indexCommands(entries: readonly CommandPaletteEntry[]) {
  return entries.map((entry) => ({
    entry,
    key: commandKey(entry),
    fields: [entry.title, ...(entry.subtitle ? [entry.subtitle] : []), ...entry.keywords].map(normalize),
  }));
}

function fuzzyScore(term: string, field: string): number {
  const offset = field.indexOf(term);
  if (offset >= 0) {
    if (term.length === field.length) return 100;
    return offset === 0 ? 75 : Math.max(50, 65 - offset);
  }
  let cursor = 0;
  let first = -1;
  for (let i = 0; i < term.length; i++) {
    const pos = field.indexOf(term[i]!, cursor);
    if (pos < 0) return 0;
    if (first < 0) first = pos;
    cursor = pos + 1;
  }
  return Math.max(1, 42 - (cursor - first - term.length) * 2 - first);
}

export function rankCommands(index: ReturnType<typeof indexCommands>, query: string, mru: CommandMru, now = Date.now()): CommandPaletteEntry[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const ranked: Array<{ entry: CommandPaletteEntry; score: number }> = [];
  commands: for (const { entry, key, fields } of index) {
    let match = 0;
    for (const term of terms) {
      let best = 0;
      for (let i = 0; i < fields.length; i++) {
        const score = fuzzyScore(term, fields[i]!);
        best = Math.max(best, i === 0 ? score : score * 0.84);
      }
      if (best === 0) continue commands;
      match += best / terms.length;
    }
    const use = mru[key];
    const recency = use ? Math.max(0, 10 - Math.max(0, now - use.lastUsedAt) / 86_400_000) : 0;
    const frequency = use ? Math.min(12, 3 * Math.log2(1 + use.count)) : 0;
    ranked.push({ entry, score: match + (entry.priority ?? 0) + recency + frequency });
  }
  return ranked.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}

export function loadCommandMru(): CommandMru {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(mruKey) ?? '{}');
    if (stored && typeof stored === 'object') {
      return Object.fromEntries(Object.entries(stored).slice(0, 100).filter(([, value]) =>
        value && typeof value === 'object' && Number.isSafeInteger(value.count) && value.count > 0 &&
        Number.isFinite(value.lastUsedAt)));
    }
  } catch { /* Storage can be unavailable. */ }
  return {};
}

export function recordCommandUse(mru: CommandMru, entry: CommandPaletteEntry, now = Date.now()): CommandMru {
  const key = commandKey(entry);
  const next = { ...mru, [key]: { lastUsedAt: now, count: Math.min(1000, (mru[key]?.count ?? 0) + 1) } };
  const bounded = Object.fromEntries(Object.entries(next)
    .sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt).slice(0, 100));
  try { localStorage.setItem(mruKey, JSON.stringify(bounded)); } catch { /* Storage can be unavailable. */ }
  return bounded;
}

export function delegatedSearchQuery(query: string): string | undefined {
  return /^\?\s/.test(query) ? query.slice(1).trim() : undefined;
}

export function parsePaletteSlash(query: string): { command: string; args: string } | undefined {
  const match = /^\/([a-z0-9_-]+)\s+([\s\S]*)$/i.exec(query.trimStart());
  if (match) return { command: match[1]!.toLowerCase(), args: match[2]!.trim() };
}

export async function executePaletteEntry(
  entry: CommandPaletteEntry,
  onError: (title: string, detail?: string) => void,
): Promise<boolean> {
  try {
    await entry.execute();
    return true;
  } catch (err) {
    onError('命令执行失败，可以重试', err instanceof Error ? err.message.slice(0, 280) : undefined);
    return false;
  }
}
