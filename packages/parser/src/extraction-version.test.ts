import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { extractionVersion, SYMBOL_EXTRACTION_VERSION, SymbolExtractor } from './parser.js';
import type { GrammarId } from './spec.js';

/**
 * One source per grammar exercising containers, methods, nesting and
 * renames. Its extracted symbols (keys, kinds, lines, hashes) are
 * fingerprinted: parse results are cached by blob under
 * SYMBOL_EXTRACTION_VERSION, so a change to what extraction produces must
 * come with a new version, or cached results would be reused stale.
 */
const CORPUS: readonly (readonly [GrammarId, string])[] = [
  [
    'typescript',
    'export class Cart {\n  total(items: number[]): number {\n    return items.length;\n  }\n}\nexport const round = (n: number) => Math.round(n);\ninterface Line { price: number }\n',
  ],
  ['tsx', 'export function App() {\n  return <div />;\n}\n'],
  [
    'javascript',
    '(function () {\n  function inner() {}\n  exports.api = { init() {} };\n}).call(this);\nres.send = function send(body) {\n  return body;\n};\n',
  ],
  [
    'python',
    'class Cart:\n    def total(self, items):\n        return len(items)\n\ndef helper():\n    pass\n',
  ],
  ['go', 'package p\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\nfunc Helper() {}\n'],
  [
    'rust',
    'pub struct Cart;\nimpl Cart {\n    pub fn total(&self) -> u32 { 0 }\n}\nfn helper() {}\n',
  ],
  ['java', 'class A {\n  void f() {}\n  class B { void g() {} }\n}\n'],
  ['csharp', 'namespace N {\n  class A {\n    void F() {}\n  }\n}\n'],
  ['ruby', 'module M\n  class A\n    def f\n    end\n  end\nend\n'],
  ['php', '<?php\nnamespace App;\nclass A {\n  function f() {}\n}\nfunction g() {}\n'],
];

/** Bump SYMBOL_EXTRACTION_VERSION, then update this to the value the test reports. */
const EXPECTED = {
  version: 'symbols@2',
  fingerprint: '8659af4b2580dfec',
};

const extractor = new SymbolExtractor();

afterAll(async () => {
  await extractor.dispose();
});

describe('extraction version', () => {
  it('changes whenever what extraction produces changes', async () => {
    const hash = createHash('sha256');
    for (const [grammar, source] of CORPUS) {
      const result = await extractor.extract(source, grammar, { references: false });
      hash.update(`${grammar}\n${JSON.stringify(result?.symbols ?? null)}\n`);
    }
    expect({
      version: SYMBOL_EXTRACTION_VERSION,
      fingerprint: hash.digest('hex').slice(0, 16),
    }).toEqual(EXPECTED);
  });

  it('includes the grammars, so upgrading one invalidates cached parse results', () => {
    expect(extractionVersion()).toMatch(/^symbols@2\+[0-9a-f]{12}$/);
  });
});
