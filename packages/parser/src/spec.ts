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
}

export interface LanguageSpec {
  /** Syntax node types that are definitions. */
  readonly definitions: Readonly<Record<string, DefinitionRule>>;
  /**
   * Node types whose contents are local code (function bodies, closures).
   * Definitions inside them are not symbols of the file.
   */
  readonly opaque: ReadonlySet<string>;
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
