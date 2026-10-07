import { rustImports } from './rust-imports.js';
import { ancestorOf, type LanguageSpec } from '../spec.js';

const FUNCTIONS = new Set(['function_item']);

export const rust: LanguageSpec = {
  imports: rustImports,
  definitions: {
    function_item: { kind: 'function' },
    function_signature_item: { kind: 'function' },
    struct_item: { kind: 'struct' },
    enum_item: { kind: 'enum' },
    union_item: { kind: 'struct' },
    type_item: { kind: 'type' },
    trait_item: { kind: 'trait', container: true },
    mod_item: { kind: 'module', container: true },
    // `impl Trait for Type` and `impl Type` both qualify their items with `Type`.
    // Generic arguments are left out, so renaming `T` to `U` keeps the identity.
    impl_item: {
      kind: 'impl',
      container: true,
      name: (node) => {
        const type = node.childForFieldName('type');
        if (!type) return null;
        return type.type === 'generic_type'
          ? (type.childForFieldName('type')?.text ?? type.text)
          : type.text;
      },
    },
    const_item: { kind: 'variable' },
    static_item: { kind: 'variable' },
  },
  opaque: new Set(['closure_expression', 'block']),
  calls: { call_expression: 'function' },
  members: { field_expression: ['value', 'field'], scoped_identifier: ['path', 'name'] },
  ignoredCallees: new Set(),
  locals: {
    parameters: null,
    closure_parameters: null,
    let_declaration: 'pattern',
    for_expression: 'pattern',
  },
  isSelf: (call, receiver) => {
    if (receiver !== 'self') return false;
    const fn = ancestorOf(call, FUNCTIONS);
    return (
      fn?.childForFieldName('parameters')?.namedChildren.some((p) => p.type === 'self_parameter') ??
      false
    );
  },
};
