import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import {
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  DEFAULT_MAX_TRANSCRIPT_LINES,
  type DetailedHistoryReadResult,
  type HistoryMessage,
  type JsonlReadOptions,
} from '../history-scanner.js';

export interface AbortableJsonlReadOptions extends JsonlReadOptions {
  signal?: AbortSignal;
}

export class HistoryReadCancelledError extends Error {
  constructor(message = '历史读取已取消') {
    super(message);
    this.name = 'HistoryReadCancelledError';
  }
}

export function isZstdTranscript(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zst');
}

interface JsonLinesStats {
  bytesRead: number;
  linesRead: number;
  corruptedLines: number;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HistoryReadCancelledError(
      typeof signal.reason === 'string' && signal.reason ? signal.reason : '历史读取已取消',
    );
  }
}

export async function* streamJsonLinesAbortable(
  file: string,
  opts?: AbortableJsonlReadOptions,
  stats?: JsonLinesStats,
): AsyncGenerator<Record<string, unknown>> {
  throwIfAborted(opts?.signal);
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
  const rawStream = fs.createReadStream(file);
  rawStream.on('error', () => {
    // Handled via readline/async-iterator try-catch and abort cleanup
  });
  const compressed = isZstdTranscript(file);
  const decodedStream = compressed ? rawStream.pipe(createZstdDecompress()) : rawStream;
  if (compressed) {
    decodedStream.on('error', () => {
      // Handled via readline/async-iterator try-catch and abort cleanup
    });
  }
  decodedStream.setEncoding('utf8');
  const lines = createInterface({ input: decodedStream, crlfDelay: Infinity });

  const localStats: JsonLinesStats = stats ?? {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };

  const onAbort = () => {
    lines.close();
    if (compressed) decodedStream.destroy();
    rawStream.destroy();
  };
  opts?.signal?.addEventListener('abort', onAbort, { once: true });

  let limitReached = false;
  try {
    for await (const line of lines) {
      throwIfAborted(opts?.signal);
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (localStats.bytesRead + lineBytes > maxBytes) {
        localStats.truncatedByBytes = true;
        limitReached = true;
        break;
      }
      if (localStats.linesRead >= maxLines) {
        localStats.truncatedByLines = true;
        limitReached = true;
        break;
      }
      localStats.bytesRead += lineBytes;
      localStats.linesRead += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as unknown;
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          yield row as Record<string, unknown>;
        }
      } catch {
        localStats.corruptedLines += 1;
      }
    }
    throwIfAborted(opts?.signal);
  } catch (err) {
    if (err instanceof HistoryReadCancelledError || opts?.signal?.aborted) {
      throw new HistoryReadCancelledError(
        typeof opts?.signal?.reason === 'string' && opts.signal.reason ? opts.signal.reason : '历史读取已取消',
      );
    }
    if (!limitReached) {
      localStats.corruptedLines += 1;
    }
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort);
    lines.close();
    if (compressed) {
      decodedStream.destroy();
    }
    rawStream.destroy();
  }
}

export async function readFirstJsonlRecord(
  file: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  for await (const row of streamJsonLinesAbortable(file, { maxBytes: 1024 * 1024, maxLines: 16, signal })) {
    return row;
  }
  return undefined;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as Record<string, unknown>;
      return typeof rec.type === 'string'
        && (rec.type === 'text' || rec.type === 'input_text' || rec.type === 'output_text')
        && typeof rec.text === 'string'
        ? [rec.text]
        : [];
    })
    .join('\n');
}

export async function readJsonlTranscriptAbortable(
  sourcePath: string,
  harnessKind: 'codex' | 'claude' | 'custom',
  opts?: AbortableJsonlReadOptions,
): Promise<DetailedHistoryReadResult> {
  throwIfAborted(opts?.signal);
  let fileLockedWarning = false;
  try {
    const st = fs.statSync(sourcePath);
    if (Date.now() - st.mtimeMs < 5_000) {
      fileLockedWarning = true;
    }
  } catch {
    // ignore stat race
  }

  const stats: JsonLinesStats = {
    bytesRead: 0,
    linesRead: 0,
    corruptedLines: 0,
    truncatedByBytes: false,
    truncatedByLines: false,
  };
  const messages: HistoryMessage[] = [];
  const positions = new Map<string, number>();
  const eventMessages: HistoryMessage[] = [];

  for await (const row of streamJsonLinesAbortable(sourcePath, opts, stats)) {
    const timestamp = Date.parse(String(row.timestamp)) || undefined;

    if (harnessKind === 'custom') {
      const role = row.role === 'user' || row.role === 'assistant' ? row.role : undefined;
      const text = typeof row.text === 'string'
        ? row.text
        : extractMessageText((row.message as Record<string, unknown> | undefined)?.content ?? row.content);
      if (role && text.trim()) {
        messages.push({ role, text, timestamp });
      }
      continue;
    }

    if (harnessKind === 'codex' && row.type === 'event_msg') {
      const payload = (row.payload && typeof row.payload === 'object' ? row.payload : undefined) as Record<string, unknown> | undefined;
      const role = payload?.type === 'user_message' ? 'user' : payload?.type === 'agent_message' ? 'assistant' : undefined;
      if (role && typeof payload?.message === 'string' && payload.message.trim()) {
        eventMessages.push({ role, text: payload.message, timestamp });
      }
    }

    const payload = (row.payload && typeof row.payload === 'object' ? row.payload : undefined) as Record<string, unknown> | undefined;
    const msgObj = (row.message && typeof row.message === 'object' ? row.message : undefined) as Record<string, unknown> | undefined;

    const message = harnessKind === 'codex'
      ? (row.type === 'response_item' && payload?.type === 'message' ? payload : undefined)
      : (row.type === 'user' || row.type === 'assistant') && !row.isMeta && !row.isSidechain && !row.isCompactSummary
        ? msgObj
        : undefined;

    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = extractMessageText(message?.content);
    if (harnessKind === 'codex' && role === 'user' && Array.isArray(message?.content)) {
      text = extractMessageText(
        message.content.filter((block) => {
          const b = block as Record<string, unknown> | null;
          return typeof b?.text !== 'string'
            || !/^(?:<environment_context>|<permissions instructions>|# AGENTS\.md instructions)/.test(b.text.trim());
        }),
      );
    }
    if (!text.trim()) continue;
    const key = typeof message?.id === 'string' ? message.id : undefined;
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

  const finalMessages =
    harnessKind === 'codex' && !messages.some((m) => m.role === 'user') && eventMessages.length > 0
      ? eventMessages
      : messages;

  const partial = stats.truncatedByBytes || stats.truncatedByLines || stats.corruptedLines > 0;
  const truncatedReason = stats.truncatedByBytes
    ? 'max_bytes'
    : stats.truncatedByLines
      ? 'max_lines'
      : stats.corruptedLines > 0
        ? 'corrupted_trailing_line'
        : undefined;

  return {
    messages: finalMessages,
    partial,
    bytesRead: stats.bytesRead,
    linesRead: stats.linesRead,
    truncatedReason,
    fileLockedWarning,
  };
}
