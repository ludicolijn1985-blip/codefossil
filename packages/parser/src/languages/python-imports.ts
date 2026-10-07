import type { Node } from 'web-tree-sitter';
import type { ImportBinding, ImportReference, ImportRule } from '../spec.js';

/**
 * `import a.b, c as d`: `c as d` binds d to module c, and `import c` binds c.
 * `import a.b` binds only the package `a`, not the module read, so it records no binding.
 */
function importStatement(node: Node): readonly ImportReference[] {
  return node.childrenForFieldName('name').flatMap((name): ImportReference[] => {
    const aliased = name.type === 'aliased_import';
    const module = aliased ? name.childForFieldName('name') : name;
    if (!module) return [];
    const local = aliased ? name.childForFieldName('alias')?.text : module.text;
    const bindings: ImportBinding[] =
      local && (aliased || !module.text.includes('.')) ? [{ local, imported: '*' }] : [];
    return [
      bindings.length > 0
        ? { specifier: module.text, kind: 'import', bindings }
        : { specifier: module.text, kind: 'import' },
    ];
  });
}

/** `from ..pkg import a, b as c` — the names may be submodules or attributes. */
function importFromStatement(node: Node): readonly ImportReference[] {
  const module = node.childForFieldName('module_name');
  if (!module) return [];
  const names: string[] = [];
  const bindings: ImportBinding[] = [];
  for (const name of node.childrenForFieldName('name')) {
    const aliased = name.type === 'aliased_import';
    const imported = aliased ? name.childForFieldName('name') : name;
    if (!imported) continue;
    names.push(imported.text);
    const local = aliased ? (name.childForFieldName('alias')?.text ?? null) : imported.text;
    if (local) bindings.push({ local, imported: imported.text });
  }
  return [{ specifier: module.text, kind: 'from', names, bindings }];
}

export const pythonImports: Readonly<Record<string, ImportRule>> = {
  import_statement: importStatement,
  import_from_statement: importFromStatement,
};
