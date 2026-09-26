import type { Node } from 'web-tree-sitter';
import { stringValue, type ImportReference, type ImportRule } from '../spec.js';

function fromSource(kind: ImportReference['kind']): ImportRule {
  return (node) => {
    const specifier = stringValue(node.childForFieldName('source'));
    return specifier ? [{ specifier, kind }] : [];
  };
}

/** `require('x')` and `import('x')` with a literal argument. */
function callImport(node: Node): readonly ImportReference[] {
  const callee = node.childForFieldName('function');
  const kind =
    callee?.type === 'import' ? 'dynamic' : callee?.text === 'require' ? 'require' : null;
  if (!kind) return [];
  const specifier = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
  return specifier ? [{ specifier, kind }] : [];
}

export const ecmascriptImports: Readonly<Record<string, ImportRule>> = {
  import_statement: fromSource('import'),
  // Only re-exports carry a source; `export const x` yields nothing.
  export_statement: fromSource('reexport'),
  call_expression: callImport,
};
