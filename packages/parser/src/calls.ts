import type { Node } from 'web-tree-sitter';
import type { SymbolRange } from './extract.js';
import type { LanguageSpec } from './spec.js';

/** A call as written in source, before resolution. */
export interface ParsedCall {
  /**
   * The callee as a name path: `foo()` is `['foo']`, `utils.flatten()` is
   * `['utils', 'flatten']`. A segment that is not a plain name (a call
   * result, an index) is `*`: `getApp().listen()` is `['*', 'listen']`.
   */
  readonly callee: readonly string[];
  /** `stableKey` of the innermost symbol containing the call; null at module level. */
  readonly caller: string | null;
  /** 1-based line of the first such call. */
  readonly line: number;
  /**
   * The first name of the callee is declared inside the calling symbol (a
   * parameter, variable or inner function), so it is not a module-level
   * definition or import of the same name.
   */
  readonly local: boolean;
  /** The first name is the object the calling method belongs to (`this`, `self`, a Go receiver). */
  readonly self: boolean;
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

/** Symbols by byte range, to find the innermost one containing a position. */
class Enclosing {
  private readonly ranges: readonly (readonly [string, SymbolRange])[];

  constructor(ranges: ReadonlyMap<string, SymbolRange>) {
    this.ranges = [...ranges];
  }

  /** The innermost symbol whose definition contains `index`; ties go to the later start. */
  at(index: number): { key: string; range: SymbolRange } | null {
    let best: { key: string; range: SymbolRange } | null = null;
    for (const [key, range] of this.ranges) {
      if (range.start > index || range.end <= index) continue;
      if (
        !best ||
        range.end - range.start < best.range.end - best.range.start ||
        (range.end - range.start === best.range.end - best.range.start &&
          range.start > best.range.start)
      ) {
        best = { key, range };
      }
    }
    return best;
  }
}

/** Node types that bind a name in a declaration (`{ opt }` in a destructuring pattern). */
const BINDING_TYPES = new Set(['identifier', 'shorthand_property_identifier_pattern']);

/** Every binding name inside `node`, iteratively (untrusted input may be deeply nested). */
function identifiers(node: Node): string[] {
  const names: string[] = [];
  const stack: Node[] = [node];
  for (let current = stack.pop(); current; current = stack.pop()) {
    if (BINDING_TYPES.has(current.type)) names.push(current.text);
    stack.push(...current.namedChildren);
  }
  return names;
}

/**
 * Names declared inside each symbol: its parameters, variables and inner
 * functions. A symbol's own name is not local to it.
 */
function localNames(
  root: Node,
  spec: LanguageSpec,
  enclosing: Enclosing,
): Map<string, Set<string>> {
  const locals = new Map<string, Set<string>>();
  const stack: Node[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const field = spec.locals[node.type];
    if (field !== undefined) {
      const owner = enclosing.at(node.startIndex);
      const declared = field === null ? node : node.childForFieldName(field);
      if (owner && declared && owner.range.start !== node.startIndex) {
        const names = locals.get(owner.key) ?? new Set<string>();
        for (const name of identifiers(declared)) names.add(name);
        locals.set(owner.key, names);
      }
    }
    stack.push(...node.namedChildren);
  }
  return locals;
}

/**
 * Every distinct call in the file — per calling symbol and callee — with the
 * line of its first occurrence. Calls inside closures belong to the symbol
 * that contains the closure. Nothing is resolved here.
 */
export function extractCalls(
  root: Node,
  spec: LanguageSpec,
  ranges: ReadonlyMap<string, SymbolRange>,
): ParsedCall[] {
  const enclosing = new Enclosing(ranges);
  const locals = localNames(root, spec, enclosing);
  const byKey = new Map<string, ParsedCall>();
  const stack: Node[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const field = spec.calls[node.type];
    const callee = field ? calleePath(node.childForFieldName(field), spec) : null;
    const head = callee?.[0];
    if (callee && head && !spec.ignoredCallees.has(callee.join('.'))) {
      const caller = enclosing.at(node.startIndex)?.key ?? null;
      const self = callee.length > 1 && spec.isSelf(node, head);
      const local = !self && caller !== null && (locals.get(caller)?.has(head) ?? false);
      const key = `${caller ?? ''}\0${callee.join('.')}\0${String(self)}\0${String(local)}`;
      if (!byKey.has(key)) {
        byKey.set(key, { callee, caller, line: node.startPosition.row + 1, local, self });
      }
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  return [...byKey.values()];
}
