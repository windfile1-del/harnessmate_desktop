import { createHash, randomUUID } from 'node:crypto';

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
}

export interface HandoffReceipt {
  snapshotId: string;
  sectionHashes: Record<string, string>;
}

export function composeSnapshot(input: Array<Omit<HandoffSection, 'hash'>>, previous?: HandoffReceipt): HandoffSnapshot {
  const sections = input.filter(({ text }) => text.trim()).map((section) => ({
    ...section, hash: createHash('sha256').update(section.source).update('\0').update(section.text).digest('hex'),
  }));
  return {
    snapshotId: randomUUID(),
    previousSnapshotId: previous?.snapshotId,
    sections: sections.filter(({ id, hash }) => previous?.sectionHashes[id] !== hash),
    sectionHashes: Object.fromEntries(sections.map(({ id, hash }) => [id, hash])),
  };
}
