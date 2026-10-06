import type { Node } from 'web-tree-sitter';
import type { ParsedSymbol } from './extract.js';
import type { LanguageSpec } from './spec.js';

/** A call as written in source, before resolution. */
export interface ParsedCall {
  /**
   * The callee as a name path: `foo()` is `['foo']`, `utils.flatten()` is
   * `['utils', 'flatten']`. A segment that is not a plain name (a call
   * result, an index) is `*`: `getApp().listen()` is `['*', 'listen']`.
   */
  readonly callee: readonly string[];
  /** `stableKey` of the innermost symbol whose lines contain the call; null at module level. */
  readonly caller: string | null;
  /** 1-based line of the first such call. */
  readonly line: number;
}

/** Node types that are a plain name, in any supported grammar. */
const NAME_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'shorthand_property_identifier',
  'this',
  'self',
]);

/** Longest name path kept; deeper chains keep their last segments. */
const MAX_PATH = 6;

function calleePath(node: Node | null, spec: LanguageSpec, depth = 0): string[] | null {
  if (!node || depth > MAX_PATH) return null;
  if (NAME_TYPES.has(node.type)) return [node.text];
  const member = spec.members[node.type];
  if (!member) return null;
  const property = node.childForFieldName(member[1]);
  if (!property || !NAME_TYPES.has(property.type)) return null;
  const head = calleePath(node.childForFieldName(member[0]), spec, depth + 1) ?? ['*'];
  return [...head, property.text].slice(-MAX_PATH);
}

/** The innermost symbol whose line range contains `line`. */
function enclosing(symbols: readonly ParsedSymbol[], line: number): ParsedSymbol | null {
  let best: ParsedSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.startLine > line || symbol.endLine < line) continue;
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

/**
 * Every distinct call in the file — per calling symbol and callee — with the
 * line of its first occurrence. Calls inside closures belong to the symbol
 * that contains the closure. Nothing is resolved here.
 */
export function extractCalls(
  root: Node,
  spec: LanguageSpec,
  symbols: readonly ParsedSymbol[],
): ParsedCall[] {
  const byKey = new Map<string, ParsedCall>();
  const stack: Node[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const field = spec.calls[node.type];
    const callee = field ? calleePath(node.childForFieldName(field), spec) : null;
    if (callee && !spec.ignoredCallees.has(callee.join('.'))) {
      const line = node.startPosition.row + 1;
      const caller = enclosing(symbols, line)?.stableKey ?? null;
      const key = `${caller ?? ''}\0${callee.join('.')}`;
      if (!byKey.has(key)) byKey.set(key, { callee, caller, line });
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return [...byKey.values()];
}
