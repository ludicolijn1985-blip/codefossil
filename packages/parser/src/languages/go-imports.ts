import { stringValue, type ImportRule } from '../spec.js';

export const goImports: Readonly<Record<string, ImportRule>> = {
  // `import fx "example.com/money/fx"` binds fx; without an alias the package is assumed to be
  // named after the last path element. A package declaring another name simply never matches.
  import_spec: (node) => {
    const specifier = stringValue(node.childForFieldName('path'));
    if (!specifier) return [];
    const alias = node.childForFieldName('name')?.text;
    if (alias === '_' || alias === '.') return [{ specifier, kind: 'import' }];
    const local = alias ?? specifier.split('/').at(-1);
    return local
      ? [{ specifier, kind: 'import', bindings: [{ local, imported: '*' }] }]
      : [{ specifier, kind: 'import' }];
  },
};
