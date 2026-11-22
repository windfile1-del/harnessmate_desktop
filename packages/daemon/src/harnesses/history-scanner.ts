import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredCliSession } from '@harnessmate/protocol';

/**
 * Read-only scanner that discovers recent sessions saved locally by
 * Claude Code (~/.claude/history.jsonl), Codex (~/.codex/sessions),
 * and Antigravity CLI (~/.gemini/antigravity-cli/conversations).
 */
export function scanLocalCliSessions(limitPerHarness = 20): DiscoveredCliSession[] {
  const results: DiscoveredCliSession[] = [];
  results.push(...scanClaudeHistory(limitPerHarness));
  results.push(...scanCodexSessions(limitPerHarness));
  results.push(...scanAgyConversations(limitPerHarness));
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

function scanClaudeHistory(limit: number): DiscoveredCliSession[] {
  const historyFile = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(historyFile)) return [];

  try {
    const raw = fs.readFileSync(historyFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const bySession = new Map<string, DiscoveredCliSession>();

    for (let i = lines.length - 1; i >= 0 && bySession.size < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as {
          sessionId?: string;
          display?: string;
          project?: string;
          timestamp?: number;
        };
        if (!entry.sessionId || bySession.has(entry.sessionId)) continue;
        bySession.set(entry.sessionId, {
          harnessKind: 'claude',
          nativeSessionId: entry.sessionId,
          title: (entry.display || 'Claude Code Session').slice(0, 100),
          cwd: entry.project ?? null,
          updatedAt: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
          sourcePath: historyFile,
        });
      } catch {
        // skip malformed line
      }
    }
    return Array.from(bySession.values());
  } catch {
    return [];
  }
}

function scanCodexSessions(limit: number): DiscoveredCliSession[] {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];

  const found: Array<{ file: string; mtimeMs: number }> = [];
  walkJsonl(root, 4, found);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: DiscoveredCliSession[] = [];
  for (const item of found.slice(0, limit)) {
    try {
      const fd = fs.openSync(item.file, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0];
      if (!firstLine) continue;
      const parsed = JSON.parse(firstLine) as {
        id?: string;
        payload?: { id?: string; cwd?: string };
      };
      const id = parsed.payload?.id ?? parsed.id ?? path.basename(item.file, '.jsonl');
      sessions.push({
        harnessKind: 'codex',
        nativeSessionId: id,
        title: `Codex · ${path.basename(parsed.payload?.cwd || id)}`,
        cwd: parsed.payload?.cwd ?? null,
        updatedAt: Math.floor(item.mtimeMs),
        sourcePath: item.file,
      });
    } catch {
      // skip unreadable file
    }
  }
  return sessions;
}

function scanAgyConversations(limit: number): DiscoveredCliSession[] {
  const convDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
  if (!fs.existsSync(convDir)) return [];

  try {
    const entries = fs
      .readdirSync(convDir, { withFileTypes: true })
      .map((ent) => {
        const full = path.join(convDir, ent.name);
        const stat = fs.statSync(full);
        return { name: ent.name, full, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);

    return entries.map((e) => {
      const id = e.name.replace(/\.[^.]+$/, '');
      return {
        harnessKind: 'agy',
        nativeSessionId: id,
        title: `AGY · ${id.slice(0, 12)}`,
        cwd: null,
        updatedAt: Math.floor(e.mtimeMs),
        sourcePath: e.full,
      };
    });
  } catch {
    return [];
  }
}

function walkJsonl(dir: string, depth: number, out: Array<{ file: string; mtimeMs: number }>): void {
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJsonl(full, depth - 1, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        out.push({ file: full, mtimeMs: stat.mtimeMs });
      } catch {
        // skip
      }
    }
  }
}
