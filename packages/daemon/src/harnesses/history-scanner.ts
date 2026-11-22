import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { DiscoveredCliSession, HarnessKind } from '@harnessmate/protocol';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

const agySources = { agy_desktop: 'antigravity', agy_cli: 'antigravity-cli' } as const;

export function agyDataDirectory(source: DiscoveredCliSession['source']): string | undefined {
  return source === 'agy_desktop' ? agySources.agy_desktop : undefined;
}

export function readAgyIndexedHistory(session: DiscoveredCliSession): HistoryMessage[] {
  if (session.source !== 'agy_desktop' && session.source !== 'agy_cli') return [];
  const dbPath = path.join(os.homedir(), '.gemini', agySources[session.source], 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return [];
  const messages = new Map<string, HistoryMessage & { index: number }>();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets
      FROM conversations_fts WHERE conversation_id = ? AND chunk_index >= 0 ORDER BY chunk_index`)
      .iterate(session.nativeSessionId);
    for (const row of rows) {
      for (const [role, body, offsets] of [
        ['user', row.user_body, row.user_step_byte_offsets],
        ['assistant', row.agent_body, row.agent_step_byte_offsets],
      ] as const) {
        if (typeof body !== 'string' || !body || !offsets) continue;
        const bytes = Buffer.from(body, 'utf8');
        const offsetsText = typeof offsets === 'string' ? offsets
          : offsets instanceof Uint8Array ? Buffer.from(offsets).toString('utf8') : '';
        let positions: unknown;
        try { positions = JSON.parse(offsetsText); } catch { continue; }
        if (!Array.isArray(positions)) continue;
        for (const [entry, position] of positions.entries()) {
          if (!Array.isArray(position)) continue;
          const [index, start] = position;
          const end = positions[entry + 1]?.[1] ?? bytes.length;
          if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end) || start < 0 || start >= end || end > bytes.length) continue;
          const text = bytes.subarray(start, end).toString('utf8').trim();
          if (text) messages.set(`${index}:${role}`, { index, role, text });
        }
      }
    }
  } catch { /* optional index on older Antigravity versions */ }
  finally { db?.close(); }
  return [...messages.values()].sort((a, b) => a.index - b.index)
    .map(({ role, text }) => ({ role, text }));
}

export async function scanLocalCliSessions(limitPerHarness = 20): Promise<DiscoveredCliSession[]> {
  const groups = await Promise.all([
    scanClaude(limitPerHarness),
    scanCodex(limitPerHarness),
    ...Object.entries(agySources).map(([source, dir]) =>
      scanAgy(dir, source as keyof typeof agySources, limitPerHarness)),
  ]);
  return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function findLocalSession(
  kind: HarnessKind, id: string, source?: DiscoveredCliSession['source'],
): Promise<DiscoveredCliSession | undefined> {
  switch (kind) {
    case 'codex': return (await scanCodex(1, id))[0];
    case 'claude': return (await scanClaude(1, id))[0];
    case 'agy': {
      const sources = source === 'agy_desktop' ? ['agy_desktop'] as const
        : source === 'agy_cli' ? ['agy_cli'] as const : ['agy_cli', 'agy_desktop'] as const;
      return sources.flatMap((key) => scanAgy(agySources[key], key, 1, id))[0];
    }
    default: return undefined;
  }
}

async function* jsonLines(file: string): AsyncGenerator<Record<string, any>> {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row)) yield row;
      } catch {
        // A transcript can have an incomplete trailing record while the source app is writing.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function firstRecord(file: string) {
  for await (const row of jsonLines(file)) return row;
  return undefined;
}

function dirs(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function collectFiles(dir: string, depth: number, nameMatches: (name: string) => boolean) {
  const files: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (root: string, remaining: number) => {
    for (const ent of dirs(root)) {
      const file = path.join(root, ent.name);
      if (ent.isDirectory() && remaining > 0) walk(file, remaining - 1);
      if (ent.isFile() && nameMatches(ent.name)) {
        try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* rotated */ }
      }
    }
  };
  walk(dir, depth);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export function getCodexRolloutStore(rollout: string): { home: string; archived: boolean } | undefined {
  let current = path.dirname(rollout);
  while (path.dirname(current) !== current) {
    const name = path.basename(current);
    if (name === 'sessions' || name === 'archived_sessions') {
      return { home: path.dirname(current), archived: name === 'archived_sessions' };
    }
    current = path.dirname(current);
  }
  return undefined;
}

async function scanCodex(limit: number, id?: string): Promise<DiscoveredCliSession[]> {
  const homes = new Set<string>();
  for (const candidate of [process.env.CODEX_HOME, path.join(os.homedir(), '.codex')]) {
    if (!candidate) continue;
    try { homes.add(fs.realpathSync(candidate)); } catch { /* absent profile */ }
  }
  const names = new Map<string, string>();
  const files: ReturnType<typeof collectFiles> = [];
  for (const home of homes) {
    try {
      for await (const row of jsonLines(path.join(home, 'session_index.jsonl'))) {
        if (typeof row.id === 'string' && typeof row.thread_name === 'string') names.set(row.id, row.thread_name);
      }
    } catch { /* optional title index */ }
    for (const dir of ['sessions', 'archived_sessions']) {
      files.push(...collectFiles(path.join(home, dir), 3,
        (name) => name.endsWith('.jsonl') && (!id || name.endsWith(`-${id}.jsonl`))));
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const result = new Map<string, DiscoveredCliSession>();
  const counts = { codex_desktop: 0, codex_cli: 0 };
  for (const { file, mtimeMs } of files) {
    if ((id && result.size) || (counts.codex_desktop >= limit && counts.codex_cli >= limit)) break;
    try {
      const meta = await firstRecord(file);
      const payload = meta?.type === 'session_meta' ? meta.payload : undefined;
      const nativeSessionId: unknown = payload?.id ?? meta?.id ?? meta?.payload?.id;
      if (typeof nativeSessionId !== 'string' || (id && id !== nativeSessionId) || result.has(nativeSessionId)) continue;
      const cwd = typeof meta?.payload?.cwd === 'string' ? meta.payload.cwd : null;
      const origin = String(payload?.originator ?? '').toLowerCase();
      const desktop = origin.startsWith('codex desktop') || origin === 'codex app'
        || origin === 'codex_vscode' || payload?.source === 'vscode';
      const source = desktop ? 'codex_desktop' : 'codex_cli';
      if (counts[source] >= limit) continue;
      counts[source]++;
      result.set(nativeSessionId, {
        harnessKind: 'codex', source, nativeSessionId,
        title: names.get(nativeSessionId) || `Codex · ${path.basename(cwd || nativeSessionId)}`,
        cwd, updatedAt: Math.floor(mtimeMs), sourcePath: file,
      });
    } catch { /* file moved or unreadable */ }
  }
  return [...result.values()];
}

async function scanClaude(limit: number, id?: string): Promise<DiscoveredCliSession[]> {
  const home = claudeHome();
  const index = new Map<string, Record<string, any>>();
  try {
    for await (const row of jsonLines(path.join(home, 'history.jsonl'))) {
      if (typeof row.sessionId === 'string' && (!id || row.sessionId === id)) index.set(row.sessionId, row);
    }
  } catch { /* optional prompt index */ }
  const found: DiscoveredCliSession[] = [];
  for (const { file, mtimeMs } of collectFiles(path.join(home, 'projects'), 1,
    (name) => /^[\da-f-]{36}\.jsonl$/i.test(name) && (!id || name === `${id}.jsonl`))) {
    if (found.length >= limit) break;
    const nativeSessionId = path.basename(file, '.jsonl');
    const row = index.get(nativeSessionId);
    let cwd = typeof row?.project === 'string' ? row.project : null;
    if (!cwd) {
      try {
        for await (const item of jsonLines(file)) {
          if (typeof item.cwd === 'string') { cwd = item.cwd; break; }
        }
      } catch { continue; }
    }
    found.push({
      harnessKind: 'claude', source: 'claude_cli', nativeSessionId,
      title: (String(row?.display || '') || `Claude · ${path.basename(cwd || nativeSessionId)}`).slice(0, 100),
      cwd, updatedAt: Math.floor(mtimeMs), sourcePath: file,
    });
  }
  return found;
}

function scanAgy(dir: string, source: keyof typeof agySources, limit: number, id?: string): DiscoveredCliSession[] {
  const root = path.join(os.homedir(), '.gemini', dir);
  const dbPath = path.join(root, 'conversation_summaries.db');
  const found = new Map<string, DiscoveredCliSession>();
  let db: DatabaseSync | undefined;
  try {
    if (fs.existsSync(dbPath)) {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(`SELECT conversation_id, title, workspace_uris, last_modified_time
        FROM conversation_summaries ${id ? 'WHERE conversation_id = ?' : ''}
        ORDER BY last_modified_time DESC LIMIT ?`).all(...(id ? [id, limit] : [limit]));
      for (const row of rows) {
        if (typeof row.conversation_id !== 'string' || !/^[\da-f-]{36}$/i.test(row.conversation_id)) continue;
        const nativeSessionId = row.conversation_id;
        let cwd: string | null = null;
        try {
          const uris: unknown = JSON.parse(String(row.workspace_uris));
          if (Array.isArray(uris)) {
            for (const uri of uris) {
              if (typeof uri === 'string' && uri.startsWith('file:')) { cwd = fileURLToPath(uri); break; }
            }
          }
        } catch { /* optional workspace */ }
        found.set(nativeSessionId, {
          harnessKind: 'agy', source, nativeSessionId, cwd,
          title: String(row.title || `AGY · ${nativeSessionId.slice(0, 12)}`),
          updatedAt: Date.parse(String(row.last_modified_time)) || 0,
        });
      }
    }
  } catch { /* older installations can still enumerate conversation files */ }
  finally { db?.close(); }
  if (found.size < limit) {
    for (const { file, mtimeMs } of collectFiles(path.join(root, 'conversations'), 0,
      (name) => /^[\da-f-]{36}\.(db|pb)$/i.test(name) && (!id || name.startsWith(`${id}.`)))) {
      if (found.size >= limit) break;
      const nativeSessionId = path.basename(file, path.extname(file));
      if (!found.has(nativeSessionId)) found.set(nativeSessionId, {
        harnessKind: 'agy', source, nativeSessionId, cwd: null,
        title: `AGY · ${nativeSessionId.slice(0, 12)}`, updatedAt: Math.floor(mtimeMs),
      });
    }
  }
  return [...found.values()];
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((item) => item && ['text', 'input_text', 'output_text'].includes(item.type)
    && typeof item.text === 'string' ? [item.text] : []).join('\n');
}

export async function readJsonlHistory(session: DiscoveredCliSession): Promise<HistoryMessage[]> {
  if (!session.sourcePath) throw new Error('找不到原生会话记录');
  const messages: HistoryMessage[] = [];
  const positions = new Map<string, number>();
  const eventMessages: HistoryMessage[] = [];
  for await (const row of jsonLines(session.sourcePath)) {
    const timestamp = Date.parse(String(row.timestamp));
    if (session.harnessKind === 'codex' && row.type === 'event_msg') {
      const role = row.payload?.type === 'user_message' ? 'user'
        : row.payload?.type === 'agent_message' ? 'assistant' : undefined;
      if (role && typeof row.payload.message === 'string' && row.payload.message.trim()) {
        eventMessages.push({ role, text: row.payload.message, timestamp });
      }
    }
    const message = session.harnessKind === 'codex'
      ? (row.type === 'response_item' && row.payload?.type === 'message' ? row.payload : undefined)
      : (row.type === 'user' || row.type === 'assistant') && !row.isMeta && !row.isSidechain && !row.isCompactSummary
        ? row.message : undefined;
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = messageText(message.content);
    if (session.harnessKind === 'codex' && role === 'user' && Array.isArray(message.content)) {
      text = messageText(message.content.filter((block: any) =>
        typeof block?.text !== 'string' || !/^(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions)/.test(block.text.trim())));
    }
    if (!text.trim()) continue;
    const key = typeof message.id === 'string' ? message.id : undefined;
    const position = key ? positions.get(key) : undefined;
    if (position === undefined) {
      if (key) positions.set(key, messages.length);
      messages.push({ role, text, timestamp });
    } else if (text.startsWith(messages[position]!.text)) {
      messages[position]!.text = text;
    } else if (text !== messages[position]!.text) {
      messages[position]!.text += `\n\n${text}`;
    }
  }
  return messages.some((message) => message.role === 'user') || !eventMessages.length ? messages : eventMessages;
}
