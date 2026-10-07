import { afterAll, describe, expect, it } from 'vitest';
import { grammarForPath, SymbolExtractor } from './parser.js';
import type { GrammarId } from './spec.js';

const extractor = new SymbolExtractor();

afterAll(async () => {
  await extractor.dispose();
});

async function read(grammar: GrammarId, source: string) {
  const result = await extractor.extract(source, grammar);
  if (!result) throw new Error('no result');
  return {
    symbols: result.symbols.map((s) => s.stableKey),
    calls: result.calls.map(
      (c) =>
        `${c.caller ?? '-'} > ${c.callee.join('.')}${c.self ? ' self' : ''}${c.local ? ' local' : ''}`,
    ),
    imports: result.imports.map(
      (i) =>
        `${i.kind} ${i.specifier}${i.bindings ? ` [${i.bindings.map((b) => `${b.local}=${b.imported}`).join(' ')}]` : ''}`,
    ),
  };
}

describe('Java, C#, Ruby and PHP', () => {
  it('maps their file extensions to grammars', () => {
    expect(['A.java', 'A.cs', 'a.rb', 'a.php'].map(grammarForPath)).toEqual([
      'java',
      'csharp',
      'ruby',
      'php',
    ]);
  });

  it('reads Java classes, members, calls and imports', async () => {
    const source = [
      'package com.acme.shop;',
      'import com.acme.tax.Rates;',
      'import static java.lang.Math.max;',
      'import com.acme.util.*;',
      'public class Cart {',
      '  public Cart(int n) { this.init(n); }',
      '  public int total(Item item) {',
      '    int y = Rates.vat(item.price());',
      '    new Thread(new Runnable() { public void run() { this.go(); } });',
      '    return this.round(y) + max(y, 0);',
      '  }',
      '  private void init(int n) {}',
      '  enum Kind { A; String label() { return "a"; } }',
      '}',
    ].join('\n');
    expect(await read('java', source)).toEqual({
      symbols: [
        'class:Cart',
        'method:Cart.Cart',
        'method:Cart.total',
        'method:Cart.init',
        'enum:Cart.Kind',
        'method:Cart.Kind.label',
      ],
      calls: [
        'method:Cart.Cart > this.init self',
        'method:Cart.total > Rates.vat',
        'method:Cart.total > item.price local',
        'method:Cart.total > Thread',
        'method:Cart.total > Runnable',
        'method:Cart.total > this.go',
        'method:Cart.total > this.round self',
        'method:Cart.total > max',
      ],
      imports: [
        'import com.acme.tax.Rates [Rates=Rates]',
        'import java.lang.Math [max=Math.max]',
        'import com.acme.util.*',
      ],
    });
  });

  it('reads C# types, members, calls and usings', async () => {
    const source = [
      'using System.Linq;',
      'using Acme.Tax;',
      'namespace Acme.Shop {',
      '  public class Cart {',
      '    public Cart(int n) { this.Init(n); }',
      '    public int Count { get; set; }',
      '    public int Total(Item item) { return Rates.Vat(item.Price) + this.Round(1) + Helper(); }',
      '    void Init(int n) {}',
      '  }',
      '  interface ITotals { int Total(Item item); }',
      '}',
    ].join('\n');
    expect(await read('csharp', source)).toEqual({
      symbols: [
        'class:Cart',
        'method:Cart.Cart',
        'property:Cart.Count',
        'method:Cart.Total',
        'method:Cart.Init',
        'interface:ITotals',
        'method:ITotals.Total',
      ],
      calls: [
        'method:Cart.Cart > this.Init self',
        'method:Cart.Total > Rates.Vat',
        'method:Cart.Total > this.Round self',
        'method:Cart.Total > Helper',
      ],
      imports: ['import System.Linq', 'import Acme.Tax'],
    });
  });

  it('reads Ruby classes, modules, calls and requires', async () => {
    const source = [
      "require 'json'",
      "require_relative 'tax/rates'",
      'module Shop',
      '  class Cart < Base',
      '    attr_reader :items',
      '    def total(item)',
      '      Rates.vat(item.price) + self.round(1) + helper',
      '    end',
      '    def self.build',
      '      new(1)',
      '    end',
      '  end',
      'end',
    ].join('\n');
    expect(await read('ruby', source)).toEqual({
      symbols: [
        'module:Shop',
        'class:Shop.Cart',
        'method:Shop.Cart.total',
        'method:Shop.Cart.build',
      ],
      calls: [
        'method:Shop.Cart.total > Rates.vat',
        'method:Shop.Cart.total > item.price local',
        'method:Shop.Cart.total > self.round self',
        'method:Shop.Cart.build > new',
      ],
      imports: ['require json', 'require ./tax/rates'],
    });
  });

  it('reads PHP classes, functions, calls, uses and requires', async () => {
    const source = [
      '<?php',
      'namespace App\\Shop;',
      'use App\\Tax\\Rates;',
      'use App\\Util\\Money as M;',
      "require_once __DIR__ . '/helpers.php';",
      'function helper($x) { return $x; }',
      'class Cart {',
      '  public function total($item) {',
      '    return Rates::vat($item->price()) + $this->round(1) + self::fee() + helper(1) + M::of(2);',
      '  }',
      '  public static function fee() { return 1; }',
      '}',
    ].join('\n');
    expect(await read('php', source)).toEqual({
      symbols: ['function:helper', 'class:Cart', 'method:Cart.total', 'method:Cart.fee'],
      calls: [
        'method:Cart.total > Rates.vat',
        'method:Cart.total > item.price local',
        'method:Cart.total > this.round self',
        'method:Cart.total > self.fee self',
        'method:Cart.total > helper',
        'method:Cart.total > M.of',
      ],
      imports: [
        'import App\\Tax\\Rates [Rates=Rates]',
        'import App\\Util\\Money [M=Money]',
        'require ./helpers.php',
      ],
    });
  });
});
