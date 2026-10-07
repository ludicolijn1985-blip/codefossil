import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

const lines = (...parts: string[]) => `${parts.join('\n')}\n`;

describe('call graph', () => {
  let repo: FixtureRepo | undefined;
  let fossil: FossilDatabase;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
  });

  afterEach(async () => {
    fossil.close();
    await repo?.cleanup();
  });

  const fixture = (): FixtureRepo => {
    if (!repo) throw new Error('fixture repo was not created');
    return repo;
  };

  interface EdgeRow {
    caller: string;
    callee: string;
    level: string;
    confidence: number;
    method: string;
    evidence: number;
  }

  /** Every CALLS edge, ordered by caller and callee. */
  const edges = () =>
    fossil.sqlite
      .prepare(
        `select coalesce(s.qualified_name, f.path) as caller, t.qualified_name as callee,
                r.evidence_type as level, r.confidence as confidence,
                json_extract(r.provenance_json, '$.method') as method,
                json_array_length(r.provenance_json, '$.evidenceIds') as evidence
           from relations r
           left join symbols s on r.source_type = 'symbol' and s.id = r.source_id
           left join files f on r.source_type = 'file' and f.id = r.source_id
           join symbols t on t.id = r.target_id
          where r.relation = 'CALLS'
          order by caller, callee`,
      )
      .all() as EdgeRow[];

  const evidenceOfCalls = () =>
    fossil.sqlite
      .prepare(
        "select id from evidence where json_extract(metadata_json, '$.snapshot') = 'calls' order by id",
      )
      .all();

  const line = (e: EdgeRow) =>
    `${e.caller} -> ${e.callee} [${e.level} ${String(e.confidence)} ${e.method}]`;

  it('resolves calls only where one definition fits, and says how', async () => {
    const r = fixture();
    await r.write(
      'src/utils.ts',
      lines(
        'export function sum(xs: number[]) {',
        '  return xs.reduce((a, b) => a + b, 0);',
        '}',
        'export function map() {',
        '  return 0;',
        '}',
      ),
    );
    await r.write('src/helper.ts', lines('export function helper() {', '  return 1;', '}'));
    await r.write('src/other.ts', lines('export function helper() {', '  return 2;', '}'));
    await r.write(
      'src/response.js',
      lines('res.send = function send(body) {', '  return body;', '};'),
    );
    await r.write(
      'src/cart.ts',
      lines(
        "import * as utils from './utils.js';",
        "import { helper } from './helper.js';",
        'export function round(n: number) {',
        '  return Math.round(n);',
        '}',
        'export class Cart {',
        '  total(items: number[]) {',
        '    this.validate();',
        '    items.map((i) => i);',
        '    return round(utils.sum(items)) + helper();',
        '  }',
        '  validate() {',
        '    return true;',
        '  }',
        '}',
        'export function reply(res: { send(b: string): void }) {',
        "  res.send('ok');",
        '}',
        'round(1);',
      ),
    );
    await r.write(
      'src/both.ts',
      lines(
        "import { helper } from './helper.js';",
        "import { helper as h2 } from './other.js';",
        'export function twice() {',
        '  return helper();',
        '}',
      ),
    );
    await r.commit('Shop');

    const result = await runIndex(fossil.db, r.root, { now });

    expect(edges().map(line)).toEqual([
      'Cart.total -> Cart.validate [DERIVED 1 same-class]',
      'Cart.total -> helper [DERIVED 0.95 import-binding]',
      'Cart.total -> round [DERIVED 1 same-file]',
      'Cart.total -> sum [DERIVED 0.95 import-binding]',
      'reply -> res.send [INFERRED 0.6 qualified-name]',
      'src/cart.ts -> round [DERIVED 1 same-file]',
      // `helper` in both.ts is bound to ./helper.js; ./other.js is bound as `h2`.
      'twice -> helper [DERIVED 0.95 import-binding]',
    ]);
    // `items.map()` reaches no imported `map`: `items` is a parameter, not an import.
    expect(edges().every((e) => e.evidence === 1)).toBe(true);
    expect(result.dependencies).toMatchObject({ callEdges: 7 });
  });

  it('never resolves names that are local, unbound globals, or bound to something else', async () => {
    const r = fixture();
    await r.write(
      'src/lib.ts',
      lines(
        'export function fetch() {',
        '  return 1;',
        '}',
        'export function cb() {',
        '  return 2;',
        '}',
        'export function format() {',
        '  return 3;',
        '}',
      ),
    );
    await r.write(
      'src/app.ts',
      lines(
        "import { cb } from './lib.js';",
        "import { format } from 'date-fns';",
        'export function next() {',
        '  return 0;',
        '}',
        'export function run(next: () => void) {',
        '  next();',
        '  fetch();',
        '  format();',
        '  const cb = () => 1;',
        '  cb();',
        '}',
        'export class Box {',
        '  open() {',
        '    [1].forEach(function () {',
        '      this.close();',
        '    });',
        '  }',
        '  close() {',
        '    return 0;',
        '  }',
        '}',
      ),
    );
    await r.commit('App');

    await runIndex(fossil.db, r.root, { now });

    // `next` is a parameter, `fetch` is the global (not imported), `format` is bound to a
    // package, `cb` is shadowed by a local, and `this` in a nested function is not the Box.
    expect(edges()).toEqual([]);
  });

  it('resolves Python and Go calls through their imports and receivers', async () => {
    const r = fixture();
    await r.write('shop/tax.py', lines('def rate():', '    return 1'));
    await r.write(
      'shop/cart.py',
      lines(
        'from shop.tax import rate as vat',
        'import shop.tax as t',
        '',
        'class Cart:',
        '    def total(self):',
        '        return vat() + t.rate() + self.fee()',
        '',
        '    def fee(self):',
        '        return 1',
      ),
    );
    await r.write('go.mod', lines('module example.com/shop'));
    await r.write(
      'money/money.go',
      lines('package money', '', 'func Round(x int) int {', '\treturn x', '}'),
    );
    await r.write(
      'cart/cart.go',
      lines(
        'package cart',
        '',
        'import "example.com/shop/money"',
        '',
        'type Cart struct{}',
        '',
        'func (c *Cart) Total() int {',
        '\treturn money.Round(c.sum())',
        '}',
        '',
        'func (c *Cart) sum() int {',
        '\treturn 1',
        '}',
      ),
    );
    await r.commit('Shop');

    await runIndex(fossil.db, r.root, { now });

    expect(edges().map(line)).toEqual([
      'Cart.Total -> Cart.sum [DERIVED 1 same-class]',
      'Cart.Total -> Round [DERIVED 0.95 import-binding]',
      'Cart.total -> Cart.fee [DERIVED 1 same-class]',
      'Cart.total -> rate [DERIVED 0.95 import-binding]',
    ]);
  });

  it('resolves Java and PHP calls through imported classes', async () => {
    const r = fixture();
    await r.write(
      'src/main/java/com/acme/tax/Rates.java',
      lines(
        'package com.acme.tax;',
        'public class Rates {',
        '  public static int vat(int x) { return x; }',
        '}',
      ),
    );
    await r.write(
      'src/main/java/com/acme/shop/Cart.java',
      lines(
        'package com.acme.shop;',
        'import com.acme.tax.Rates;',
        'public class Cart {',
        '  public int total(int x) { return Rates.vat(x) + this.fee(); }',
        '  int fee() { return 1; }',
        '}',
      ),
    );
    await r.write(
      'src/Tax/Money.php',
      lines(
        '<?php',
        'namespace App\\Tax;',
        'class Money {',
        '  public static function of($x) { return $x; }',
        '}',
      ),
    );
    await r.write(
      'src/Shop/Till.php',
      lines(
        '<?php',
        'namespace App\\Shop;',
        'use App\\Tax\\Money as M;',
        'class Till {',
        '  public function ring($x) { return M::of($x) + $this->round($x); }',
        '  private function round($x) { return $x; }',
        '}',
      ),
    );
    await r.commit('Shop');

    await runIndex(fossil.db, r.root, { now });

    expect(edges().map(line)).toEqual([
      'Cart.total -> Cart.fee [DERIVED 1 same-class]',
      'Cart.total -> Rates.vat [DERIVED 0.9 import-binding]',
      'Till.ring -> Money.of [DERIVED 0.9 import-binding]',
      'Till.ring -> Till.round [DERIVED 1 same-class]',
    ]);
  });

  it('keeps evidence ids stable across rebuilds and adds no duplicates', async () => {
    const r = fixture();
    await r.write(
      'src/a.ts',
      lines(
        'export function helper() {',
        '  return 1;',
        '}',
        'export function main() {',
        '  return helper();',
        '}',
      ),
    );
    await r.write('src/b.ts', lines('export const b = 1;'));
    await r.commit('Add');
    await runIndex(fossil.db, r.root, { now });
    const before = evidenceOfCalls();

    await r.write('src/b.ts', lines('export const b = 2;'));
    await r.commit('Touch another file');
    await runIndex(fossil.db, r.root, { now });

    expect(evidenceOfCalls()).toEqual(before);
    expect(edges()).toHaveLength(1);
  });

  it('drops edges and their evidence when the call disappears from HEAD', async () => {
    const r = fixture();
    const source = (body: string) =>
      lines(
        'export function helper() {',
        '  return 1;',
        '}',
        'export function main() {',
        body,
        '}',
      );
    await r.write('src/a.ts', source('  return helper();'));
    await r.commit('Add');
    await runIndex(fossil.db, r.root, { now });
    expect(edges().map(line)).toEqual(['main -> helper [DERIVED 1 same-file]']);

    await r.write('src/a.ts', source('  return 2;'));
    await r.commit('Inline');
    await runIndex(fossil.db, r.root, { now });

    expect(edges()).toEqual([]);
    expect(evidenceOfCalls()).toEqual([]);
  });

  it('follows calls through stated types and functions passed by name', async () => {
    const r = fixture();
    await r.write(
      'src/repo.ts',
      lines(
        'export class Repo {',
        '  save() {',
        '    return 1;',
        '  }',
        '}',
        'export const config = { retries: 3 };',
      ),
    );
    await r.write(
      'src/format.ts',
      lines('export function format(n: number) {', '  return String(n);', '}'),
    );
    await r.write(
      'src/cart.ts',
      lines(
        "import { Repo, config } from './repo.js';",
        "import { format } from './format.js';",
        'export class Cart {',
        '  constructor(private repo: Repo) {}',
        '  checkout(items: number[]) {',
        '    this.repo.save();',
        '    const backup = new Repo();',
        '    backup.save();',
        '    return items.map(format).concat([config]);',
        '  }',
        '}',
      ),
    );
    await r.commit('Cart');

    await runIndex(fossil.db, r.root, { now });

    expect(edges().map(line)).toEqual([
      'Cart.checkout -> Repo [DERIVED 0.95 import-binding]',
      'Cart.checkout -> Repo.save [DERIVED 0.855 import-binding+stated-type]',
      // Passed by name: a use, its call inferred. `config` is not a function, so no edge.
      'Cart.checkout -> format [INFERRED 0.8 import-binding+passed-as-value]',
    ]);
    const excerpts = fossil.sqlite
      .prepare(
        "select excerpt from evidence where json_extract(metadata_json, '$.snapshot') = 'calls' order by excerpt",
      )
      .all()
      .map((row) => (row as { excerpt: string }).excerpt);
    // Evidence quotes the call as written.
    expect(excerpts).toEqual(['call Repo', 'call this.repo.save', 'passes format']);
  });
});
