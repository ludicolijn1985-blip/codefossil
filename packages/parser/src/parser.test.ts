import { afterAll, describe, expect, it } from 'vitest';
import { grammarForPath, MAX_SOURCE_LENGTH, SymbolExtractor } from './parser.js';
import type { GrammarId } from './spec.js';

const extractor = new SymbolExtractor();

afterAll(async () => {
  await extractor.dispose();
});

async function keys(grammar: GrammarId, source: string): Promise<string[]> {
  const result = await extractor.extract(source, grammar);
  return result?.symbols.map((s) => `${s.stableKey} L${s.startLine}-${s.endLine}`) ?? [];
}

describe('TypeScript', () => {
  const source = [
    'import { x } from "./x";', // 1
    'export function calculateVAT(amount: number, reduced = false): number {', // 2
    '  function helper() {}', // 3 — local, not a symbol
    '  return amount * 0.21;', // 4
    '}', // 5
    'export const round = (n: number) => Math.round(n);', // 6
    'const RATE = 0.21, OTHER = 1;', // 7
    'export class Cart {', // 8
    '  items: string[] = [];', // 9
    '  total(): number { return 0; }', // 10
    '  static empty() { return new Cart(); }', // 11
    '}', // 12
    'export interface Item { price: number }', // 13
    'export type Id = string;', // 14
    'enum Rate { Standard, Reduced }', // 15
    'namespace Tax { export function apply() {} }', // 16
    'describe("x", () => { function inTest() {} });', // 17 — inside a callback
    'for (let i = 0; i < 1; i++) {}', // 18 — loop variable, not a symbol
    'export default class {}', // 19 — anonymous
  ].join('\n');

  it('extracts module-level definitions with stable keys and line ranges', async () => {
    expect(await keys('typescript', source)).toEqual([
      'function:calculateVAT L2-5',
      'function:round L6-6',
      'variable:RATE L7-7',
      'variable:OTHER L7-7',
      'class:Cart L8-12',
      'property:Cart.items L9-9',
      'method:Cart.total L10-10',
      'method:Cart.empty L11-11',
      'interface:Item L13-13',
      'type:Id L14-14',
      'enum:Rate L15-15',
      'module:Tax L16-16',
      'function:Tax.apply L16-16',
    ]);
  });

  it('records signatures without bodies', async () => {
    const result = await extractor.extract(source, 'typescript');
    const bySymbol = new Map(result?.symbols.map((s) => [s.stableKey, s.signature]));
    expect(bySymbol.get('function:calculateVAT')).toBe(
      'function calculateVAT(amount: number, reduced = false): number',
    );
    expect(bySymbol.get('method:Cart.total')).toBe('total(): number');
    expect(bySymbol.get('function:round')).toBe('round = (n: number) =>');
  });

  it('changes the content hash only when the symbol text changes', async () => {
    const before = await extractor.extract(
      'function a() { return 1; }\nfunction b() {}',
      'typescript',
    );
    const after = await extractor.extract(
      '\n\nfunction a() { return 2; }\nfunction b() {}',
      'typescript',
    );
    const hash = (r: typeof before, key: string) =>
      r?.symbols.find((s) => s.stableKey === key)?.contentHash;
    expect(hash(after, 'function:a')).not.toBe(hash(before, 'function:a'));
    expect(hash(after, 'function:b')).toBe(hash(before, 'function:b'));
  });

  it('disambiguates overloads with an occurrence suffix', async () => {
    expect(
      await keys(
        'typescript',
        'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}',
      ),
    ).toEqual(['function:f L1-1', 'function:f#2 L2-2', 'function:f#3 L3-3']);
  });

  it('flags syntax errors but still extracts what it can', async () => {
    const result = await extractor.extract('function ok() {}\nclass {{{', 'typescript');
    expect(result?.hasSyntaxErrors).toBe(true);
    expect(result?.symbols.map((s) => s.stableKey)).toContain('function:ok');
  });
});

