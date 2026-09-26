import type { InvestigationRow } from '@codefossil/db';
import type { Dependent, ImpactReport, Timeline, WhyInvestigation } from '@codefossil/query';
import { plural } from './format.js';

function section(title: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : `\n${title}\n${lines.join('\n')}\n`;
}

function saved(id: number | null): string {
  return id === null
    ? ''
    : `\nSaved as investigation #${id} (\`fossil investigate --show ${id}\`).\n`;
}

export function formatWhy(why: WhyInvestigation, savedId: number | null): string {
  const weakest = why.statements.reduce<(typeof why.statements)[number] | undefined>(
    (min, s) => (min === undefined || s.confidence < min.confidence ? s : min),
    undefined,
  );
  const certainty =
    why.statements.length === 0
      ? 'No statements could be made from the index.'
      : `Confidence ${why.confidence.toFixed(2)} · ${why.classification}` +
        (weakest && weakest.confidence < 1 ? ` (weakest link: ${weakest.role})` : '');
  return (
    `${why.question}\n\n${why.answer}\n\n${certainty}\n` +
    section(
      'Statements',
      why.statements.map((s) => `  ${s.level.padEnd(8)} ${s.confidence.toFixed(2)}  ${s.text}`),
    ) +
    section(
      'Evidence',
      why.evidence.map((e) => `  [${e.id}] ${e.type.padEnd(12)} ${e.locator}  — ${e.reason}`),
    ) +
    section(
      'Related',
      why.related.map((r) => `  ${r.label}  (${r.relation})`),
    ) +
    section(
      'Caveats',
      why.caveats.map((c) => `  - ${c}`),
    ) +
    saved(savedId)
  );
}

function dependentLine(d: Dependent): string {
  const test = d.isTest ? ' [test]' : '';
  const via = d.via.length > 0 ? `  via ${d.via.join(' → ')}` : '';
  const certainty = d.confidence < 1 ? `  (confidence ${d.confidence.toFixed(2)})` : '';
  return `  ${d.label}${test}${via}${certainty}`;
}

export function formatImpact(report: ImpactReport, savedId: number | null): string {
  const byDistance = new Map<number, Dependent[]>();
  for (const d of report.transitive)
    byDistance.set(d.distance, [...(byDistance.get(d.distance) ?? []), d]);
  const transitive = [...byDistance].flatMap(([distance, list]) => [
    `  distance ${distance}:`,
    ...list.map((d) => `  ${dependentLine(d)}`),
  ]);
  const definedIn = report.definedIn ? `Defined in ${report.definedIn.label}.\n` : '';
  return (
    `${report.question}\n\n${definedIn}${report.answer}\n` +
    section(`Direct (${report.direct.length})`, report.direct.map(dependentLine)) +
    section(`Transitive (${report.transitive.length})`, transitive) +
    section(
      'Notes',
      [...report.truncated.map((t) => `incomplete — ${t}`), ...report.caveats].map(
        (c) => `  - ${c}`,
      ),
    ) +
    saved(savedId)
  );
}

export function formatTimeline(timeline: Timeline): string {
  const formerly =
    timeline.paths.length > 1 ? ` (formerly ${timeline.paths.slice(1).join(', ')})` : '';
  const header = `Timeline of ${timeline.target.label}${formerly} — ${plural(timeline.entries.length, 'change')}\n`;
  const entries = timeline.entries.map((e) => {
    const lines = e.additions === null ? 'binary' : `+${e.additions} −${e.deletions ?? 0}`;
    const path = e.change === 'renamed' ? `${e.previousPath ?? '?'} → ${e.path}` : e.path;
    const out = [
      `${e.committedAt.slice(0, 10)}  ${e.sha.slice(0, 7)}  ${e.change.padEnd(8)}  ${path}  ${lines}  "${e.subject}" (${e.author})`,
    ];
    if (e.symbols.length > 0) out.push(`             symbols: ${e.symbols.join(', ')}`);
    if (e.pullRequests.length > 0) out.push(`             ${e.pullRequests.join('; ')}`);
    for (const issue of e.issues) out.push(`             ${issue.relation} ${issue.label}`);
    return out.join('\n');
  });
  return `${header}\n${entries.join('\n')}\n`;
}

export function formatInvestigationList(rows: readonly InvestigationRow[]): string {
  if (rows.length === 0)
    return 'No investigations saved yet. Ask with `fossil why`, `fossil impact` or `fossil query`.\n';
  return `${rows
    .map(
      (row) =>
        `#${row.id}  ${row.createdAt.slice(0, 16).replace('T', ' ')}  ${(row.kind ?? '?').padEnd(6)}  ` +
        `${row.confidence.toFixed(2)} ${row.classification.padEnd(8)}  ${row.query}`,
    )
    .join('\n')}\n`;
}
