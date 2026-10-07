import type { SymbolKind } from '@codefossil/shared';
import type { Node } from 'web-tree-sitter';

/** A Tree-sitter grammar CODEFOSSIL can load. */
export type GrammarId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'php';

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
  /** The local names the import binds, when the syntax shows them. */
  readonly bindings?: readonly ImportBinding[];
}

/**
 * A local name an import introduces: `import { a as b }` binds `b` to `a`;
 * `import * as u`, `const u = require(…)`, Python `import u` and a Go package
 * bind `u` to the whole module (`*`); `import d from …` binds `d` to `default`.
 */
export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
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
  /**
   * Bodies whose contents count as module level although they sit in a
   * function: the wrapper of an IIFE or UMD module. Empty for other nodes.
   */
  readonly moduleWrappers?: (node: Node) => readonly Node[];
  /**
   * Call node types, each with the field that holds the callee, or a pair of
   * fields `[object, name]` when the grammar splits it (`a.b()` in Java or Ruby).
   */
  readonly calls: Readonly<Record<string, string | readonly [object: string, name: string]>>;
  /** Member access node types, each with its object and property fields (`a.b`). */
  readonly members: Readonly<Record<string, readonly [object: string, property: string]>>;
  /** Callees that are not calls into code (`require` in JavaScript is an import). */
  readonly ignoredCallees: ReadonlySet<string>;
  /**
   * Nodes that declare local names, each with the field holding the names
   * (null: the whole node). Every `identifier` in it counts as declared.
   */
  readonly locals: Readonly<Record<string, string | null>>;
  /**
   * Whether `receiver` at the start of the call names the object the
   * enclosing method belongs to: `this` outside nested functions, `self`,
   * a Go method's receiver.
   */
  readonly isSelf: (call: Node, receiver: string) => boolean;
  /**
   * Nodes that state the type of a name: a local (`const r = new Rates()`,
   * `repo: Repo`) or a field of the enclosing class (`this.log = new Logger()`).
   * A call through such a name (`r.vat()`) is then read as a call on the type
   * (`Rates.vat`).
   */
  readonly typedNames?: Readonly<Record<string, (node: Node) => readonly TypedName[]>>;
  /**
   * The field of a call node holding its arguments. A function passed there by
   * name (`items.map(format)`) is a use of it, recorded as a reference.
   */
  readonly callArguments?: string;
}

/** A name whose type the source states. */
export interface TypedName {
  readonly name: string;
  /** A field of the enclosing class (`this.repo`, `self.repo`) rather than a local. */
  readonly field: boolean;
  /** The type as a name path: `Repo`, `models.Repo`. */
  readonly type: readonly string[];
}

/** Node types naming a type or a constructor, in the supported grammars. */
const TYPE_NAMES: ReadonlySet<string> = new Set(['identifier', 'type_identifier']);

/**
 * A type as a name path: `Repo`, `m.Money` (`nested_type_identifier`, a member
 * or attribute), the name of a generic (`Tax<number>`). Null for anything else.
 */
export function typePath(node: Node | null, depth = 0): string[] | null {
  if (!node || depth > 4) return null;
  if (TYPE_NAMES.has(node.type)) return [node.text];
  if (node.type === 'generic_type') return typePath(node.childForFieldName('name'), depth + 1);
  const [objectField, nameField] =
    node.type === 'nested_type_identifier'
      ? ['module', 'name']
      : node.type === 'member_expression'
        ? ['object', 'property']
        : node.type === 'attribute'
          ? ['object', 'attribute']
          : [null, null];
  if (!objectField || !nameField) return null;
  const head = typePath(node.childForFieldName(objectField), depth + 1);
  const name = node.childForFieldName(nameField);
  return head && name ? [...head, name.text] : null;
}

/**
 * Visit every node of the given types under `root`, in source order. A tree
 * cursor walks without recursion and only materialises the nodes visited,
 * which matters for large or deeply nested (possibly hostile) input.
 */
export function visitNodes(
  root: Node,
  types: ReadonlySet<string>,
  visit: (node: Node) => void,
): void {
  const cursor = root.walk();
  try {
    for (;;) {
      if (types.has(cursor.nodeType)) visit(cursor.currentNode);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

/** The nearest ancestor of one of the given types. */
export function ancestorOf(node: Node, types: ReadonlySet<string>): Node | null {
  let current = node.parent;
  while (current && !types.has(current.type)) current = current.parent;
  return current;
}

/** Container kinds whose functions are methods. */
export const METHOD_OWNERS: ReadonlySet<SymbolKind> = new Set([
  'class',
  'interface',
  'struct',
  'trait',
  'impl',
  // Java enums and PHP enums have methods of their own.
  'enum',
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