describe('TSX and JavaScript', () => {
  it('parses JSX components', async () => {
    expect(
      await keys(
        'tsx',
        'export function Button({ label }: { label: string }) {\n  return <b>{label}</b>;\n}',
      ),
    ).toEqual(['function:Button L1-3']);
  });

  it('parses JavaScript classes, fields and generators', async () => {
    expect(
      await keys(
        'javascript',
        'class Queue {\n  size = 0;\n  *drain() {}\n}\nfunction* ids() {}\nmodule.exports = { Queue };',
      ),
    ).toEqual([
      'class:Queue L1-4',
      'property:Queue.size L2-2',
      'method:Queue.drain L3-3',
      'function:ids L5-5',
    ]);
  });
});

describe('Python', () => {
  it('extracts functions, classes and methods but not nested functions', async () => {
    const source = [
      'import os',
      'def load(path):',
      '    def inner():',
      '        pass',
      '    return inner',
      '',
      'class Invoice:',
      '    @property',
      '    def total(self):',
      '        return 0',
      '    class Line:',
      '        def amount(self): pass',
    ].join('\n');
    expect(await keys('python', source)).toEqual([
      'function:load L2-5',
      'class:Invoice L7-12',
      'method:Invoice.total L9-10',
      'class:Invoice.Line L11-12',
      'method:Invoice.Line.amount L12-12',
    ]);
  });
});

describe('Go', () => {
  it('qualifies methods by receiver and classifies type specs', async () => {
    const source = [
      'package server',
      'type Server struct{ addr string }',
      'type Handler interface{ Serve() }',
      'type Port int',
      'func New() *Server { return &Server{} }',
      'func (s *Server) Start() error { return nil }',
      'func (s Server) Addr() string { f := func() {}; _ = f; return s.addr }',
    ].join('\n');
    expect(await keys('go', source)).toEqual([
      'struct:Server L2-2',
      'interface:Handler L3-3',
      'type:Port L4-4',
      'function:New L5-5',
      'method:Server.Start L6-6',
      'method:Server.Addr L7-7',
    ]);
  });
});

describe('Rust', () => {
  it('extracts items and qualifies impl and trait members', async () => {
    const source = [
      'pub struct Cart { items: Vec<u32> }',
      'pub enum Rate { Standard, Reduced }',
      'pub trait Priced { fn price(&self) -> u32; }',
      'impl Cart {',
      '    pub fn total(&self) -> u32 { let f = |x: u32| x; f(0) }',
      '}',
      'impl Priced for Cart { fn price(&self) -> u32 { 0 } }',
      'mod tax { pub fn apply() {} }',
      'const RATE: u32 = 21;',
      'fn main() {}',
    ].join('\n');
    expect(await keys('rust', source)).toEqual([
      'struct:Cart L1-1',
      'enum:Rate L2-2',
      'trait:Priced L3-3',
      'method:Priced.price L3-3',
      'impl:Cart L4-6',
      'method:Cart.total L5-5',
      'impl:Cart#2 L7-7',
      'method:Cart.price L7-7',
      'module:tax L8-8',
      'function:tax.apply L8-8',
      'variable:RATE L9-9',
      'function:main L10-10',
    ]);
  });
});

describe('robustness against hostile input', () => {
  it('survives deeply nested source without overflowing the stack', async () => {
    const depth = 100_000;
    const source = `${'['.repeat(depth)}${']'.repeat(depth)};\nfunction after() {}\n`;
    const result = await extractor.extract(source, 'javascript');
    expect(result?.symbols.map((s) => s.stableKey)).toEqual(['function:after']);
  });
});

describe('members defined through values', () => {
  it('finds methods of object literals and class expressions', async () => {
    expect(
      await keys(
        'typescript',
        [
          'export const api = {',
          '  init() {},',
          '  helper: () => { function hidden() {} },',
          '};',
          'export const Store = class { load() {} };',
        ].join('\n'),
      ),
    ).toEqual([
      'variable:api L1-4',
      'method:api.init L2-2',
      'class:Store L5-5',
      'method:Store.load L5-5',
    ]);
  });
});

