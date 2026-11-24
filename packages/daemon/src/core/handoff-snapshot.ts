import { createHash, randomUUID } from 'node:crypto';
import { redactHandoffTextSync } from './handoff-redactor.js';

export interface HandoffSection {
  id: string;
  source: string;
  text: string;
  hash: string;
}

export interface HandoffSnapshot {
  snapshotId: string;
  previousSnapshotId?: string;
  sections: HandoffSection[];
  sectionHashes: Record<string, string>;
  redactedCount?: number;
  redactedCategories?: string[];
}

export interface HandoffReceipt {
  snapshotId: string;
  sectionHashes: Record<string, string>;
}

export function composeSnapshot(
  input: Array<Omit<HandoffSection, 'hash'>>,
  previous?: HandoffReceipt,
  opts?: { redact?: boolean },
): HandoffSnapshot {
  const shouldRedact = opts?.redact !== false;
  let redactedCount = 0;
  const redactedCategories = new Set<string>();

  const sections = input
    .filter(({ text }) => text.trim())
    .map((section) => {
      let safeText = section.text;
      if (shouldRedact) {
        const res = redactHandoffTextSync(section.text);
        safeText = res.text;
        redactedCount += res.redactedCount;
        for (const cat of res.categories) {
          redactedCategories.add(cat);
        }
      }
      return {
        ...section,
        text: safeText,
        hash: createHash('sha256').update(section.source).update('\0').update(safeText).digest('hex'),
      };
    });

  return {
    snapshotId: randomUUID(),
    previousSnapshotId: previous?.snapshotId,
    sections: sections.filter(({ id, hash }) => previous?.sectionHashes[id] !== hash),
    sectionHashes: Object.fromEntries(sections.map(({ id, hash }) => [id, hash])),
    redactedCount,
    redactedCategories: [...redactedCategories],
  };
}
