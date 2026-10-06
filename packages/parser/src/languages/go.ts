import { goImports } from './go-imports.js';
import type { SymbolKind } from '@codefossil/shared';
import { ancestorOf, firstDescendant, type LanguageSpec } from '../spec.js';

const METHODS = new Set(['method_declaration']);

const TYPE_NAMES = new Set(['type_identifier']);

const TYPE_SPEC_KINDS: Readonly<Record<string, SymbolKind>> = {
  struct_type: 'struct',
  interface_type: 'interface',
};

export const go: LanguageSpec = {
  imports: goImports,
  definitions: {
    function_declaration: { kind: 'function' },
    method_declaration: {
      kind: 'method',
      // `func (s *Server) Start()` is qualified as `Server.Start`.
      scope: (node) => {
        const receiver = node.childForFieldName('receiver');
        const type = receiver ? firstDescendant(receiver, TYPE_NAMES) : null;
        return type ? [type.text] : [];
      },
    },
    type_spec: {
      kind: 'type',
      kindOf: (node) => TYPE_SPEC_KINDS[node.childForFieldName('type')?.type ?? ''] ?? 'type',
    },
    type_alias: { kind: 'type' },
  },
  opaque: new Set(['func_literal', 'block']),
  calls: { call_expression: 'function' },
  members: { selector_expression: ['operand', 'field'] },
  ignoredCallees: new Set(),
  locals: {
    parameter_list: null,
    short_var_declaration: 'left',
    var_spec: 'name',
    const_spec: 'name',
    range_clause: 'left',
  },
  // The receiver of the enclosing method: `s` in `func (s *Server) Start()`.
  isSelf: (call, receiver) => {
    const method = ancestorOf(call, METHODS);
    const parameter = method?.childForFieldName('receiver')?.namedChildren[0];
    return parameter?.childForFieldName('name')?.text === receiver;
  },
};
