import type { Node } from 'web-tree-sitter';
import type { Collector, SymbolRange } from './extract.js';
import { visitNodes, type LanguageSpec, type TypedName } from './spec.js';

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
  /**
   * How the callee was found: null for a plain call; `type` when a name's
   * stated type stands in for it (`r.vat()` with `r = new Rates()` is
   * `Rates.vat`); `reference` for a function passed by name, not called
   * (`items.map(format)`).
   */
  readonly via: 'type' | 'reference' | null;
  /** The callee as written, when a stated type replaced its first name(s). */
  readonly written: string | null;
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
  // Ruby constants (`Rates.vat`) and PHP names (`helper()`, `Rates::vat()`).
  'constant',
  'name',
]);

/** Longest name path kept; deeper chains keep their last segments. */
const MAX_PATH = 6;

function calleePath(node: Node | null, spec: LanguageSpec, depth = 0): string[] | null {
  if (!node || depth > MAX_PATH) return null;
  if (NAME_TYPES.has(node.type)) return [node.text];
  // A PHP variable: `$this`, `$repo`.
  if (node.type === 'variable_name') return [node.text.replace(/^\$/, '')];
  // PHP `self::`, `static::` and `parent::`.
  if (node.type === 'relative_scope') return [node.text];
  const member = spec.members[node.type];
  return member ? memberPath(node, member, spec, depth) : null;
}

/** `object.name` from a node with separate object and name fields. */
function memberPath(
  node: Node,
  [objectField, nameField]: readonly [string, string],
  spec: LanguageSpec,
  depth: number,
): string[] | null {
  const name = node.childForFieldName(nameField);
  if (!name || !NAME_TYPES.has(name.type)) return null;
  const object = node.childForFieldName(objectField);
  // C# writes `this.Save()` with `this` as an unnamed token rather than a field.
  const keyword = object ? null : node.child(0)?.text;
  const head = object
    ? (calleePath(object, spec, depth + 1) ?? ['*'])
    : keyword === 'this' || keyword === 'base'
      ? [keyword]
      : [];
  return [...head, name.text].slice(-MAX_PATH);
}

/** The callee of a call node, by its rule: one callee field, or separate object and name fields. */
function calleeOf(node: Node, rule: string | readonly [string, string], spec: LanguageSpec) {
  return typeof rule === 'string'
    ? calleePath(node.childForFieldName(rule), spec)
    : memberPath(node, rule, spec, 0);
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
const BINDING_TYPES = new Set(['identifier', 'shorthand_property_identifier_pattern', 'name']);

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
  readonly reference: boolean;
}

/** Argument node types that pass a function by name. */
const REFERENCE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'member_expression',
  'attribute',
]);

/** Kinds whose own qualified name is the class that `this` refers to inside them. */
const CLASS_KINDS: ReadonlySet<string> = new Set([
  'class',
  'interface',
  'struct',
  'trait',
  'impl',
  'enum',
]);

