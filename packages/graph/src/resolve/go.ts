import type { ImportReference } from '@codefossil/parser';
import { dirOf, joinPath, unresolved, type LayoutIndex, type Resolution } from './layout.js';

/** Non-test Go files per directory. */
export class GoPackages {
  private readonly byDir = new Map<string, string[]>();

  constructor(files: Iterable<string>) {
    for (const file of files) {
      if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
      const dir = dirOf(file);
      this.byDir.set(dir, [...(this.byDir.get(dir) ?? []), file]);
    }
  }

  filesIn(dir: string): readonly string[] {
    return this.byDir.get(dir) ?? [];
  }
}

export function resolveGo(
  index: LayoutIndex,
  packages: GoPackages,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  const spec = ref.specifier;
  for (const manifest of index.manifestsAbove(fromPath, 'go')) {
    const module = manifest.packageName;
    if (!module || (spec !== module && !spec.startsWith(`${module}/`))) continue;
    const dir = joinPath(dirOf(manifest.path), spec.slice(module.length).replace(/^\//, ''));
    const files = dir === null ? [] : packages.filesIn(dir);
    return files.length > 0
      ? { kind: 'files', paths: files, confidence: 1, method: 'go-module-package' }
      : unresolved(`no Go files in package directory for ${spec}`);
  }

  // A module replaced by a directory of this repository resolves to that directory's package.
  for (const manifest of index.manifestsAbove(fromPath, 'go')) {
    const replacement = (manifest.replacements ?? [])
      .filter((r) => r.local && (spec === r.module || spec.startsWith(`${r.module}/`)))
      .sort((a, b) => b.module.length - a.module.length)[0];
    if (!replacement) continue;
    const moduleDir = joinPath(dirOf(manifest.path), replacement.target);
    if (moduleDir === null) {
      return unresolved(`${replacement.module} is replaced by a directory outside the repository`);
    }
    const dir = joinPath(moduleDir, spec.slice(replacement.module.length).replace(/^\//, ''));
    const files = dir === null ? [] : packages.filesIn(dir);
    return files.length > 0
      ? { kind: 'files', paths: files, confidence: 1, method: `go-replace:${manifest.path}` }
      : unresolved(`no Go files for ${spec} in the replacement directory ${replacement.target}`);
  }

  // Standard library paths have no dot in their first element (`fmt`, `net/http`).
  if (!(spec.split('/')[0] ?? '').includes('.')) return { kind: 'builtin' };

  for (const manifest of index.manifestsAbove(fromPath, 'go')) {
    // The longest required module path that prefixes the import.
    const dependency = manifest.dependencies
      .filter((dep) => spec === dep.name || spec.startsWith(`${dep.name}/`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (dependency) {
      return {
        kind: 'dependency',
        ecosystem: 'go',
        name: dependency.name,
        manifestPath: manifest.path,
        method: 'required-module',
      };
    }
  }
  return unresolved(`module for ${spec} is not required in go.mod`);
}
