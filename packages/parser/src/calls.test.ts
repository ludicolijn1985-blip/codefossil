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
      ['total', 'method:Cart.checkout', 9],
      ['*.listen', null, 12],
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
