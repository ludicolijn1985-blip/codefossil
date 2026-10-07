import type {
  DeadIntentReport,
  FixedSymbolsReport,
  FossilReport,
  HotspotReport,
} from '@codefossil/analyzers';
import { plural } from './format.js';

const SHORT_SHA_LENGTH = 7;
/** Defect commits shown per file in text output; JSON carries more. */
const DEFECTS_LISTED = 3;
const score = (value: number) => value.toFixed(2);

export function formatHotspots(report: HotspotReport): string {
  const scope = report.since ? ` since ${report.since.slice(0, 10)}` : '';
  const header =
    `Historical hotspots${scope}, ordered by ${report.orderBy === 'risk' ? 'risk' : 'hotspot score'} ` +
    `(${plural(report.filesConsidered, 'file')} with changes).\n`;
  if (report.hotspots.length === 0)
    return `${header}\nNo file has recorded changes in this window.\n`;
  const blocks = report.hotspots.map((h, index) => {
    const c = h.components;
    const r = h.risk.components;
    const defects = h.defects
      .slice(0, DEFECTS_LISTED)
      .map(
        (d) =>
          `      ${d.sha.slice(0, SHORT_SHA_LENGTH)} ${d.subject}  — ${d.reason} (${d.level} ${score(d.confidence)})`,
      );
    return [
      `${String(index + 1).padStart(3)}. ${h.file.path}${h.isTest ? ' [test]' : ''}`,
      `     hotspot ${score(h.score)} = change ${score(c.changeFrequency)} × churn ${score(c.churn)} × defects ${score(c.defects)}` +
        `   (${plural(h.commits, 'commit')}, ${h.churn} lines, ${plural(h.defectCount, 'defect commit')})`,
      `     risk    ${score(h.risk.score)} = change ${score(r.changeFrequency)} × centrality ${score(r.dependencyCentrality)} × bug density ${score(r.bugDensity)} × untested ${score(r.testReachInverse)}` +
        `   (${plural(h.risk.dependents, 'dependent')}, ${plural(h.risk.testsReaching, 'test')} reaching it)`,
      `     ${h.classification}`,
      ...defects,
      ...(h.defectCount > DEFECTS_LISTED
        ? [`      … ${String(h.defectCount - DEFECTS_LISTED)} more (--json lists up to 10)`]
        : []),
    ].join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n\nNotes\n${report.notes.map((n) => `  - ${n}`).join('\n')}\n`;
}

export function formatDeadIntent(report: DeadIntentReport): string {
  const runtimes =
    report.runtimes.length > 0
      ? `Declared runtime support: ${report.runtimes.map((r) => `${r.runtime} ${r.constraint} (${r.manifest})`).join(', ')}\n`
      : '';
  if (report.candidates.length === 0) {
    return `${runtimes}No dead-intent candidates: no workaround or compatibility wording can be tied to code that is still present and has not been reworked since.\n`;
  }
  const blocks = report.candidates.map((candidate, index) =>
    [
      `${String(index + 1).padStart(3)}. ${candidate.target.label}   INFERRED ${score(candidate.confidence)}`,
      ...candidate.commits.map(
        (c) =>
          `     changed by ${c.sha.slice(0, SHORT_SHA_LENGTH)} ${c.subject} (${c.committedAt.slice(0, 10)})`,
      ),
      ...candidate.signals.map((s) => `     - ${s.text}`),
    ].join('\n'),
  );
  return (
    `Dead-intent candidates (${plural(report.candidates.length, 'candidate')}): code that may exist only for a reason that has since gone away.\n` +
    runtimes +
    `\n${blocks.join('\n\n')}\n\nNotes\n${report.notes.map((n) => `  - ${n}`).join('\n')}\n`
  );
}

const day = (iso: string) => iso.slice(0, 10);

/** "renamed from parse", "moved here from lib/a.js", "copied here from lib/a.js". */
function lineagePhrase(copied: { kind: string; fromPath: string; fromName: string }): string {
  if (copied.kind === 'renamed') return `renamed from ${copied.fromName}`;
  const how = copied.kind === 'moved' ? 'moved here, with edits,' : 'copied here';
  return `${how} from ${copied.fromPath}`;
}

export function formatFossils(report: FossilReport): string {
  const ordering =
    report.order === 'introduced'
      ? 'The oldest code still here, oldest introduction first'
      : 'The code that has gone longest without a change, longest first';
  const header =
    `${ordering} (${plural(report.withOrigin, 'symbol')} with an established origin, ` +
    `${String(report.unchanged)} unchanged since).\n` +
    (report.withoutOrigin > 0
      ? `${plural(report.withoutOrigin, 'symbol')} older than the indexed history ${report.withoutOrigin === 1 ? 'is' : 'are'} not dated.\n`
      : '');
  if (report.fossils.length === 0)
    return `${header}\nNo current symbol has an established origin.\n`;
  const blocks = report.fossils.map((fossil, index) => {
    const { symbol, introduced, lastChange } = fossil;
    const born = introduced;
    return [
      `${String(index + 1).padStart(3)}. ${symbol.kind} ${symbol.qualifiedName}  ${symbol.path}:${String(symbol.startLine)}`,
      `     introduced ${day(born.committedAt)} in ${born.sha.slice(0, SHORT_SHA_LENGTH)} "${born.subject}" by ${born.authorName} · ${born.level} ${score(born.confidence)}`,
      ...(fossil.copied
        ? [
            `     ${lineagePhrase(fossil.copied)}${fossil.copied.commit ? ` on ${day(fossil.copied.commit.committedAt)} in ${fossil.copied.commit.sha.slice(0, SHORT_SHA_LENGTH)} "${fossil.copied.commit.subject}"` : ''}`,
          ]
        : []),
      lastChange
        ? `     changed ${plural(fossil.changesSince, 'time')} since, last on ${day(lastChange.committedAt)} in ${lastChange.sha.slice(0, SHORT_SHA_LENGTH)} "${lastChange.subject}"`
        : `     unchanged since${fossil.copied ? ` it was ${fossil.copied.kind} here` : ''}`,
    ].join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}

export function formatFixedSymbols(report: FixedSymbolsReport): string {
  const header =
    `Functions, methods and classes fixed most often (${plural(report.total, 'symbol')} with fix commits, ` +
    `of ${String(report.considered)} considered). Fix commits are recognised from issue labels, reverts ` +
    'and commit wording, so most are inferences.\n';
  if (report.symbols.length === 0) return `${header}\nNo current symbol has a recorded fix.\n`;
  const blocks = report.symbols.map((item, index) => {
    const { symbol, fixes } = item;
    return [
      `${String(index + 1).padStart(3)}. ${symbol.kind} ${symbol.qualifiedName}  ${symbol.path}:${String(symbol.startLine)}`,
      `     ${plural(fixes.length, 'fix', 'fixes')} among ${plural(item.priorChanges, 'change')} · ${item.level}`,
      ...fixes
        .slice(0, DEFECTS_LISTED)
        .map(
          (fix) =>
            `      ${fix.sha.slice(0, SHORT_SHA_LENGTH)} ${day(fix.committedAt)} ${fix.subject}  — ${fix.reason}`,
        ),
      ...(fixes.length > DEFECTS_LISTED
        ? [`      … ${String(fixes.length - DEFECTS_LISTED)} more (--json lists them all)`]
        : []),
    ].join('\n');
  });
  return `${header}\n${blocks.join('\n\n')}\n`;
}
