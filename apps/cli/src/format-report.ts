import type { ChangedFileReport, FragileSymbol, RepositoryReport } from '@codefossil/analyzers';

/** Marks a CODEFOSSIL report so a later run can find and update its own pull-request comment. */
export const REPORT_MARKER = '<!-- codefossil-report -->';

const SHORT_SHA_LENGTH = 7;
const MAX_TEXT = 200;
const ZERO_WIDTH_SPACE = '\u200b';

/**
 * Repository text (paths, commit subjects, issue titles) is untrusted: it
 * must not break a table, inject HTML or links, or notify people. Newlines
 * become spaces, Markdown punctuation is escaped, and `@` is defused.
 */
export function mdText(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped
    .replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, (c) => `\\${c}`)
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
}

/** A path or name as inline code; backticks inside cannot close it early. */
export function mdCode(text: string): string {
  const inner = text
    .replace(/[`\r\n]/g, ' ')
    // GFM splits table cells on `|` even inside code spans unless it is escaped.
    .replace(/\|/g, '\\|')
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
  return `\`${inner}\``;
}

const score = (value: number) => value.toFixed(2);
const plural = (n: number, noun: string, many = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : many}`;

function changedRow(file: ChangedFileReport): string {
  if (file.status !== 'changed') {
    const why = {
      deleted: 'deleted',
      unindexed: 'not in the index',
      generated: 'generated or lockfile',
    }[file.status];
    return `| ${mdCode(file.path)} | ${why} | | | | |`;
  }
  const history = file.history
    ? `#${String(file.history.rank)} · ${plural(file.history.commits, 'commit')}, ${plural(file.history.defectCount, 'defect')}`
    : 'new';
  const impact = file.impact
    ? `${String(file.impact.direct)} direct, ${String(file.impact.transitive)} transitive${file.impact.truncated ? ' (partial)' : ''}`
    : '';
  const examples = file.impact?.examples.length
    ? ` e.g. ${file.impact.examples.map(mdCode).join(', ')}`
    : '';
  return [
    mdCode(file.path),
    history,
    file.history ? score(file.history.score) : '',
    file.history ? score(file.history.riskScore) : '',
    `${impact}${examples}`,
    file.impact ? String(file.impact.tests) : '',
  ]
    .map((cell) => ` ${cell} `)
    .join('|')
    .replace(/^/, '|')
    .replace(/$/, '|');
}

const FIXES_SHOWN = 3;

/** `#123` with the `#` escaped: no link, so old issues get no cross-reference from every PR. */
const issueRef = (d: FragileSymbol['fixes'][number]['discussions'][number]) =>
  mdText(`#${d.number}`);

function fragileLines(item: FragileSymbol, changed: readonly ChangedFileReport[]): string[] {
  const { symbol, fixes } = item;
  const impact = changed.find((file) => file.path === symbol.path)?.impact;
  const dependents = impact ? impact.direct + impact.transitive : 0;
  const head =
    `- ${mdCode(symbol.qualifiedName)} (${mdText(symbol.kind)}) in ${mdCode(`${symbol.path}:${String(symbol.startLine)}`)}: ` +
    `**${plural(fixes.length, 'earlier fix', 'earlier fixes')}** among ${plural(item.priorChanges, 'earlier change')} (${item.level})` +
    (dependents > 0 ? ` · ${plural(dependents, 'file')} depend on its file` : '');
  const shown = fixes.slice(0, FIXES_SHOWN).map((fix) => {
    const refs = fix.discussions.length ? ` · ${fix.discussions.map(issueRef).join(', ')}` : '';
    return `  - ${mdCode(fix.sha.slice(0, SHORT_SHA_LENGTH))} ${mdText(fix.subject, 100)} · ${fix.committedAt.slice(0, 10)}${refs}`;
  });
  const more =
    fixes.length > FIXES_SHOWN ? [`  - and ${String(fixes.length - FIXES_SHOWN)} more`] : [];
  return [head, ...shown, ...more];
}

function fragileSection(report: RepositoryReport): string[] {
  const fragile = report.fragile;
  if (!fragile) return [];
  if (fragile.symbols.length === 0) {
    return [
      `No changed function or class has earlier fixes in its history (${plural(fragile.symbolsTouched, 'symbol')} touched).`,
      '',
    ];
  }
  const hidden = fragile.total - fragile.symbols.length;
  return [
    '### ⚠️ Changed code that broke before',
    '',
    `This change touches ${plural(fragile.total, 'function or class', 'functions or classes')} that earlier fixes touched too. ` +
      'Fix commits are recognised from issue labels, reverts and commit wording, so most are inferences.',
    '',
    ...fragile.symbols.flatMap((item) => fragileLines(item, report.changed ?? [])),
    ...(hidden > 0 ? [`- and ${plural(hidden, 'more symbol')}`] : []),
    '',
  ];
}

export function formatReportMarkdown(report: RepositoryReport): string {
  const { counts, repository } = report;
  const head = repository.headSha
    ? ` at ${mdCode(repository.headSha.slice(0, SHORT_SHA_LENGTH))}`
    : '';
  const lines: string[] = [
    REPORT_MARKER,
    '## CODEFOSSIL report',
    '',
    `${mdCode(repository.name)}${head} · ${plural(counts.commits, 'commit')} · ${plural(counts.files, 'file')} · ` +
      `${plural(counts.symbols, 'symbol')} · relations ${String(counts.relations.FACT)} FACT / ` +
      `${String(counts.relations.DERIVED)} DERIVED / ${String(counts.relations.INFERRED)} INFERRED`,
    '',
  ];

  if (report.indexWarning) lines.push(`> **Warning:** ${report.indexWarning}`, '');

  lines.push(...fragileSection(report));

  if (report.changed) {
    lines.push(
      `### Files changed since ${mdCode(report.base ?? 'base')} (${String(report.changedTotal)})`,
      '',
    );
    if (report.changed.length === 0) {
      lines.push('No files changed.', '');
    } else {
      lines.push(
        '| File | History | Hotspot | Risk | Depended on by | Tests reaching |',
        '| --- | --- | ---: | ---: | --- | ---: |',
        ...report.changed.map(changedRow),
      );
      const hidden = report.changedTotal - report.changed.length;
      if (hidden > 0) lines.push('', `_${plural(hidden, 'more changed file')} not shown._`);
      lines.push('');
    }
  }

  // On a pull request the repository-wide sections are folded away; the change comes first.
  const folded = report.changed !== null;
  if (folded) {
    lines.push(
      '<details>',
      '<summary>Repository hotspots and dead-intent candidates</summary>',
      '',
    );
  }
  lines.push(`### Historical hotspots (of ${plural(report.filesRanked, 'file')} with history)`, '');
  if (report.hotspots.length === 0) {
    lines.push('No file has recorded changes.', '');
  } else {
    lines.push(
      '| # | File | Commits | Churn | Defect commits | Hotspot | Risk |',
      '| ---: | --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.hotspots.map(
        (h, i) =>
          `| ${String(i + 1)} | ${mdCode(h.file.path)} | ${String(h.commits)} | ${String(h.churn)} | ` +
          `${String(h.defectCount)} | ${score(h.score)} | ${score(h.risk.score)} |`,
      ),
      '',
    );
  }

  lines.push('### Dead-intent candidates (INFERRED)', '');
  if (report.deadIntent.length === 0) {
    lines.push(
      'None: no workaround or compatibility wording can be tied to code that is still present and has not been reworked since.',
      '',
    );
  } else {
    for (const candidate of report.deadIntent) {
      const [first] = candidate.signals;
      lines.push(
        `- ${mdCode(candidate.target.label)} · confidence ${score(candidate.confidence)}` +
          (first ? ` · ${mdText(first.text)}` : ''),
      );
    }
    lines.push('');
  }

  if (folded) lines.push('</details>', '');

  lines.push(
    "<sub>Computed by CODEFOSSIL from this repository's own history on the runner. FACT = observed, " +
      'DERIVED = computed from facts, INFERRED = a heuristic reading; defect commits and dead intent are inferences. ' +
      'Test reach is import reach, not line coverage.</sub>',
    '',
  );
  return lines.join('\n');
}
