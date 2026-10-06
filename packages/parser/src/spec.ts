import type { SymbolKind } from '@codefossil/shared';
import type { Node } from 'web-tree-sitter';

/** A Tree-sitter grammar CODEFOSSIL can load. */
export type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust';

/** How to turn one kind of syntax node into a symbol. */
export interface DefinitionRule {
  readonly kind: SymbolKind;
  /** Descend into the definition and qualify nested definitions with its name. */
  readonly container?: boolean;
  /** The symbol name. Defaults to the `name` field; returning null skips the node. */
  readonly name?: (node: Node) => string | null;
  /** Refine the kind from the node's shape (e.g. a Go type spec that is a struct). */
  readonly kindOf?: (node: Node) => SymbolKind;
  /** Extra qualifier segments (e.g. a Go method's receiver type). */
  readonly scope?: (node: Node) => readonly string[];
  /** Accept only some occurrences (e.g. top-level variables). */
  readonly accept?: (node: Node) => boolean;
  /** A node to visit next at the same level, e.g. the rest of `a = b = function () {}`. */
  readonly next?: (node: Node) => Node | null;
}

/** How a file refers to another module. */
export type ImportKind = 'import' | 'reexport' | 'require' | 'dynamic' | 'from' | 'mod' | 'use';

/** A module reference as written in source, before resolution. */
export interface ImportReference {
  /** The module as written: `./vat.js`, `..models`, `github.com/x/y`, `crate::tax`. */
  readonly specifier: string;
  readonly kind: ImportKind;
  /** Names imported from the module, when the syntax lists them (Python `from x import a, b`). */
  readonly names?: readonly string[];
}

/** Turns one kind of syntax node into the module references it makes. */
export type ImportRule = (node: Node) => readonly ImportReference[];

export interface LanguageSpec {
  /** Syntax node types that are definitions. */
  readonly definitions: Readonly<Record<string, DefinitionRule>>;
  /** Syntax node types that reference other modules. Searched in the whole tree. */
  readonly imports: Readonly<Record<string, ImportRule>>;
  /**
   * Node types whose contents are local code (function bodies, closures).
   * Definitions inside them are not symbols of the file.
   */
  readonly opaque: ReadonlySet<string>;
  /** Call node types, each with the field that holds the callee. */
  readonly calls: Readonly<Record<string, string>>;
  /** Member access node types, each with its object and property fields (`a.b`). */
  readonly members: Readonly<Record<string, readonly [object: string, property: string]>>;
  /** Callees that are not calls into code (`require` in JavaScript is an import). */
  readonly ignoredCallees: ReadonlySet<string>;
}

/** Container kinds whose functions are methods. */
export const METHOD_OWNERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'struct',
  'trait',
  'impl',
]);

export const nameField = (node: Node): string | null =>
  node.childForFieldName('name')?.text ?? null;

/** The first descendant of one of `types`, depth first. */
export function firstDescendant(node: Node, types: ReadonlySet<string>): Node | null {
  for (const child of node.namedChildren) {
    if (types.has(child.type)) return child;
    const found = firstDescendant(child, types);
    if (found) return found;
  }
  return null;
}

/** The value of a plain string literal (`'x'`, `"x"`), or null for anything computed. */
export function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  const quoted = /^(['"`])(.*)\1$/s.exec(node.text);
  if (!quoted || (quoted[1] === '`' && quoted[2]?.includes('${'))) return null;
  return quoted[2] ?? null;
}
