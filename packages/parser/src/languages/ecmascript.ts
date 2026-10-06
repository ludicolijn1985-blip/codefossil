import { ecmascriptImports } from './ecmascript-imports.js';
import type { Node } from 'web-tree-sitter';
import type { LanguageSpec } from '../spec.js';

/** Where a `const`/`let`/`var` declaration counts as a module-level symbol. */
const MODULE_LEVEL = new Set(['program', 'export_statement']);
const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

function isModuleLevelDeclarator(node: Node): boolean {
  const declaration = node.parent;
  const scope = declaration?.parent;
  return (
    node.childForFieldName('name')?.type === 'identifier' &&
    scope !== null &&
    scope !== undefined &&
    MODULE_LEVEL.has(scope.type)
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
  return parent?.type === 'expression_statement' && parent.parent?.type === 'program';
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
  calls: { call_expression: 'function', new_expression: 'constructor' },
  members: { member_expression: ['object', 'property'] },
  ignoredCallees: new Set(['require']),
};
