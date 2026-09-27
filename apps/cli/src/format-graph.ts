import type { DependencyUsage, ImportingFile, ImportRow } from '@codefossil/db';
import { plural } from './format.js';

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatDependencies(dependencies: readonly DependencyUsage[]): string {
  if (dependencies.length === 0) return 'No dependencies declared in any manifest at HEAD.\n';
  const rows = dependencies.map((d) => [
    `  ${d.ecosystem}`,
    d.name,
    d.version ?? '—',
    d.scope,
    d.manifestFile,
    d.internal
      ? 'workspace package — imports resolve to its source files'
      : d.usedBy === 0
        ? 'no importing files found'
        : `imported by ${plural(d.usedBy, 'file')}`,
  ]);
  return `${plural(dependencies.length, 'dependency', 'dependencies')}\n\n${table(rows)}\n`;
}

function importTarget(item: ImportRow): string {
  switch (item.resolution) {
    case 'files':
      return `→ ${item.resolutionDetail ?? ''}`;
    case 'dependency':
      return `→ ${item.resolutionDetail ?? ''} (declared dependency)`;
    case 'builtin':
      return '→ built-in';
    case 'unresolved':
      return `✗ unresolved: ${item.resolutionDetail ?? 'unknown reason'}`;
    case null:
      return '? not resolved yet — run `codefossil index`';
  }
}

export function formatFileDependencies(
  path: string,
  imports: readonly ImportRow[],
  importers: readonly ImportingFile[],
): string {
  const importLines =
    imports.length === 0
      ? '  (none)'
      : table(imports.map((item) => [`  L${item.line}`, item.specifier, importTarget(item)]));
  const importerLines =
    importers.length === 0
      ? '  (none)'
      : importers
          .map((importer) =>
            importer.confidence < 1
              ? `  ${importer.path}  (confidence ${importer.confidence})`
              : `  ${importer.path}`,
          )
          .join('\n');
  return (
    `${path}\n\n` +
    `Imports (${imports.length})\n${importLines}\n\n` +
    `Imported by (${importers.length})\n${importerLines}\n`
  );
}
