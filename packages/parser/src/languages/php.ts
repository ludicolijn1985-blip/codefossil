import type { Node } from 'web-tree-sitter';
import { ancestorOf, stringValue, type ImportReference, type LanguageSpec } from '../spec.js';

const METHODS = new Set(['method_declaration']);

/** `use App\Tax\Rates;` binds `Rates`; `use App\Tax\Rates as R;` binds `R`. */
function useDeclaration(node: Node): readonly ImportReference[] {
  return node.namedChildren.flatMap((clause): ImportReference[] => {
    if (clause.type !== 'namespace_use_clause') return [];
    const name = clause.namedChildren.find(
      (child) => child.type === 'qualified_name' || child.type === 'name',
    );
    if (!name) return [];
    const imported = name.text.split('\\').at(-1) ?? name.text;
    const local = clause.childForFieldName('alias')?.text ?? imported;
    return [{ specifier: name.text, kind: 'import', bindings: [{ local, imported }] }];
  });
}

/**
 * `require 'lib.php'` and `require_once __DIR__ . '/lib.php'` with a literal
 * path; the `__DIR__` form is written as `./lib.php` to resolve against the
 * requiring file.
 */
function requireExpression(node: Node): readonly ImportReference[] {
  const argument = node.namedChildren[0];
  if (!argument) return [];
  if (argument.type === 'binary_expression') {
    const left = argument.childForFieldName('left');
    const path = stringValue(argument.childForFieldName('right'));
    return left?.text === '__DIR__' && path
      ? [{ specifier: `.${path.startsWith('/') ? '' : '/'}${path}`, kind: 'require' }]
      : [];
  }
  const path = stringValue(argument);
  return path ? [{ specifier: path, kind: 'require' }] : [];
}

export const php: LanguageSpec = {
  imports: {
    namespace_use_declaration: useDeclaration,
    require_expression: requireExpression,
    require_once_expression: requireExpression,
    include_expression: requireExpression,
    include_once_expression: requireExpression,
  },
  definitions: {
    class_declaration: { kind: 'class', container: true },
    interface_declaration: { kind: 'interface', container: true },
    trait_declaration: { kind: 'trait', container: true },
    enum_declaration: { kind: 'enum', container: true },
    method_declaration: { kind: 'method' },
    function_definition: { kind: 'function' },
  },
  // `namespace App { … }` holds the file's own definitions.
  moduleWrappers: (node) => {
    const body = node.type === 'namespace_definition' ? node.childForFieldName('body') : null;
    return body ? [body] : [];
  },
  opaque: new Set(['compound_statement', 'anonymous_function', 'arrow_function']),
  calls: {
    function_call_expression: 'function',
    member_call_expression: ['object', 'name'],
    nullsafe_member_call_expression: ['object', 'name'],
    scoped_call_expression: ['scope', 'name'],
  },
  members: {
    member_access_expression: ['object', 'name'],
    nullsafe_member_access_expression: ['object', 'name'],
  },
  ignoredCallees: new Set(),
  locals: {
    simple_parameter: 'name',
    property_promotion_parameter: 'name',
    variadic_parameter: 'name',
    assignment_expression: 'left',
  },
  // `$this->x()`, `self::x()` and `static::x()` inside a method.
  isSelf: (call, receiver) =>
    ['this', 'self', 'static'].includes(receiver) && ancestorOf(call, METHODS) !== null,
};
