import type { Node } from 'web-tree-sitter';
import type { ImportReference, ImportRule } from '../spec.js';

/**
 * The module path a `use` refers to, without the imported item list:
 * `use crate::tax::{rate, apply};` → `crate::tax`, `use std::io::Read;` → `std::io::Read`.
 */
function usePath(node: Node): string | null {
  const argument = node.childForFieldName('argument');
  if (!argument) return null;
  switch (argument.type) {
    case 'scoped_use_list':
    case 'use_wildcard':
      return argument.childForFieldName('path')?.text ?? argument.namedChildren[0]?.text ?? null;
    case 'use_as_clause':
      return argument.childForFieldName('path')?.text ?? null;
    case 'use_list':
      return null; // `use {a, b};` has no common path
    default:
      return argument.text;
  }
}

function useDeclaration(node: Node): readonly ImportReference[] {
  const specifier = usePath(node);
  return specifier ? [{ specifier, kind: 'use' }] : [];
}

/** `mod tax;` (no body) loads `tax.rs` or `tax/mod.rs`; `mod tax { … }` is inline. */
function modItem(node: Node): readonly ImportReference[] {
  if (node.childForFieldName('body')) return [];
  const name = node.childForFieldName('name')?.text;
  return name ? [{ specifier: name, kind: 'mod' }] : [];
}

export const rustImports: Readonly<Record<string, ImportRule>> = {
  use_declaration: useDeclaration,
  mod_item: modItem,
  extern_crate_declaration: (node) => {
    const name = node.childForFieldName('name')?.text;
    return name ? [{ specifier: name, kind: 'use' }] : [];
  },
};
