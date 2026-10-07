import type { GrammarId, ImportReference } from '@codefossil/parser';
import { resolveEcmascript } from './ecmascript.js';
import { GoPackages, resolveGo } from './go.js';
import {
  resolveCsharp,
  resolveJava,
  resolvePhp,
  resolveRuby,
  SuffixIndex,
} from './jvm-and-scripts.js';
import { LayoutIndex, type RepositoryLayout, type Resolution } from './layout.js';
import { PythonModules, resolvePython } from './python.js';
import { resolveRust } from './rust.js';
import { TsConfigIndex } from './tsconfig-paths.js';

export type ImportResolver = (
  fromPath: string,
  grammar: GrammarId,
  ref: ImportReference,
) => Resolution;

/**
 * Build a resolver for one snapshot of a repository. Resolution is
 * deterministic: the same files and manifests always give the same result,
 * and anything that cannot be decided from them is reported as unresolved
 * instead of guessed.
 */
export function createResolver(layout: RepositoryLayout): ImportResolver {
  const index = new LayoutIndex(layout);
  let python: PythonModules | undefined;
  let go: GoPackages | undefined;
  let tsconfigs: TsConfigIndex | undefined;
  const suffixes = new Map<string, SuffixIndex>();
  const sourcesOf = (extension: string) => {
    let found = suffixes.get(extension);
    if (!found) {
      found = new SuffixIndex(layout.files, extension);
      suffixes.set(extension, found);
    }
    return found;
  };
  return (fromPath, grammar, ref) => {
    switch (grammar) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        tsconfigs ??= new TsConfigIndex(layout.files, layout.tsconfigs ?? []);
        return resolveEcmascript(index, tsconfigs, fromPath, ref);
      case 'python':
        python ??= new PythonModules(layout.files);
        return resolvePython(index, python, fromPath, ref, layout.pythonImports);
      case 'go':
        go ??= new GoPackages(layout.files);
        return resolveGo(index, go, fromPath, ref);
      case 'rust':
        return resolveRust(index, fromPath, ref);
      case 'java':
        return resolveJava(sourcesOf('.java'), ref);
      case 'csharp':
        return resolveCsharp(ref);
      case 'ruby':
        return resolveRuby(index, sourcesOf('.rb'), fromPath, ref);
      case 'php':
        return resolvePhp(index, sourcesOf('.php'), fromPath, ref);
    }
  };
}

export type { RepositoryLayout, Resolution } from './layout.js';
export { matchPaths, type PathMatch } from './tsconfig-paths.js';
