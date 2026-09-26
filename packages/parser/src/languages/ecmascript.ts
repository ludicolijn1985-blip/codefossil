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
};
