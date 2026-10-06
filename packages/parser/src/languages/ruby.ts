import type { Node } from 'web-tree-sitter';
import { ancestorOf, stringValue, type ImportReference, type LanguageSpec } from '../spec.js';

const METHODS = new Set(['method']);

/**
 * `require 'json'` and `require_relative 'tax/rates'` (written as `./tax/rates`
 * so it resolves against the requiring file), with a literal argument.
 */
function requireCall(node: Node): readonly ImportReference[] {
  if (node.childForFieldName('receiver')) return [];
  const method = node.childForFieldName('method')?.text;
  if (method !== 'require' && method !== 'require_relative') return [];
  const value = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
  if (!value) return [];
  const specifier = method === 'require_relative' && !value.startsWith('.') ? `./${value}` : value;
  return [{ specifier, kind: 'require' }];
}

export const ruby: LanguageSpec = {
  imports: { call: requireCall },
  definitions: {
    class: { kind: 'class', container: true },
    module: { kind: 'module', container: true },
    method: { kind: 'function' },
    singleton_method: { kind: 'method' },
  },
  opaque: new Set(['block', 'do_block', 'lambda']),
  calls: { call: ['receiver', 'method'] },
  members: { call: ['receiver', 'method'] },
  ignoredCallees: new Set([
    'require',
    'require_relative',
    'attr_accessor',
    'attr_reader',
    'attr_writer',
    'include',
    'extend',
    'private',
    'protected',
    'public',
  ]),
  locals: {
    method_parameters: null,
    block_parameters: null,
    lambda_parameters: null,
    assignment: 'left',
    operator_assignment: 'left',
  },
  // Inside an instance method `self` is the object; in a class body or `def self.x` it is the class.
  isSelf: (call, receiver) => receiver === 'self' && ancestorOf(call, METHODS) !== null,
};