/** `method:Cart.total#2` → kind `method`, qualified name `Cart.total`. */
function parseKey(key: string): { kind: string; qualifiedName: string } {
  const colon = key.indexOf(':');
  return { kind: key.slice(0, colon), qualifiedName: key.slice(colon + 1).replace(/#\d+$/, '') };
}

/** The class a symbol belongs to: itself for a class, else its container (`Cart` for `Cart.total`). */
function classOf(key: string): string | null {
  const { kind, qualifiedName } = parseKey(key);
  if (CLASS_KINDS.has(kind)) return qualifiedName;
  const dot = qualifiedName.lastIndexOf('.');
  return dot > 0 ? qualifiedName.slice(0, dot) : null;
}

function addType(map: Map<string, Map<string, readonly string[]>>, key: string, typed: TypedName) {
  const names = map.get(key) ?? new Map<string, readonly string[]>();
  names.set(typed.name, typed.type);
  map.set(key, names);
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
  /** Stated types: of locals per calling symbol, of fields per class, of module-level names. */
  const localTypes = new Map<string, Map<string, readonly string[]>>();
  const fieldTypes = new Map<string, Map<string, readonly string[]>>();
  const moduleTypes = new Map<string, readonly string[]>();
  const sites: CallSite[] = [];
  const typedNames = spec.typedNames ?? {};
  const types = new Set([
    ...Object.keys(spec.calls),
    ...Object.keys(spec.locals),
    ...Object.keys(typedNames),
  ]);

  const noteTypes = (node: Node, typing: (node: Node) => readonly TypedName[]) => {
    const owner = enclosing.at(node.startIndex);
    for (const typed of typing(node)) {
      if (typed.field) {
        const owningClass = owner ? classOf(owner.key) : null;
        if (owningClass) addType(fieldTypes, owningClass, typed);
      } else if (!owner || parseKey(owner.key).qualifiedName === typed.name) {
        // A module-level name: no symbol, or the variable's own symbol, encloses it.
        moduleTypes.set(typed.name, typed.type);
      } else {
        addType(localTypes, owner.key, typed);
      }
    }
  };

  /** Functions passed by name in a call's arguments. */
  const noteReferences = (node: Node, caller: string | null) => {
    const args = spec.callArguments ? node.childForFieldName(spec.callArguments) : null;
    for (const arg of args?.namedChildren ?? []) {
      if (!REFERENCE_TYPES.has(arg.type)) continue;
      const path = calleePath(arg, spec);
      const head = path?.[0];
      if (!path || !head || path.includes('*')) continue;
      sites.push({
        callee: path,
        caller,
        line: arg.startPosition.row + 1,
        self: path.length > 1 && spec.isSelf(node, head),
        reference: true,
      });
    }
  };

  const visit = (node: Node) => {
    const typing = typedNames[node.type];
    if (typing) noteTypes(node, typing);
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
    const rule = spec.calls[node.type];
    if (!rule) return;
    const callee = calleeOf(node, rule, spec);
    const head = callee?.[0];
    if (callee && spec.ignoredCallees.has(callee.join('.'))) return;
    const caller = enclosing.at(node.startIndex)?.key ?? null;
    noteReferences(node, caller);
    if (!callee || !head) return;
    sites.push({
      callee,
      caller,
      line: node.startPosition.row + 1,
      self: callee.length > 1 && spec.isSelf(node, head),
      reference: false,
    });
  };

  /** The stated type standing in for a call's first name(s), and how many names it replaces. */
  const statedType = (
    site: CallSite,
    local: boolean,
  ): { type: readonly string[]; replaces: number } | null => {
    const [head = '', second = ''] = site.callee;
    if (site.callee.length < 2) return null;
    if (site.self) {
      const owningClass = site.caller ? classOf(site.caller) : null;
      const type =
        owningClass && site.callee.length >= 3
          ? fieldTypes.get(owningClass)?.get(second)
          : undefined;
      return type ? { type, replaces: 2 } : null;
    }
    const type = local
      ? site.caller
        ? localTypes.get(site.caller)?.get(head)
        : undefined
      : moduleTypes.get(head);
    return type ? { type, replaces: 1 } : null;
  };

  const result = (): ParsedCall[] => {
    const byKey = new Map<string, ParsedCall>();
    for (const site of sites) {
      const head = site.callee[0] ?? '';
      const local =
        !site.self && site.caller !== null && (locals.get(site.caller)?.has(head) ?? false);
      const stated = statedType(site, local);
      const call: ParsedCall = stated
        ? {
            callee: [...stated.type, ...site.callee.slice(stated.replaces)],
            caller: site.caller,
            line: site.line,
            local: false,
            self: false,
            via: site.reference ? 'reference' : 'type',
            written: site.callee.join('.'),
          }
        : {
            callee: site.callee,
            caller: site.caller,
            line: site.line,
            local,
            self: site.self,
            via: site.reference ? 'reference' : null,
            written: null,
          };
      // A local passed by name (a parameter, a variable) names no definition: nothing to keep.
      if (site.reference && call.local) continue;
      const key = [call.caller ?? '', call.callee.join('.'), call.self, call.local, call.via].join(
        '\0',
      );
      if (!byKey.has(key)) byKey.set(key, call);
    }
    return [...byKey.values()];
  };
  return { types, visit, result };
}
