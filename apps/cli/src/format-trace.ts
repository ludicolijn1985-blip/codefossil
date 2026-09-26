import { entityKey, type EvidenceRecord } from '@codefossil/db';
import type { EntityDescription, EvidencePath, TraversalResult } from '@codefossil/query';

/** Relation names read in the direction they were walked. */
const INVERSE: Readonly<Record<string, string>> = {
  INTRODUCED_BY: 'introduced',
  IMPLEMENTED_BY: 'implements',
  RESOLVED_BY: 'resolves',
  MODIFIES: 'modified by',
  REFERENCES: 'referenced by',
  IMPORTS: 'imported by',
  CONTAINS: 'contained in',
  DEPENDS_ON: 'depended on by',
  PARENT_OF: 'child of',
};

function verb(relation: string, direction: 'out' | 'in'): string {
  const forward = relation.toLowerCase().replaceAll('_', ' ');
  return direction === 'out' ? forward : (INVERSE[relation] ?? `${forward} (reverse)`);
}

function formatPath(
  index: number,
  path: EvidencePath,
  describe: (key: string) => string,
  evidence: ReadonlyMap<number, EvidenceRecord>,
): string {
  const header = `${index}. ${path.level} · confidence ${path.confidence.toFixed(2)}`;
  const start = path.nodes[0];
  const lines = [header, `   ${start ? describe(entityKey(start)) : ''}`];
  for (const edge of path.edges) {
    const provenance = `${edge.provenance.producer} ${edge.provenance.method}`;
    lines.push(
      `     → ${verb(edge.relation, edge.direction)} ${describe(entityKey(edge.to))}` +
        `  [${edge.evidenceType} ${edge.confidence.toFixed(2)} · ${provenance}]`,
    );
  }
  const locators = [
    ...new Set(
      path.edges.flatMap((edge) =>
        edge.provenance.evidenceIds.flatMap((id) => {
          const record = evidence.get(id);
          return record ? [record.locator] : [];
        }),
      ),
    ),
  ];
  if (locators.length > 0) lines.push(`   evidence: ${locators.join(', ')}`);
  return lines.join('\n');
}

export function formatTrace(
  title: string,
  result: TraversalResult,
  descriptions: ReadonlyMap<string, EntityDescription>,
  evidence: ReadonlyMap<number, EvidenceRecord>,
): string {
  const describe = (key: string) => descriptions.get(key)?.label ?? key;
  const heading = `${title} ${describe(entityKey(result.start))}`;
  if (result.paths.length === 0) {
    return `${heading}\n\nNo evidence chains found. The index holds no relations along this route.\n`;
  }
  const body = result.paths
    .map((path, i) => formatPath(i + 1, path, describe, evidence))
    .join('\n\n');
  const notes = result.truncated.map((reason) => `Note: incomplete — ${reason}.`).join('\n');
  return `${heading}\n\n${body}\n${notes ? `\n${notes}\n` : ''}`;
}
