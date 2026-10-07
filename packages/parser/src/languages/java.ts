import type { Node } from 'web-tree-sitter';
import { ancestorOf, type ImportReference, type LanguageSpec } from '../spec.js';

const METHODS = new Set(['method_declaration', 'constructor_declaration']);
const BODIES = new Set(['class_body', 'enum_body', 'interface_body']);

/**
 * `import a.b.C;` binds `C`; `import static a.b.C.m;` binds `m` to `C.m` in
 * class `a.b.C`; `import a.b.*;` imports a whole package and binds nothing.
 */
function importDeclaration(node: Node): readonly ImportReference[] {
  const path = node.namedChildren.find(
    (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
  );
  if (!path) return [];
  if (node.namedChildren.some((child) => child.type === 'asterisk')) {
    return [{ specifier: `${path.text}.*`, kind: 'import' }];
  }
  const parts = path.text.split('.');
  if (/^import\s+static\b/.test(node.text)) {
    const member = parts.pop();
    const owner = parts.at(-1);
    return member && owner
      ? [
          {
            specifier: parts.join('.'),
            kind: 'import',
            bindings: [{ local: member, imported: `${owner}.${member}` }],
          },
        ]
      : [];
  }
  const name = parts.at(-1);
  return name
    ? [{ specifier: path.text, kind: 'import', bindings: [{ local: name, imported: name }] }]
    : [];
}

export const java: LanguageSpec = {
  imports: { import_declaration: importDeclaration },
  definitions: {
    class_declaration: { kind: 'class', container: true },
    interface_declaration: { kind: 'interface', container: true },
    enum_declaration: { kind: 'enum', container: true },
    record_declaration: { kind: 'class', container: true },
    annotation_type_declaration: { kind: 'interface' },
    method_declaration: { kind: 'function' },
    constructor_declaration: { kind: 'method' },
  },
  opaque: new Set(['block', 'constructor_body', 'lambda_expression']),
  calls: {
    method_invocation: ['object', 'name'],
    object_creation_expression: 'type',
  },
  members: { field_access: ['object', 'field'] },
  ignoredCallees: new Set(),
  locals: {
    formal_parameter: 'name',
    variable_declarator: 'name',
    catch_formal_parameter: 'name',
    enhanced_for_statement: 'name',
    lambda_expression: 'parameters',
  },
  // `this` is the declared class's object, but not inside an anonymous class body.
  isSelf: (call, receiver) => {
    if (receiver !== 'this' || !ancestorOf(call, METHODS)) return false;
    return ancestorOf(call, BODIES)?.parent?.type !== 'object_creation_expression';
  },
};
