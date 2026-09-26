import type { Node } from 'web-tree-sitter';
import type { ImportReference, ImportRule } from '../spec.js';

/** `import a.b, c as d` */
function importStatement(node: Node): readonly ImportReference[] {
  return node.childrenForFieldName('name').flatMap((name) => {
    const module = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
    return module ? [{ specifier: module.text, kind: 'import' as const }] : [];
  });
}

/** `from ..pkg import a, b as c` — the names may be submodules or attributes. */
function importFromStatement(node: Node): readonly ImportReference[] {
  const module = node.childForFieldName('module_name');
  if (!module) return [];
  const names = node.childrenForFieldName('name').flatMap((name) => {
    const imported = name.type === 'aliased_import' ? name.childForFieldName('name') : name;
    return imported ? [imported.text] : [];
  });
  return [{ specifier: module.text, kind: 'from', names }];
}

export const pythonImports: Readonly<Record<string, ImportRule>> = {
  import_statement: importStatement,
  import_from_statement: importFromStatement,
};
