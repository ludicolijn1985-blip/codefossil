import type { RunIndexResult } from '@codefossil/core';
import type { FileSymbol, IndexStatus } from '@codefossil/db';

const SHORT_SHA_LENGTH = 7;

/** `plural(1, 'commit')` → "1 commit", `plural(2, 'commit')` → "2 commits". */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function rows(entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

export function formatStatus(status: IndexStatus): string {
  const { repository, counts, latestCommit } = status;
  const header = rows([
    [
      'Repository',
      repository.defaultBranch
        ? `${repository.name} (${repository.defaultBranch})`
        : repository.name,
    ],
    ['Path', repository.path],
    ['Remote', repository.remoteUrl ?? '—'],
    ['Indexed', repository.indexedAt ?? 'never — run `codefossil index`'],
    [
      'Latest commit',
      latestCommit
        ? `${latestCommit.sha.slice(0, SHORT_SHA_LENGTH)} ${latestCommit.committedAt}`
        : '—',
    ],
  ]);
  const body = rows([
    ['Commits', String(counts.commits)],
    ['Files', `${counts.files} (${counts.currentFiles} current)`],
    ['File changes', String(counts.fileChanges)],
    [
      'Symbols',
      `${counts.symbols} (${counts.currentSymbols} current, ${counts.symbolVersions} versions)`,
    ],
    ['Evidence', String(counts.evidence)],
    [
      'Relations',
      `${counts.relations.FACT} FACT · ${counts.relations.DERIVED} DERIVED · ${counts.relations.INFERRED} INFERRED`,
    ],
  ]);
  return `${header}\n\n${body}\n`;
}

export function formatIndexResult(result: RunIndexResult, seconds: string): string {
  const summary =
    `Indexed ${plural(result.commitsIndexed, 'new commit')} ` +
    `(${result.commitsSkipped} already indexed) and ` +
    `${plural(result.fileChanges, 'file change')}; ` +
    `parsed ${plural(result.symbols.versionsParsed, 'file version')} into ` +
    `${plural(result.symbols.symbolVersions, 'symbol version')} in ${seconds}s.\n`;
  const pruned =
    result.commitsPruned > 0
      ? `Removed ${plural(result.commitsPruned, 'commit')} that HEAD's history no longer contains.\n`
      : '';
  const lines = [
    pruned + summary + formatGraphSummary(result.dependencies) + formatCoverage(result.coverage),
  ];
  const failures = result.symbols.parseFailures;
  if (failures > 0) {
    lines.push(
      `Warning: ${plural(failures, 'file version')} could not be parsed; their symbols are missing.\n`,
    );
  }
  for (const error of result.dependencies.manifestErrors) {
    lines.push(`Warning: ${error}\n`);
  }
  for (const path of result.dependencies.parseFailures) {
    lines.push(`Warning: ${path} could not be parsed; it contributes no import edges.\n`);
  }
  return lines.join('');
}

function formatCoverage(coverage: RunIndexResult['coverage']): string {
  if (!coverage.report) return '';
  if (coverage.error) {
    return `Warning: coverage report ${coverage.report} could not be read (${coverage.error}).\n`;
  }
  if (coverage.unchanged) {
    return `Line coverage: ${coverage.report} unchanged (${plural(coverage.files, 'file')}).\n`;
  }
  const skipped =
    coverage.skipped > 0
      ? `; ${plural(coverage.skipped, 'entry', 'entries')} not in the repository`
      : '';
  return `Line coverage: read ${coverage.report} (${plural(coverage.files, 'file')}${skipped}).\n`;
}

function formatGraphSummary(graph: RunIndexResult['dependencies']): string {
  if (graph.mode === 'unchanged')
    return 'Dependency graph: HEAD unchanged since the last snapshot.\n';
  return (
    `Dependency graph (${graph.mode}): ${plural(graph.importEdges, 'file import edge')}, ` +
    `${plural(graph.dependencyEdges, 'package dependency edge')}, ` +
    `${plural(graph.dependencies, 'declared dependency', 'declared dependencies')}; ` +
    `${plural(graph.unresolvedImports, 'import')} left unresolved; ` +
    `${plural(graph.callEdges, 'call edge')} from ${plural(graph.calls, 'call site')}.\n`
  );
}

/** Indent nested symbols (methods under their class) by their qualification depth. */
function symbolLabel(symbol: FileSymbol): string {
  return `${'  '.repeat(symbol.qualifiedName.split('.').length - 1)}${symbol.name}`;
}

function symbolOrigin(symbol: FileSymbol): string {
  const origin = symbol.introducedBy;
  if (!origin) return 'origin not established by indexed history';
  return `introduced ${origin.sha.slice(0, SHORT_SHA_LENGTH)} ${origin.committedAt.slice(0, 10)} "${origin.subject}"`;
}

export function formatSymbols(
  path: string,
  deletedAt: string | null,
  symbols: readonly FileSymbol[],
): string {
  const deleted = deletedAt ? ` (deleted ${deletedAt})` : '';
  const header = `${path} — ${plural(symbols.length, 'symbol')}${deleted}`;
  if (symbols.length === 0) return `${header}\n`;

  const kindWidth = Math.max(...symbols.map((s) => s.kind.length));
  const nameWidth = Math.max(...symbols.map((s) => symbolLabel(s).length));
  const lines = symbols.map((symbol) =>
    [
      `  ${symbol.kind.padEnd(kindWidth)}`,
      symbolLabel(symbol).padEnd(nameWidth),
      `L${symbol.startLine}-${symbol.endLine}`.padEnd(9),
      plural(symbol.versions, 'version').padEnd(10),
      symbolOrigin(symbol),
    ].join('  '),
  );
  return `${header}\n\n${lines.join('\n')}\n`;
}
