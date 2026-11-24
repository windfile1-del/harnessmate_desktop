import { DatabaseSync } from 'node:sqlite';
import { resolveManagedProfilePathSync } from './agy-profile-manager.js';

const AGY_ERROR_STEP_TYPE = 17;

export interface AgySilentTurnError {
  failed: true;
  code: string;
  failureClass: string;
  message: string;
  corruptSession: boolean;
  resetAt?: number | null;
}

function openConversationDbReadonly(
  appDataPath: string,
  nativeSessionId: string,
): DatabaseSync | null {
  if (!appDataPath || !nativeSessionId.trim()) return null;
  const safeDb = resolveManagedProfilePathSync(
    appDataPath,
    ['conversations', `${nativeSessionId.trim()}.db`],
    'file',
  );
  if (!safeDb) return null;
  try {
    return new DatabaseSync(safeDb.path, { readOnly: true });
  } catch {
    return null;
  }
}

export function readAgyConversationMaxStepIdx(
  appDataPath: string,
  nativeSessionId: string,
): number | null {
  const db = openConversationDbReadonly(appDataPath, nativeSessionId);
  if (!db) return null;
  try {
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='steps'")
      .get() as { name?: string } | undefined;
    if (!tableRow) return null;
    const row = db.prepare('SELECT MAX(idx) AS maxIdx FROM steps').get() as
      | { maxIdx?: number | null }
      | undefined;
    return typeof row?.maxIdx === 'number' ? row.maxIdx : -1;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function extractResetTimestamp(text: string): number | null {
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (!isoMatch) return null;
  const ms = Date.parse(isoMatch[0]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Inspects newly written rows in `<appDataPath>/conversations/<nativeSessionId>.db`
 * after `session/prompt` returns to catch silent `ERROR_STEP_TYPE(17)` failures
 * (e.g. `QUOTA_EXHAUSTED`, `429`, `INVALID_THINKING_SIGNATURE`).
 */
export function detectSilentAgyTurnError(
  appDataPath: string,
  nativeSessionId: string,
  baselineIdx: number | null | undefined,
): AgySilentTurnError | null {
  const db = openConversationDbReadonly(appDataPath, nativeSessionId);
  if (!db) return null;
  try {
    const cols = db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: string }>;
    const colNames = new Set(cols.map((c) => c.name).filter((n): n is string => Boolean(n)));
    if (!colNames.has('idx') || !colNames.has('type')) return null;

    const payloadCol = colNames.has('payload')
      ? 'payload'
      : colNames.has('data')
        ? 'data'
        : colNames.has('json')
          ? 'json'
          : colNames.has('message')
            ? 'message'
            : null;
    const minIdx = typeof baselineIdx === 'number' ? baselineIdx : -1;
    const selectSql = payloadCol
      ? `SELECT idx, type, ${payloadCol} AS body FROM steps WHERE idx > ? AND type = ? ORDER BY idx DESC LIMIT 5`
      : 'SELECT idx, type FROM steps WHERE idx > ? AND type = ? ORDER BY idx DESC LIMIT 5';
    const rows = db.prepare(selectSql).all(minIdx, AGY_ERROR_STEP_TYPE) as Array<{
      idx: number;
      type: number;
      body?: unknown;
    }>;

    for (const row of rows) {
      const text = typeof row.body === 'string' ? row.body : JSON.stringify(row.body ?? '');
      if (/INVALID_THINKING_SIGNATURE/i.test(text)) {
        return {
          failed: true,
          code: 'invalid_thinking_signature',
          failureClass: 'provider_error',
          message: 'AGY 检测到历史 thinking signature 损坏，将自动重建原生会话以恢复上下文。',
          corruptSession: true,
        };
      }
      if (/QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|\b429\b|rate.?limit/i.test(text)) {
        return {
          failed: true,
          code: 'quota_exhausted',
          failureClass: /429/.test(text) ? 'rate_limited' : 'usage_limit',
          message: text.slice(0, 400) || 'AGY 配额或速率限制已触发 (ERROR_STEP_TYPE 17)',
          corruptSession: false,
          resetAt: extractResetTimestamp(text),
        };
      }
      if (text.trim()) {
        return {
          failed: true,
          code: 'agy_error_step',
          failureClass: 'provider_error',
          message: text.slice(0, 400),
          corruptSession: false,
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
