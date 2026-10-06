import type { Node } from 'web-tree-sitter';
import type { Collector, SymbolRange } from './extract.js';
import { visitNodes, type LanguageSpec } from './spec.js';

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

/** Every binding name inside `node`. */
function identifiers(node: Node): string[] {
  const names: string[] = [];
  visitNodes(node, BINDING_TYPES, (found) => names.push(found.text));
  return names;
}

interface CallSite {
  readonly callee: string[];
  readonly caller: string | null;
  readonly line: number;
  readonly self: boolean;
}

/**
 * Every distinct call in the file — per calling symbol and callee — with the
 * line of its first occurrence. Calls inside closures belong to the symbol
 * that contains the closure. One pass collects the calls and the names each
 * symbol declares (its parameters, variables and inner functions; never its
 * own name); whether a call's first name is local is decided afterwards,
 * since a declaration may follow the call. Nothing is resolved here.
 */
export function extractCalls(
  root: Node,
  spec: LanguageSpec,
  ranges: ReadonlyMap<string, SymbolRange>,
): ParsedCall[] {
  const collector = callCollector(spec, ranges);
  visitNodes(root, collector.types, collector.visit);
  return collector.result();
}

/** The call collector of {@link extractCalls}, for sharing one walk with other collectors. */
export function callCollector(
  spec: LanguageSpec,
  ranges: ReadonlyMap<string, SymbolRange>,
): Collector<ParsedCall[]> {
  const enclosing = new Enclosing(ranges);
  const locals = new Map<string, Set<string>>();
  const sites: CallSite[] = [];
  const types = new Set([...Object.keys(spec.calls), ...Object.keys(spec.locals)]);

  const visit = (node: Node) => {
    const localField = spec.locals[node.type];
    if (localField !== undefined) {
      const owner = enclosing.at(node.startIndex);
      const declared = localField === null ? node : node.childForFieldName(localField);
      if (owner && declared && owner.range.start !== node.startIndex) {
        const names = locals.get(owner.key) ?? new Set<string>();
        for (const name of identifiers(declared)) names.add(name);
        locals.set(owner.key, names);
      }
    }
    const calleeField = spec.calls[node.type];
    const callee = calleeField ? calleePath(node.childForFieldName(calleeField), spec) : null;
    const head = callee?.[0];
    if (!callee || !head || spec.ignoredCallees.has(callee.join('.'))) return;
    sites.push({
      callee,
      caller: enclosing.at(node.startIndex)?.key ?? null,
      line: node.startPosition.row + 1,
      self: callee.length > 1 && spec.isSelf(node, head),
    });
  };

  const result = (): ParsedCall[] => {
    const byKey = new Map<string, ParsedCall>();
    for (const site of sites) {
      const head = site.callee[0] ?? '';
      const local =
        !site.self && site.caller !== null && (locals.get(site.caller)?.has(head) ?? false);
      const key = `${site.caller ?? ''}\0${site.callee.join('.')}\0${String(site.self)}\0${String(local)}`;
      if (!byKey.has(key)) byKey.set(key, { ...site, local });
    }
    return [...byKey.values()];
  };
  return { types, visit, result };
}
