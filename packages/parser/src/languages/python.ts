import type { LanguageSpec } from '../spec.js';

export const python: LanguageSpec = {
  definitions: {
    function_definition: { kind: 'function' },
    class_definition: { kind: 'class', container: true },
  },
  // Class bodies are also `block`s, but containers are always descended into.
  opaque: new Set(['lambda', 'block']),
};
