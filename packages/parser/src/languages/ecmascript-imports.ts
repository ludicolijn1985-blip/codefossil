import type { Node } from 'web-tree-sitter';
import { stringValue, type ImportBinding, type ImportReference, type ImportRule } from '../spec.js';

/** `import d, * as ns, { a, b as c } from 'x'` → d=default, ns=*, a=a, c=b. */
function clauseBindings(statement: Node): ImportBinding[] {
  const clause = statement.namedChildren.find((child) => child.type === 'import_clause');
  if (!clause) return [];
  return clause.namedChildren.flatMap((part): ImportBinding[] => {
    if (part.type === 'identifier') return [{ local: part.text, imported: 'default' }];
    if (part.type === 'namespace_import') {
      const name = part.namedChildren.find((child) => child.type === 'identifier');
      return name ? [{ local: name.text, imported: '*' }] : [];
    }
    if (part.type !== 'named_imports') return [];
    return part.namedChildren.flatMap((specifier): ImportBinding[] => {
      if (specifier.type !== 'import_specifier') return [];
      const name = specifier.childForFieldName('name')?.text;
      const alias = specifier.childForFieldName('alias')?.text;
      return name ? [{ local: alias ?? name, imported: name }] : [];
    });
  });
}

function importStatement(node: Node): readonly ImportReference[] {
  const specifier = stringValue(node.childForFieldName('source'));
  if (!specifier) return [];
  const bindings = clauseBindings(node);
  return [
    bindings.length > 0 ? { specifier, kind: 'import', bindings } : { specifier, kind: 'import' },
  ];
}

function reexport(node: Node): readonly ImportReference[] {
  const specifier = stringValue(node.childForFieldName('source'));
  return specifier ? [{ specifier, kind: 'reexport' }] : [];
}

/** `const u = require('x')` → u=*; `const { a, b: c } = require('x')` → a=a, c=b. */
function requireBindings(call: Node): ImportBinding[] {
  const declarator = call.parent;
  if (declarator?.type !== 'variable_declarator') return [];
  const name = declarator.childForFieldName('name');
  if (name?.type === 'identifier') return [{ local: name.text, imported: '*' }];
  if (name?.type !== 'object_pattern') return [];
  return name.namedChildren.flatMap((property): ImportBinding[] => {
    if (property.type === 'shorthand_property_identifier_pattern') {
      return [{ local: property.text, imported: property.text }];
    }
    if (property.type !== 'pair_pattern') return [];
    const key = property.childForFieldName('key');
    const value = property.childForFieldName('value');
    return key && value?.type === 'identifier' ? [{ local: value.text, imported: key.text }] : [];
  });
}

/** `require('x')` and `import('x')` with a literal argument. */
function callImport(node: Node): readonly ImportReference[] {
  const callee = node.childForFieldName('function');
  const kind =
    callee?.type === 'import' ? 'dynamic' : callee?.text === 'require' ? 'require' : null;
  if (!kind) return [];
  const specifier = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
  if (!specifier) return [];
  const bindings = kind === 'require' ? requireBindings(node) : [];
  return [bindings.length > 0 ? { specifier, kind, bindings } : { specifier, kind }];
}

export const ecmascriptImports: Readonly<Record<string, ImportRule>> = {
  import_statement: importStatement,
  // Only re-exports carry a source; `export const x` yields nothing.
  export_statement: reexport,
  call_expression: callImport,
};
