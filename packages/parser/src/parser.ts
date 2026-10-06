import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import { extractCalls, type ParsedCall } from './calls.js';
import {
  extractImports,
  extractSymbols,
  type ParsedImport,
  type ParsedSymbol,
  type SymbolRange,
} from './extract.js';
import { ecmascript } from './languages/ecmascript.js';
import { go } from './languages/go.js';
import { python } from './languages/python.js';
import { rust } from './languages/rust.js';
import type { GrammarId, LanguageSpec } from './spec.js';

const require = createRequire(import.meta.url);

/**
 * Where a grammar's WebAssembly file is. The published package ships the
 * files in `grammars/` beside its bundle (so installing it compiles nothing);
 * in the workspace they come from the tree-sitter grammar packages.
 */
function grammarFile(moduleFile: string): string {
  const bundled = fileURLToPath(new URL(`../grammars/${basename(moduleFile)}`, import.meta.url));
  return existsSync(bundled) ? bundled : require.resolve(moduleFile);
}

const GRAMMARS: Readonly<
  Record<GrammarId, { readonly wasm: string; readonly spec: LanguageSpec }>
> = {
  typescript: { wasm: 'tree-sitter-typescript/tree-sitter-typescript.wasm', spec: ecmascript },
  tsx: { wasm: 'tree-sitter-typescript/tree-sitter-tsx.wasm', spec: ecmascript },
  javascript: { wasm: 'tree-sitter-javascript/tree-sitter-javascript.wasm', spec: ecmascript },
  python: { wasm: 'tree-sitter-python/tree-sitter-python.wasm', spec: python },
  go: { wasm: 'tree-sitter-go/tree-sitter-go.wasm', spec: go },
  rust: { wasm: 'tree-sitter-rust/tree-sitter-rust.wasm', spec: rust },
};

const EXTENSION_GRAMMARS: Readonly<Record<string, GrammarId>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
};

/** The grammar that parses `path`, or null when symbols cannot be extracted from it. */
export function grammarForPath(path: string): GrammarId | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSION_GRAMMARS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Larger sources are almost always generated or minified bundles; parsing them
 * costs a lot and yields no meaningful symbols.
 */
export const MAX_SOURCE_LENGTH = 1_000_000;

export interface ExtractResult {
  readonly symbols: readonly ParsedSymbol[];
  /** Module references in source order, unresolved. */
  readonly imports: readonly ParsedImport[];
  /** Distinct calls per calling symbol, unresolved. */
  readonly calls: readonly ParsedCall[];
  /** True when Tree-sitter had to recover from syntax errors; symbols may be incomplete. */
  readonly hasSyntaxErrors: boolean;
}

let runtime: Promise<void> | undefined;

/**
 * Extracts symbols from source text. Grammars are WebAssembly modules loaded
 * on first use, so no native compilation is needed on any platform.
 * Call {@link dispose} when done to release WebAssembly memory.
 */
export class SymbolExtractor {
  private readonly parsers = new Map<GrammarId, Promise<Parser>>();

  async extract(source: string, grammar: GrammarId): Promise<ExtractResult | null> {
    if (source.length > MAX_SOURCE_LENGTH) return null;
    const parser = await this.parserFor(grammar);
    const tree = parser.parse(source);
    if (!tree) throw new Error(`Tree-sitter returned no tree for ${grammar} source`);
    try {
      const { spec } = GRAMMARS[grammar];
      const ranges = new Map<string, SymbolRange>();
      const symbols = extractSymbols(tree.rootNode, spec, ranges);
      return {
        symbols,
        imports: extractImports(tree.rootNode, spec),
        calls: extractCalls(tree.rootNode, spec, ranges),
        hasSyntaxErrors: tree.rootNode.hasError,
      };
    } finally {
      tree.delete();
    }
  }

  async dispose(): Promise<void> {
    const parsers = await Promise.all(this.parsers.values());
    for (const parser of parsers) parser.delete();
    this.parsers.clear();
  }

  private parserFor(grammar: GrammarId): Promise<Parser> {
    let parser = this.parsers.get(grammar);
    if (!parser) {
      parser = (async () => {
        runtime ??= Parser.init();
        await runtime;
        const language = await Language.load(grammarFile(GRAMMARS[grammar].wasm));
        const instance = new Parser();
        instance.setLanguage(language);
        return instance;
      })();
      this.parsers.set(grammar, parser);
    }
    return parser;
  }
}
