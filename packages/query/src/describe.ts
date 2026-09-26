import { entityKey, loadEntityRecords, type EntityRecord, type FossilDb } from '@codefossil/db';
import type { EntityRef } from '@codefossil/shared';

const SHORT_SHA = 7;

/** A human-readable name for an entity, used in CLI output and exports. */
export function labelOf(record: EntityRecord): string {
  switch (record.type) {
    case 'repository':
      return record.name;
    case 'commit':
      return `${record.sha.slice(0, SHORT_SHA)} ${record.subject}`;
    case 'file':
      return record.deletedAt ? `${record.path} (deleted)` : record.path;
    case 'symbol':
      return `${record.kind} ${record.qualifiedName} (${record.path}:${record.startLine})`;
    case 'issue':
      return `#${record.number} ${record.title}`;
    case 'pull_request':
      return `PR #${record.number} ${record.title}`;
    case 'review':
      return `review by ${record.author}${record.state ? ` (${record.state.toLowerCase()})` : ''}`;
    case 'test':
      return `test ${record.name}`;
    case 'dependency':
      return `${record.ecosystem}:${record.name}${record.version ? `@${record.version}` : ''}`;
    case 'incident':
      return `incident ${record.title}`;
  }
}

export interface EntityDescription {
  readonly ref: EntityRef;
  readonly label: string;
  /** Null when the entity no longer exists (a dangling reference). */
  readonly record: EntityRecord | null;
}

/** Describe many entities with one query per entity type. */
export function describeEntities(
  db: FossilDb,
  refs: readonly EntityRef[],
): Map<string, EntityDescription> {
  const records = loadEntityRecords(db, refs);
  return new Map(
    refs.map((ref) => {
      const record = records.get(entityKey(ref)) ?? null;
      return [
        entityKey(ref),
        { ref, record, label: record ? labelOf(record) : `${ref.type} #${ref.id} (missing)` },
      ];
    }),
  );
}
