import { afterAll, describe, expect, it } from 'vitest';
import { SymbolExtractor } from './parser.js';
import type { GrammarId } from './spec.js';

const extractor = new SymbolExtractor();

afterAll(async () => {
  await extractor.dispose();
});

async function calls(grammar: GrammarId, source: string) {
  const result = await extractor.extract(source, grammar);
  return result?.calls.map(({ callee, caller, line }) => [callee.join('.'), caller, line]);
}

describe('call extraction', () => {
  it('finds JavaScript calls with their callee path and calling symbol', async () => {
    const source = [
      "const utils = require('./utils');",
      'function total(items) {',
      '  const sum = utils.sum(items.map((i) => price(i)));',
      '  return round(sum) + round(1);',
      '}',
      'class Cart {',
      '  checkout() {',
      '    this.validate();',
      '    return new Receipt(total(this.items));',
      '  }',
      '}',
      'app.get("/", handler).listen(3000);',
      'getApp().start();',
    ].join('\n');

    expect(await calls('javascript', source)).toEqual([
      ['utils.sum', 'function:total', 3],
      ['items.map', 'function:total', 3],
      ['price', 'function:total', 3],
      ['round', 'function:total', 4],
      ['this.validate', 'method:Cart.checkout', 8],
      ['Receipt', 'method:Cart.checkout', 9],
      // Passed by name, not called: kept as references.
      ['this.items', 'method:Cart.checkout', 9],
      ['total', 'method:Cart.checkout', 9],
      ['*.listen', null, 12],
      ['handler', null, 12],
      ['app.get', null, 12],
      ['*.start', null, 13],
      ['getApp', null, 13],
    ]);
  });

  it('finds Python, Go and Rust calls', async () => {
    expect(
      await calls(
        'python',
        'def report(rows):\n    return format_rows(self.clean(rows))\n\nprint(report([]))\n',
      ),
    ).toEqual([
      ['format_rows', 'function:report', 2],
      ['self.clean', 'function:report', 2],
      ['print', null, 4],
      ['report', null, 4],
    ]);
    expect(
      await calls(
        'go',
        'package app\n\nfunc (s *Server) Start() {\n\ts.listen()\n\thttp.ListenAndServe(":80", nil)\n}\n',
      ),
    ).toEqual([
      ['s.listen', 'method:Server.Start', 4],
      ['http.ListenAndServe', 'method:Server.Start', 5],
    ]);
    expect(
      await calls(
        'rust',
        'impl Cart {\n    fn total(&self) -> u32 {\n        tax::apply(self.sum())\n    }\n}\n',
      ),
    ).toEqual([
      ['tax.apply', 'method:Cart.total', 3],
      ['self.sum', 'method:Cart.total', 3],
    ]);
  });
});

