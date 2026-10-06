import { pythonImports } from './python-imports.js';
import type { LanguageSpec } from '../spec.js';

export const python: LanguageSpec = {
  imports: pythonImports,
  definitions: {
    function_definition: { kind: 'function' },
    class_definition: { kind: 'class', container: true },
  },
  // Class bodies are also `block`s, but containers are always descended into.
  opaque: new Set(['lambda', 'block']),
  calls: { call: 'function' },
  members: { attribute: ['object', 'attribute'] },
  ignoredCallees: new Set(),
};
