import { createHash } from 'node:crypto';
import type { SymbolKind } from '@codefossil/shared';
import type { Node } from 'web-tree-sitter';
import { METHOD_OWNERS, nameField, type LanguageSpec } from './spec.js';

export interface ParsedSymbol {
  /** Identity within a file across versions, e.g. `method:Cart.total`. */
  readonly stableKey: string;
  readonly name: string;
  /** Dotted path of enclosing containers plus the name, e.g. `Cart.total`. */
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  /** Declaration head without the body, whitespace collapsed. */
  readonly signature: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** SHA-256 of the symbol's full source text; changes whenever the symbol does. */
  readonly contentHash: string;
}

interface Scope {
  readonly name: string;
  readonly kind: SymbolKind;
}

const MAX_SIGNATURE_LENGTH = 200;

interface Pending {
  readonly node: Node;
  readonly scope: readonly Scope[];
}

/** Children in reverse, so popping them from a stack visits them in source order. */
function pushChildren(stack: Pending[], node: Node, scope: readonly Scope[]): void {
  const children = node.namedChildren;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child) stack.push({ node: child, scope });
  }
}

/**
 * Walk a syntax tree and collect the definitions `spec` describes, in source
 * order. The walk is iterative: repository content is untrusted, and deeply
 * nested source must not be able to overflow the call stack.
 */
export function extractSymbols(root: Node, spec: LanguageSpec): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const seen = new Map<string, number>();
  const stack: Pending[] = [];
  pushChildren(stack, root, []);

  for (let item = stack.pop(); item; item = stack.pop()) {
    const { node, scope } = item;
    const rule = spec.definitions[node.type];
    if (!rule || (rule.accept && !rule.accept(node))) {
      if (!spec.opaque.has(node.type)) pushChildren(stack, node, scope);
      continue;
    }
    // Anonymous definitions (e.g. `export default class {}`) have no stable identity.
    const name = rule.name ? rule.name(node) : nameField(node);
    if (!name) continue;

    const owner = scope.at(-1);
    let kind = rule.kindOf ? rule.kindOf(node) : rule.kind;
    if (kind === 'function' && owner && METHOD_OWNERS.has(owner.kind)) kind = 'method';

    const qualifiedName = [...scope.map((s) => s.name), ...(rule.scope?.(node) ?? []), name].join(
      '.',
    );
    const baseKey = `${kind}:${qualifiedName}`;
    const occurrence = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, occurrence);

    symbols.push({
      stableKey: occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`,
      name,
      qualifiedName,
      kind,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      contentHash: createHash('sha256').update(node.text).digest('hex'),
    });

    if (rule.container) {
      pushChildren(stack, node.childForFieldName('body') ?? node, [...scope, { name, kind }]);
    }
  }
  return symbols;
}

/** The declaration without its body: `function total(items: Item[]): number`. */
function signatureOf(node: Node): string {
  const body =
    node.childForFieldName('body') ?? node.childForFieldName('value')?.childForFieldName('body');
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SIGNATURE_LENGTH
    ? `${collapsed.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`
    : collapsed;
}