describe('functions assigned to properties (CommonJS and prototype style)', () => {
  it('names them by the object they are assigned to', async () => {
    const source = [
      'var res = Object.create(http.ServerResponse.prototype);', // 1
      'res.send = function send(body) {', // 2
      '  var local = function () {};', // 3 — inside a function: not a symbol
      '};', // 4
      'res.contentType = res.type = function contentType(type) {};', // 5
      'Cart.prototype.total = function () { return 0; };', // 6
      'exports.compileETag = function (value) {};', // 7
      'module.exports.handler = async (event) => event;', // 8
      'app.settings = {};', // 9 — not a function
      'exports = module.exports = createApplication;', // 10 — not a definition
      'if (x) { res.hidden = function () {}; }', // 11 — not at module level
    ].join('\n');
    expect(await keys('javascript', source)).toEqual([
      'variable:res L1-1',
      'method:res.send L2-4',
      'method:res.contentType L5-5',
      'method:res.type L5-5',
      'method:Cart.total L6-6',
      'function:compileETag L7-7',
      'function:handler L8-8',
    ]);
  });
});

describe('Rust impl identity', () => {
  it('ignores generic parameter names, so renaming them keeps the key', async () => {
    const before = await keys('rust', 'impl<T> Stack<T> { fn push(&mut self) {} }');
    const after = await keys('rust', 'impl<U> Stack<U> { fn push(&mut self) {} }');
    expect(before).toEqual(['impl:Stack L1-1', 'method:Stack.push L1-1']);
    expect(after).toEqual(before);
  });
});

describe('limits and grammar selection', () => {
  it('skips sources larger than the limit', async () => {
    expect(await extractor.extract('x'.repeat(MAX_SOURCE_LENGTH + 1), 'typescript')).toBeNull();
  });

  it.each([
    ['src/a.ts', 'typescript'],
    ['src/types.d.ts', 'typescript'],
    ['App.tsx', 'tsx'],
    ['lib/x.cjs', 'javascript'],
    ['tool.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['README.md', null],
    ['Makefile', null],
  ])('%s uses %s', (path, grammar) => {
    expect(grammarForPath(path)).toBe(grammar);
  });
});

describe('modules wrapped in a function (IIFE and UMD)', () => {
  it('treats the wrapper body as module level', async () => {
    const iife = [
      '(function () {',
      '  function helper() {}',
      '  var VERSION = "1";',
      '  exports.parse = function parse() {};',
      '  Lib.prototype.run = function () {};',
      '  function outer() {',
      '    function local() {}',
      '  }',
      '})();',
    ].join('\n');
    expect(await keys('javascript', iife)).toEqual([
      'function:helper L2-2',
      'variable:VERSION L3-3',
      'function:parse L4-4',
      'method:Lib.run L5-5',
      'function:outer L6-8',
    ]);
    expect(await keys('javascript', '!function () {\n  function bang() {}\n}();\n')).toEqual([
      'function:bang L2-2',
    ]);
    expect(
      await keys('javascript', '(function () {\n  function called() {}\n}).call(this);\n'),
    ).toEqual(['function:called L2-2']);
  });

  it('reads the factory of a UMD module', async () => {
    const umd = [
      '(function (root, factory) {',
      '  if (typeof define === "function") define([], factory);',
      '  else root.lib = factory();',
      '})(this, function () {',
      '  function slugify(s) { return s; }',
      '  return { slugify: slugify };',
      '});',
    ].join('\n');
    expect(await keys('javascript', umd)).toEqual(['function:slugify L5-5']);
  });

  it('keeps functions inside ordinary calls and callbacks local', async () => {
    expect(
      await keys('javascript', 'setup(function () {\n  function inCallback() {}\n});\n'),
    ).toEqual([]);
    expect(
      await keys(
        'javascript',
        'function f() {\n  (function () {\n    function nested() {}\n  })();\n}\n',
      ),
    ).toEqual(['function:f L1-5']);
  });
});
