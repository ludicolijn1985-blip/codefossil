import type { SymbolKind } from '@codefossil/shared';
import { firstDescendant, type LanguageSpec } from '../spec.js';

const TYPE_NAMES = new Set(['type_identifier']);

const TYPE_SPEC_KINDS: Readonly<Record<string, SymbolKind>> = {
  struct_type: 'struct',
  interface_type: 'interface',
};

export const go: LanguageSpec = {
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
};
