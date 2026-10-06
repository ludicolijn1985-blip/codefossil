import type { Node } from 'web-tree-sitter';
import { ancestorOf, type ImportReference, type LanguageSpec } from '../spec.js';

const MEMBERS = new Set([
  'method_declaration',
  'constructor_declaration',
  'property_declaration',
  'accessor_declaration',
]);

/**
 * `using Acme.Tax;` imports a namespace, which in C# is not tied to a file,
 * so it binds no names. Aliases (`using T = Acme.Tax;`) name the namespace.
 */
function usingDirective(node: Node): readonly ImportReference[] {
  const names = node.namedChildren.filter(
    (child) => child.type === 'qualified_name' || child.type === 'identifier',
  );
  const namespace = names.at(-1);
  return namespace ? [{ specifier: namespace.text, kind: 'import' }] : [];
}

export const csharp: LanguageSpec = {
  imports: { using_directive: usingDirective },
  definitions: {
    class_declaration: { kind: 'class', container: true },
    struct_declaration: { kind: 'struct', container: true },
    interface_declaration: { kind: 'interface', container: true },
    record_declaration: { kind: 'class', container: true },
    enum_declaration: { kind: 'enum' },
    method_declaration: { kind: 'function' },
    constructor_declaration: { kind: 'method' },
    property_declaration: { kind: 'property' },
  },
  opaque: new Set([
    'block',
    'lambda_expression',
    'anonymous_method_expression',
    'arrow_expression_clause',
    'accessor_list',
  ]),
  calls: {
    invocation_expression: 'function',
    object_creation_expression: 'type',
  },
  members: { member_access_expression: ['expression', 'name'] },
  ignoredCallees: new Set(['nameof']),
  locals: {
    parameter: 'name',
    variable_declarator: 'name',
    catch_declaration: 'name',
    foreach_statement: 'left',
  },
  isSelf: (call, receiver) => receiver === 'this' && ancestorOf(call, MEMBERS) !== null,
};
