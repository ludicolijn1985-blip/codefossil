import { ecmascriptImports } from './ecmascript-imports.js';
import type { Node } from 'web-tree-sitter';
import { ancestorOf, type LanguageSpec } from '../spec.js';
import { ecmascriptTypedNames } from './typed-names.js';

/** Where a `const`/`let`/`var` declaration counts as a module-level symbol. */
const MODULE_LEVEL = new Set(['program', 'export_statement']);
const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

/** Functions that give `this` a new meaning (arrow functions keep the outer one). */
const THIS_BINDERS = new Set([
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'function',
  'method_definition',
]);

/** Look through `( … )` and `!` / `void` around a wrapper call. */
function unwrap(node: Node | null): Node | null {
  let current = node;
  while (current?.type === 'parenthesized_expression' || current?.type === 'unary_expression') {
    current =
      current.type === 'unary_expression'
        ? current.childForFieldName('argument')
        : (current.namedChildren[0] ?? null);
  }
  return current;
}

/**
 * The function bodies of a module-level wrapper statement, whose contents are
 * the module's own definitions: `(function () { … })()`, `!function () { … }()`,
 * `(function () { … }).call(this)`, and UMD's `(function (root, factory) { … })(this,
 * function () { … })` (both bodies). Empty for any other statement.
 */
export function wrapperBodies(statement: Node): Node[] {
  if (statement.type !== 'expression_statement' || statement.parent?.type !== 'program') return [];
  const call = unwrap(statement.namedChildren[0] ?? null);
  if (call?.type !== 'call_expression') return [];
  let callee = unwrap(call.childForFieldName('function'));
  if (
    callee?.type === 'member_expression' &&
    ['call', 'apply'].includes(callee.childForFieldName('property')?.text ?? '')
  ) {
    callee = unwrap(callee.childForFieldName('object'));
  }
  if (!callee || !FUNCTION_VALUES.has(callee.type)) return [];
  const factories = (call.childForFieldName('arguments')?.namedChildren ?? []).filter((arg) =>
    FUNCTION_VALUES.has(arg.type),
  );
  return [callee, ...factories].flatMap((fn) => {
    const body = fn.childForFieldName('body');
    return body?.type === 'statement_block' ? [body] : [];
  });
}

/** The program, or the body of a module-level wrapper function. */
function isModuleScope(node: Node | null): boolean {
  if (!node) return false;
  if (MODULE_LEVEL.has(node.type)) return true;
  if (node.type !== 'statement_block') return false;
  let statement: Node | null = node.parent;
  while (statement && statement.type !== 'expression_statement') statement = statement.parent;
  return statement !== null && wrapperBodies(statement).some((body) => body.id === node.id);
}

function isModuleLevelDeclarator(node: Node): boolean {
  const declaration = node.parent;
  return (
    node.childForFieldName('name')?.type === 'identifier' &&
    isModuleScope(declaration?.parent ?? null)
  );
}

/** `a.b.c` of a member expression, or null when any part is computed (`a[b]`, calls). */
function memberPath(node: Node): string[] | null {
  if (node.type === 'identifier' || node.type === 'this') return [node.text];
  if (node.type !== 'member_expression') return null;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (!object || property?.type !== 'property_identifier') return null;
  const head = memberPath(object);
  return head ? [...head, property.text] : null;
}

/**
 * Who a function is assigned to, as a name path: `res.send` → [res, send],
 * `Cart.prototype.total` → [Cart, total], `exports.x` and
 * `module.exports.x` → [x]. Null when the target is not a plain member path.
 */
function assignedPath(node: Node): string[] | null {
  const left = node.childForFieldName('left');
  if (left?.type !== 'member_expression') return null;
  const path = memberPath(left);
  if (!path) return null;
  const exported =
    path[0] === 'module' && path[1] === 'exports'
      ? path.slice(2)
      : path[0] === 'exports'
        ? path.slice(1)
        : path;
  const parts = exported.filter((part) => part !== 'prototype');
  return parts.length > 0 ? parts : null;
}

