import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  readAgyIndexedHistoryDetailedFromRoot,
  type AgyIndexedHistoryReadOptions,
  type AgyIndexedHistoryReadResult,
} from '../history-scanner.js';

export interface AgyPresenceCheck {
  summaryExists: boolean;
  pbExists: boolean;
}

function sameCanonicalPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(
    process.platform === 'win32' ? rootReal.toLowerCase() : rootReal,
    process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal,
  );
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function checkAgyConversationPresence(root: string, nativeSessionId: string): AgyPresenceCheck {
  if (!/^[\da-f-]{36}$/i.test(nativeSessionId)) {
    return { summaryExists: false, pbExists: false };
  }
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
    if (!fs.statSync(rootReal).isDirectory()) return { summaryExists: false, pbExists: false };
  } catch {
    return { summaryExists: false, pbExists: false };
  }

  let pbExists = false;
  for (const ext of ['.pb', '.db']) {
    const candidate = path.join(rootReal, 'conversations', `${nativeSessionId}${ext}`);
    try {
      const lst = fs.lstatSync(candidate);
      if (!lst.isSymbolicLink() && lst.isFile()) {
        const real = fs.realpathSync(candidate);
        if (sameCanonicalPath(real, candidate) && isWithinRoot(rootReal, real)) {
          pbExists = true;
          break;
        }
      }
    } catch {
      // absent
    }
  }

  let summaryExists = false;
  const dbPath = path.join(rootReal, 'conversation_summaries.db');
  try {
    const lst = fs.lstatSync(dbPath);
    if (!lst.isSymbolicLink() && lst.isFile()) {
      const real = fs.realpathSync(dbPath);
      if (sameCanonicalPath(real, dbPath) && isWithinRoot(rootReal, real)) {
        const hasWal = fs.existsSync(`${real}-wal`);
        const hasShm = fs.existsSync(`${real}-shm`);
        const target = hasWal && hasShm ? real : `${pathToFileURL(real).href}?immutable=1`;
        const db = new DatabaseSync(target, { readOnly: true });
        try {
          const row = db
            .prepare('SELECT 1 AS found FROM conversation_summaries WHERE conversation_id = ? LIMIT 1')
            .get(nativeSessionId) as { found?: number } | undefined;
          summaryExists = row?.found === 1;
        } finally {
          db.close();
        }
      }
    }
  } catch {
    summaryExists = false;
  }

  return { summaryExists, pbExists };
}

export function readAgyHistoryWithDiagnostics(
  root: string,
  nativeSessionId: string,
  opts?: AgyIndexedHistoryReadOptions,
): {
  detailed: AgyIndexedHistoryReadResult;
  presence: AgyPresenceCheck;
} {
  const detailed = readAgyIndexedHistoryDetailedFromRoot(root, nativeSessionId, opts);
  const presence =
    detailed.messages.length === 0 && !detailed.skippedReason
      ? checkAgyConversationPresence(root, nativeSessionId)
      : { summaryExists: detailed.messages.length > 0, pbExists: false };
  return { detailed, presence };
}
