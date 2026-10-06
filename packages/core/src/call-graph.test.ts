import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

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

  /** Every CALLS edge as `caller -> callee [LEVEL confidence method]`. */
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
      .all() as {
      caller: string;
      callee: string;
      level: string;
      confidence: number;
      method: string;
      evidence: number;
    }[];

  const line = (e: ReturnType<typeof edges>[number]) =>
    `${e.caller} -> ${e.callee} [${e.level} ${String(e.confidence)} ${e.method}]`;

  it('resolves calls only where one definition fits, and says how', async () => {
    const r = fixture();
    await r.write(
      'src/utils.ts',
      'export function sum(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n' +
        'export function map() {\n  return 0;\n}\n',
    );
    await r.write('src/helper.ts', 'export function helper() {\n  return 1;\n}\n');
    await r.write('src/other.ts', 'export function helper() {\n  return 2;\n}\n');
    await r.write('src/response.js', 'res.send = function send(body) {\n  return body;\n};\n');
    await r.write(
      'src/cart.ts',
      [
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
      ].join('\n'),
    );
    await r.write(
      'src/both.ts',
      "import { helper } from './helper.js';\nimport { helper as h2 } from './other.js';\n" +
        'export function twice() {\n  return helper();\n}\n',
    );
    await r.commit('Shop');

    const result = await runIndex(fossil.db, r.root, { now });

    expect(edges().map(line)).toEqual([
      'Cart.total -> Cart.validate [DERIVED 1 same-class]',
      'Cart.total -> helper [DERIVED 0.9 imported-file-name]',
      'Cart.total -> round [DERIVED 1 same-file]',
      'Cart.total -> sum [DERIVED 0.8 imported-module-member]',
      'reply -> res.send [INFERRED 0.6 qualified-name]',
      'src/cart.ts -> round [DERIVED 1 same-file]',
    ]);
    // `items.map()` is not the imported `map`, and `helper()` in both.ts has two candidates.
    expect(edges().every((e) => e.evidence === 1)).toBe(true);
    expect(result.dependencies).toMatchObject({ callEdges: 6 });
  });

  it('drops edges when the call disappears from HEAD', async () => {
    const r = fixture();
    await r.write(
      'src/a.ts',
      'export function helper() {\n  return 1;\n}\nexport function main() {\n  return helper();\n}\n',
    );
    await r.commit('Add');
    await runIndex(fossil.db, r.root, { now });
    expect(edges().map(line)).toEqual(['main -> helper [DERIVED 1 same-file]']);

    await r.write(
      'src/a.ts',
      'export function helper() {\n  return 1;\n}\nexport function main() {\n  return 2;\n}\n',
    );
    await r.commit('Inline');
    await runIndex(fossil.db, r.root, { now });

    expect(edges()).toEqual([]);
  });
});