/** The value finally assigned: in `a = b = function () {}` both get the function. */
function assignedValue(node: Node): Node | null {
  let value = node.childForFieldName('right');
  while (value?.type === 'assignment_expression') value = value.childForFieldName('right');
  return value;
}

/** A statement at module level, or part of a chain `a = b = …` that is one. */
function isModuleLevelAssignment(node: Node): boolean {
  let current = node;
  let parent = node.parent;
  while (
    parent?.type === 'assignment_expression' &&
    parent.childForFieldName('right')?.id === current.id
  ) {
    current = parent;
    parent = parent.parent;
  }
  return parent?.type === 'expression_statement' && isModuleScope(parent.parent);
}

/** TypeScript, TSX and JavaScript share one spec; node types a grammar lacks never match. */
export const ecmascript: LanguageSpec = {
  imports: ecmascriptImports,
  definitions: {
    function_declaration: { kind: 'function' },
    generator_function_declaration: { kind: 'function' },
    // TypeScript overload and `declare function` signatures.
    function_signature: { kind: 'function' },
    class_declaration: { kind: 'class', container: true },
    abstract_class_declaration: { kind: 'class', container: true },
    method_definition: { kind: 'method' },
    abstract_method_signature: { kind: 'method' },
    public_field_definition: { kind: 'property' },
    field_definition: {
      kind: 'property',
      name: (node) => node.childForFieldName('property')?.text ?? null,
    },
    interface_declaration: { kind: 'interface' },
    type_alias_declaration: { kind: 'type' },
    enum_declaration: { kind: 'enum' },
    internal_module: { kind: 'module', container: true },
    // `res.send = function send() {}`, `Cart.prototype.total = …`, `exports.x = …`:
    // the CommonJS and prototype style of defining functions.
    assignment_expression: {
      kind: 'function',
      accept: (node) => {
        const value = assignedValue(node)?.type ?? '';
        return (
          (FUNCTION_VALUES.has(value) || value === 'class') &&
          assignedPath(node) !== null &&
          isModuleLevelAssignment(node)
        );
      },
      name: (node) => assignedPath(node)?.at(-1) ?? null,
      scope: (node) => (assignedPath(node) ?? []).slice(0, -1),
      kindOf: (node) => {
        if (assignedValue(node)?.type === 'class') return 'class';
        return (assignedPath(node)?.length ?? 0) > 1 ? 'method' : 'function';
      },
      next: (node) => {
        const right = node.childForFieldName('right');
        return right?.type === 'assignment_expression' ? right : null;
      },
    },
    variable_declarator: {
      kind: 'variable',
      accept: isModuleLevelDeclarator,
      // `const Api = { init() {} }` and `const Foo = class { bar() {} }` define members too.
      // Function values are opaque, so their locals are still skipped.
      container: true,
      kindOf: (node) => {
        const value = node.childForFieldName('value')?.type ?? '';
        if (FUNCTION_VALUES.has(value)) return 'function';
        return value === 'class' ? 'class' : 'variable';
      },
    },
  },
  opaque: new Set([
    'arrow_function',
    'function_expression',
    'function',
    'generator_function',
    'statement_block',
  ]),
  moduleWrappers: wrapperBodies,
  calls: { call_expression: 'function', new_expression: 'constructor' },
  members: { member_expression: ['object', 'property'] },
  ignoredCallees: new Set(['require']),
  locals: {
    variable_declarator: 'name',
    function_declaration: 'name',
    generator_function_declaration: 'name',
    class_declaration: 'name',
    formal_parameters: null,
    arrow_function: 'parameter',
    catch_clause: 'parameter',
  },
  typedNames: ecmascriptTypedNames,
  callArguments: 'arguments',
  // `this` is the object only up to the nearest non-arrow function: the method itself, or
  // a function assigned as one (`X.prototype.m = function () {}`).
  isSelf: (call, receiver) => {
    if (receiver !== 'this') return false;
    const fn = ancestorOf(call, THIS_BINDERS);
    return fn?.type === 'method_definition' || fn?.parent?.type === 'assignment_expression';
  },
};
