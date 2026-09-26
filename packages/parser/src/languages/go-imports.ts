import { stringValue, type ImportRule } from '../spec.js';

export const goImports: Readonly<Record<string, ImportRule>> = {
  import_spec: (node) => {
    const specifier = stringValue(node.childForFieldName('path'));
    return specifier ? [{ specifier, kind: 'import' }] : [];
  },
};
