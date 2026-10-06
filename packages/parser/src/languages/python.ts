import { pythonImports } from './python-imports.js';
import { ancestorOf, type LanguageSpec } from '../spec.js';

const FUNCTIONS = new Set(['function_definition']);

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
  locals: {
    parameters: null,
    lambda_parameters: null,
    assignment: 'left',
    augmented_assignment: 'left',
    for_statement: 'left',
    for_in_clause: 'left',
    named_expression: 'name',
    as_pattern: 'alias',
    function_definition: 'name',
    class_definition: 'name',
  },
  isSelf: (call, receiver) => {
    if (receiver !== 'self') return false;
    const fn = ancestorOf(call, FUNCTIONS);
    const first = fn?.childForFieldName('parameters')?.namedChildren[0];
    return first?.type === 'identifier' && first.text === 'self';
  },
};