describe('local names and self in calls', () => {
  async function flags(grammar: GrammarId, source: string) {
    const result = await extractor.extract(source, grammar);
    return result?.calls.map(
      ({ callee, self, local }) =>
        `${callee.join('.')}${self ? ' self' : ''}${local ? ' local' : ''}`,
    );
  }

  it('marks parameters, variables and inner functions as local, and only real `this` as self', async () => {
    const source = [
      'function helper() {}',
      'function run(cb, { opt }) {',
      '  cb();',
      '  helper();',
      '  const fmt = makeFormatter();',
      '  fmt.format();',
      '  function inner() {}',
      '  inner();',
      '  opt.go();',
      '}',
      'class Cart {',
      '  total() {',
      '    this.validate();',
      '    items.forEach(function () { this.oops(); });',
      '    items.forEach(() => this.ok());',
      '  }',
      '}',
      'Cart.prototype.save = function () { this.persist(); };',
    ].join('\n');
    expect(await flags('javascript', source)).toEqual([
      'cb local',
      'helper',
      'makeFormatter',
      'fmt.format local',
      'inner local',
      'opt.go local',
      'this.validate self',
      'items.forEach',
      'this.oops',
      'this.ok self',
      'this.persist self',
    ]);
  });

  it('recognises Python self, Go receivers and Rust self', async () => {
    expect(
      await flags(
        'python',
        'class A:\n    def m(self, x):\n        self.n()\n        x.y()\n\ndef f(self):\n    pass\n',
      ),
    ).toEqual(['self.n self', 'x.y local']);
    expect(
      await flags(
        'go',
        'package a\n\nfunc (s *Server) Start(c Conf) {\n\ts.listen()\n\tc.check()\n}\n',
      ),
      // `c Conf` states its type, so the call reads as Conf.check.
    ).toEqual(['s.listen self', 'Conf.check']);
    expect(
      await flags(
        'rust',
        'impl A {\n    fn m(&self, v: V) {\n        self.n();\n        v.w();\n    }\n}\nfn free() {\n    helper();\n}\n',
      ),
    ).toEqual(['self.n self', 'v.w local', 'helper']);
  });

  const sites = async (grammar: GrammarId, source: string) =>
    (await extractor.extract(source, grammar))?.calls.map(
      ({ callee, caller, via, written }) =>
        `${caller ?? '-'} ${callee.join('.')}${via ? ` (${via}${written ? ` ${written}` : ''})` : ''}`,
    );

  it('reads calls through names whose TypeScript type is stated', async () => {
    const source = [
      'const shared = new Cache();',
      'class Cart {',
      '  private db: Db;',
      '  constructor(private repo: Repo) {',
      '    this.log = new Logger();',
      '  }',
      '  total(rates: m.Rates) {',
      '    const tax = new Tax();',
      '    tax.apply(rates.vat());',
      '    this.repo.save();',
      '    this.log.info();',
      '    this.db.query();',
      '    shared.get();',
      '    this.refresh();',
      '  }',
      '}',
    ].join('\n');

    expect(await sites('typescript', source)).toEqual([
      'variable:shared Cache',
      'method:Cart.constructor Logger',
      'method:Cart.total Tax',
      'method:Cart.total Tax.apply (type tax.apply)',
      'method:Cart.total m.Rates.vat (type rates.vat)',
      'method:Cart.total Repo.save (type this.repo.save)',
      'method:Cart.total Logger.info (type this.log.info)',
      'method:Cart.total Db.query (type this.db.query)',
      'method:Cart.total Cache.get (type shared.get)',
      'method:Cart.total this.refresh',
    ]);
  });

  it('reads Python calls through constructed and annotated names', async () => {
    const source = [
      'class Cart:',
      '    def __init__(self, repo: Repo):',
      '        self.log = Logger()',
      '        self.repo = repo',
      '    def total(self):',
      '        r = Rates()',
      '        r.vat()',
      '        self.log.info()',
      '        sorted(self.items, key=len)',
      '        map(fmt, [])',
    ].join('\n');

    expect(await sites('python', source)).toEqual([
      'method:Cart.__init__ Logger',
      'method:Cart.total Rates',
      'method:Cart.total Rates.vat (type r.vat)',
      'method:Cart.total Logger.info (type self.log.info)',
      'method:Cart.total self.items (reference)',
      'method:Cart.total sorted',
      'method:Cart.total fmt (reference)',
      'method:Cart.total map',
    ]);
  });

  it('does not trust a stated type that a shadowing declaration or another callback may hide', async () => {
    const source = [
      'function f(items) {',
      '  const item = new Item();',
      '  items.forEach((item) => item.save());',
      '}',
      "app.get('/a', (req) => {",
      '  const store = new MemStore();',
      '  store.get();',
      '});',
      "app.get('/b', (req) => {",
      '  const store = req.store;',
      '  store.get();',
      '});',
    ].join('\n');

    expect(await sites('javascript', source)).toEqual([
      'function:f Item',
      'function:f items.forEach',
      // `item` is declared twice in f: the callback's parameter may be the one called.
      'function:f item.save',
      '- app.get',
      '- MemStore',
      // Declared inside callbacks, not at module level: no type for `store`.
      '- store.get',
    ]);
  });

  it('reads Java, C# and Go calls through stated types', async () => {
    expect(
      await sites(
        'java',
        [
          'class Cart {',
          '  private Repo repo = new Repo();',
          '  void total(Rates r) {',
          '    var tax = new Tax();',
          '    r.vat();',
          '    tax.apply();',
          '    repo.save();',
          '    this.repo.load();',
          '  }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'class:Cart Repo',
      'method:Cart.total Tax',
      'method:Cart.total Rates.vat (type r.vat)',
      'method:Cart.total Tax.apply (type tax.apply)',
      // A field used without `this.`.
      'method:Cart.total Repo.save (type repo.save)',
      'method:Cart.total Repo.load (type this.repo.load)',
    ]);
    expect(
      await sites(
        'csharp',
        [
          'class Cart {',
          '  Repo Store { get; set; }',
          '  void Total(Rates r) {',
          '    var tax = new Tax();',
          '    r.Vat();',
          '    tax.Apply();',
          '    Store.Save();',
          '  }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'method:Cart.Total Tax',
      'method:Cart.Total Rates.Vat (type r.Vat)',
      'method:Cart.Total Tax.Apply (type tax.Apply)',
      'method:Cart.Total Repo.Save (type Store.Save)',
    ]);
    expect(
      await sites(
        'go',
        [
          'package p',
          'type Server struct { db *sql.DB }',
          'func (s *Server) Start(r *Rates) {',
          '\tt := Tax{}',
          '\tvar w Worker',
          '\tr.Vat()',
          '\tt.Apply()',
          '\tw.Run()',
          '\ts.db.Query()',
          '}',
        ].join('\n'),
      ),
    ).toEqual([
      'method:Server.Start Rates.Vat (type r.Vat)',
      'method:Server.Start Tax.Apply (type t.Apply)',
      'method:Server.Start Worker.Run (type w.Run)',
      'method:Server.Start sql.DB.Query (type s.db.Query)',
    ]);
  });

  it('does not keep locals passed by name, which name no definition', async () => {
    expect(await sites('javascript', 'function f(cb, xs) {\n  xs.forEach(cb);\n}\n')).toEqual([
      'function:f xs.forEach',
    ]);
  });
});
