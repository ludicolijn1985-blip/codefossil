import type { ImportReference } from '@codefossil/parser';
import { dirOf, joinPath, unresolved, type LayoutIndex, type Resolution } from './layout.js';

/** Confidence when a file was found by path suffix: its source root was inferred. */
const INFERRED_ROOT_CONFIDENCE = 0.9;

/** Files by every path suffix (`C.java`, `b/C.java`, `a/b/C.java`), for languages whose imports name paths from a source root. */
export class SuffixIndex {
  private readonly bySuffix = new Map<string, string[]>();
  private readonly dirs = new Map<string, string[]>();

  constructor(files: Iterable<string>, extension: string) {
    for (const file of files) {
      if (!file.endsWith(extension)) continue;
      const parts = file.split('/');
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('/');
        this.bySuffix.set(key, [...(this.bySuffix.get(key) ?? []), file]);
      }
      const dir = dirOf(file);
      this.dirs.set(dir, [...(this.dirs.get(dir) ?? []), file]);
    }
  }

  /** The files whose path ends with `suffix` at a directory boundary. */
  matching(suffix: string): readonly string[] {
    return this.bySuffix.get(suffix) ?? [];
  }

  /** Directories whose path ends with `suffix`, with their files. */
  directories(suffix: string): [string, readonly string[]][] {
    return [...this.dirs].filter(([dir]) => dir === suffix || dir.endsWith(`/${suffix}`));
  }
}

const JAVA_PLATFORM = /^(java|javax|jdk|sun|com\.sun|org\.w3c|org\.xml)\./;

/**
 * Java: `a.b.C` is the class in `…/a/b/C.java`, `a.b.*` the package directory
 * `…/a/b`. The source root is not declared, so a single match by path suffix
 * is accepted at reduced confidence; several matches resolve to nothing.
 */
export function resolveJava(sources: SuffixIndex, ref: ImportReference): Resolution {
  const spec = ref.specifier;
  if (JAVA_PLATFORM.test(spec)) return { kind: 'builtin' };
  if (spec.endsWith('.*')) {
    const dirs = sources.directories(spec.slice(0, -2).replaceAll('.', '/'));
    const [only] = dirs;
    if (dirs.length === 1 && only) {
      return {
        kind: 'files',
        paths: [...only[1]],
        confidence: INFERRED_ROOT_CONFIDENCE,
        method: 'java-package',
      };
    }
    return unresolved(
      dirs.length > 1
        ? `package ${spec} matches several directories`
        : `no package directory for ${spec}`,
    );
  }
  const parts = spec.split('.');
  // `a.b.C.Inner` is declared in `a/b/C.java`.
  for (const size of [parts.length, parts.length - 1]) {
    if (size < 1) continue;
    const files = sources.matching(`${parts.slice(0, size).join('/')}.java`);
    const [file] = files;
    if (files.length === 1 && file) {
      return {
        kind: 'files',
        paths: [file],
        confidence: INFERRED_ROOT_CONFIDENCE,
        method: 'java-class-path',
      };
    }
    if (files.length > 1) return unresolved(`class ${spec} matches several files`);
  }
  return unresolved(`class ${spec} is not in this repository`);
}

/** C#: a `using` names a namespace, which may span any number of files in any directories. */
export function resolveCsharp(ref: ImportReference): Resolution {
  return /^(System|Microsoft)(\.|$)/.test(ref.specifier)
    ? { kind: 'builtin' }
    : unresolved('C# namespaces are not tied to files');
}

/** Ruby's standard library and default gems, required without a Gemfile entry. */
const RUBY_STDLIB = new Set([
  'abbrev',
  'base64',
  'benchmark',
  'bigdecimal',
  'cgi',
  'csv',
  'date',
  'delegate',
  'digest',
  'English',
  'erb',
  'etc',
  'fileutils',
  'find',
  'forwardable',
  'io/console',
  'ipaddr',
  'json',
  'logger',
  'monitor',
  'net/http',
  'objspace',
  'observer',
  'open-uri',
  'open3',
  'openssl',
  'optparse',
  'ostruct',
  'pathname',
  'pp',
  'prettyprint',
  'pstore',
  'psych',
  'rbconfig',
  'securerandom',
  'set',
  'shellwords',
  'singleton',
  'socket',
  'stringio',
  'strscan',
  'tempfile',
  'time',
  'timeout',
  'tmpdir',
  'tsort',
  'uri',
  'weakref',
  'yaml',
  'zlib',
]);

/**
 * Ruby: `require_relative` paths (written `./x`) resolve against the
 * requiring file; `require 'x'` is the standard library or a file `x.rb` on
 * the load path, found by a unique path suffix (preferring `lib/`).
 */
export function resolveRuby(
  index: LayoutIndex,
  sources: SuffixIndex,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  const spec = ref.specifier.replace(/\.rb$/, '');
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const file = index.firstExisting([joinPath(dirOf(fromPath), `${spec}.rb`)]);
    return file
      ? { kind: 'files', paths: [file], confidence: 1, method: 'ruby-require-relative' }
      : unresolved('no file matches the relative require');
  }
  if (RUBY_STDLIB.has(spec)) return { kind: 'builtin' };
  const candidates = sources.matching(`${spec}.rb`);
  const inLib = candidates.filter(
    (file) => file === `lib/${spec}.rb` || file.endsWith(`/lib/${spec}.rb`),
  );
  const [file] = inLib.length === 1 ? inLib : candidates;
  if (file && (inLib.length === 1 || candidates.length === 1)) {
    return {
      kind: 'files',
      paths: [file],
      confidence: INFERRED_ROOT_CONFIDENCE,
      method: 'ruby-load-path',
    };
  }
  return unresolved(
    candidates.length > 1
      ? `${spec}.rb matches several files`
      : `${spec} is not a file in this repository (a gem?)`,
  );
}

/**
 * PHP: `require` paths resolve against the requiring file; `use A\B\C` is the
 * class file `…/B/C.php` the autoloader would load (PSR-4), found by the
 * longest path suffix that matches a single file.
 */
export function resolvePhp(
  index: LayoutIndex,
  sources: SuffixIndex,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  if (ref.kind === 'require') {
    const spec = ref.specifier;
    const file = index.firstExisting([
      joinPath(dirOf(fromPath), spec),
      ...(spec.startsWith('.') ? [] : [joinPath('', spec)]),
    ]);
    return file
      ? { kind: 'files', paths: [file], confidence: 1, method: 'php-require' }
      : unresolved('no file matches the required path');
  }
  const parts = ref.specifier.replace(/^\\/, '').split('\\');
  for (let start = 0; start < parts.length; start++) {
    const files = sources.matching(`${parts.slice(start).join('/')}.php`);
    const [file] = files;
    if (files.length === 1 && file) {
      return {
        kind: 'files',
        paths: [file],
        confidence: INFERRED_ROOT_CONFIDENCE,
        method: 'php-class-path',
      };
    }
    if (files.length > 1) return unresolved(`class ${ref.specifier} matches several files`);
  }
  return unresolved(`class ${ref.specifier} is not in this repository`);
}
