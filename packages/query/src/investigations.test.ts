import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIndex } from '@codefossil/core';
import {
  dependenciesByName,
  findFileByPath,
  IN_MEMORY,
  issueOrPullRequestByNumber,
  openDatabase,
  symbolsByName,
  type FossilDatabase,
} from '@codefossil/db';
import {
  createFixtureRepo,
  createSampleHistory,
  type FixtureRepo,
  type SampleHistory,
} from '@codefossil/git/testing';
import type { EntityRef } from '@codefossil/shared';
import { analyzeImpact, isTestPath } from './impact.js';
import { parseQuestion } from './question.js';
import { buildScenario, now } from './scenario.fixture.js';
import { buildTimeline } from './timeline.js';
import { investigateWhy } from './why.js';

describe('investigations on the ARCHITECTURE.md scenario', () => {
  let repo: FixtureRepo | undefined;
  let fossil: FossilDatabase;
  let scenario: Awaited<ReturnType<typeof buildScenario>>;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    scenario = await buildScenario(repo, fossil);
  });

  afterAll(async () => {
    fossil.close();
    await repo?.cleanup();
  });

  const symbol = (name: string): EntityRef => {
    const [row] = symbolsByName(fossil.db, scenario.repositoryId, name);
    if (!row) throw new Error(`symbol ${name} not indexed`);
    return { type: 'symbol', id: row.id };
  };
  const file = (path: string): EntityRef => {
    const row = findFileByPath(fossil.db, scenario.repositoryId, path);
    if (!row) throw new Error(`${path} not indexed`);
    return { type: 'file', id: row.id };
  };
  const work = (number: number): EntityRef => {
    const [row] = issueOrPullRequestByNumber(fossil.db, scenario.repositoryId, number);
    if (!row) throw new Error(`#${number} not synced`);
    return { type: row.type, id: row.id };
  };
  const short = (sha: string) => sha.slice(0, 7);

  it('explains a symbol from definition to motivating issue, statement by statement', () => {
    const why = investigateWhy(fossil.db, scenario.repositoryId, symbol('calculateVAT'));

    expect(why.statements.map((s) => `${s.level} ${s.confidence.toFixed(2)} ${s.text}`)).toEqual([
      'FACT 1.00 function calculateVAT is defined in src/payment/vat.ts at lines 2–4.',
      `DERIVED 1.00 It was introduced in commit ${short(scenario.implementation)} "Add calculateVAT" by Ada Lovelace on 2026-01-01.`,
      'FACT 1.00 It is part of pull request #421 "Calculate VAT", merged on 2026-01-02.',
      'DERIVED 0.90 Pull request #421 resolves issue #398 "VAT missing on invoices" (closing keyword; confidence 0.90).',
      `DERIVED 1.00 It changed 1 time since, most recently in commit ${short(scenario.rounding)} "Round VAT" by Ada Lovelace on 2026-01-01.`,
    ]);
    // Never more certain than the weakest statement.
    expect(why.confidence).toBeCloseTo(0.9);
    expect(why.classification).toBe('DERIVED');
    expect(why.answer).toContain('It was introduced in commit');
    expect(why.question).toBe('Why does function calculateVAT (src/payment/vat.ts:2) exist?');
    expect(why.caveats).toEqual([]);

    const reasons = why.evidence.map((e) => `${e.type}: ${e.reason}`);
    // The current definition and the latest change rest on the same AST observation.
    expect(reasons).toEqual([
      'ast_node: definition; later changes',
      'ast_node: introducing commit',
      'commit: introducing commit',
      'pull_request: pull request carrying the change; resolved issue',
    ]);
    expect(why.evidence.every((e) => e.locator.length > 0)).toBe(true);
  });

  it('explains a file created without a pull request', () => {
    const why = investigateWhy(fossil.db, scenario.repositoryId, file('src/checkout.ts'));
    expect(why.statements.map((s) => s.text)).toEqual([
      'src/checkout.ts exists at HEAD.',
      expect.stringMatching(
        /^It was created in commit [0-9a-f]{7} "Add payment module" by Ada Lovelace on 2026-01-01\.$/,
      ),
      'It has not changed since.',
    ]);
    expect(why).toMatchObject({ confidence: 1, classification: 'FACT' });
  });

  it('explains issues, pull requests and dependencies', () => {
    const issue = investigateWhy(fossil.db, scenario.repositoryId, work(398));
    expect(issue.statements.map((s) => s.text)).toEqual([
      'Issue #398 "VAT missing on invoices" is closed.',
      'It is resolved by PR #421 Calculate VAT (closing keyword; confidence 0.90).',
    ]);

    const pr = investigateWhy(fossil.db, scenario.repositoryId, work(421));
    expect(pr.statements.map((s) => s.role)).toEqual([
      'the pull request',
      'implementing commits',
      'resolved issue',
    ]);

    const [zod] = dependenciesByName(fossil.db, scenario.repositoryId, 'zod');
    const dependency = investigateWhy(fossil.db, scenario.repositoryId, {
      type: 'dependency',
      id: zod?.id ?? 0,
    });
    expect(dependency.statements.map((s) => s.text)).toEqual([
      'npm:zod@^4.0.0 is declared as a runtime dependency.',
      '1 file imports it: src/api.ts.',
    ]);
    expect(dependency.caveats[0]).toMatch(/dependency history is not indexed/);
  });

  it('measures impact with distances, routes and tests', () => {
    const impact = analyzeImpact(fossil.db, scenario.repositoryId, symbol('calculateVAT'));
    expect(impact.definedIn?.label).toBe('src/payment/vat.ts');
    expect(impact.direct.map((d) => d.label)).toEqual(['src/checkout.ts']);
    expect(
      impact.transitive.map(
        (d) => `${d.label} via ${d.via.join(' > ')}${d.isTest ? ' (test)' : ''}`,
      ),
    ).toEqual([
      'src/api.ts via src/checkout.ts',
      'src/checkout.test.ts via src/checkout.ts (test)',
    ]);
    expect(impact.answer).toBe(
      'No call to it was resolved. 1 file depends on function calculateVAT (src/payment/vat.ts:2) directly and 2 transitively (1 of them tests).',
    );
    expect(impact.callers).toEqual({ direct: [], transitive: [] });
    expect(impact.caveats[0]).toMatch(/^Calls are resolved at HEAD only where one definition fits/);
    expect(impact.caveats[1]).toMatch(/^Files are counted when they import/);
    expect(impact.direct[0]?.evidenceIds.length).toBeGreaterThan(0);
  });

  it('reports no dependents plainly', () => {
    const impact = analyzeImpact(fossil.db, scenario.repositoryId, file('src/api.ts'));
    expect(impact.answer).toBe('Nothing in the index depends on src/api.ts.');
    expect(impact.direct).toEqual([]);
  });
});

describe('timelines and missing origins', () => {
  let sample: SampleHistory | undefined;
  let fossil: FossilDatabase;
  let repositoryId: number;

  beforeAll(async () => {
    sample = await createSampleHistory();
    fossil = openDatabase(IN_MEMORY);
    repositoryId = (await runIndex(fossil.db, sample.repo.root, { now })).repositoryId;
  });

  afterAll(async () => {
    fossil.close();
    await sample?.repo.cleanup();
  });

  const fileId = (path: string) => findFileByPath(fossil.db, repositoryId, path)?.id ?? 0;

  it('follows a file across its rename, with the symbols each commit changed', () => {
    const timeline = buildTimeline(fossil.db, repositoryId, fileId('src/tax/vat.ts'));
    expect(timeline.paths).toEqual(['src/tax/vat.ts', 'src/payment/vat.ts']);
    expect(
      timeline.entries.map((e) => `${e.change} ${e.path} "${e.subject}" [${e.symbols.join(', ')}]`),
    ).toEqual([
      'added src/payment/vat.ts "Add VAT calculation" [calculateVAT]',
      'modified src/payment/vat.ts "Handle reduced VAT rate" [calculateVAT]',
      'renamed src/tax/vat.ts "Move VAT into tax module" []',
    ]);
    expect(timeline.entries[2]?.previousPath).toBe('src/payment/vat.ts');
  });

  it('names a renamed file’s original path and its rename in why', () => {
    const why = investigateWhy(fossil.db, repositoryId, {
      type: 'file',
      id: fileId('src/tax/vat.ts'),
    });
    expect(why.statements.map((s) => s.text)).toEqual([
      'src/tax/vat.ts exists at HEAD.',
      expect.stringMatching(
        /^It was created as src\/payment\/vat\.ts in commit [0-9a-f]{7} "Add VAT calculation"/,
      ),
      expect.stringMatching(
        /^It was renamed from src\/payment\/vat\.ts to src\/tax\/vat\.ts in commit [0-9a-f]{7} "Move VAT into tax module"/,
      ),
      expect.stringMatching(
        /^It changed 1 time since, most recently in commit [0-9a-f]{7} "Handle reduced VAT rate"/,
      ),
    ]);
  });

  it('quotes the commit message as the stated reason', () => {
    const [vat] = symbolsByName(fossil.db, repositoryId, 'calculateVAT');
    const why = investigateWhy(fossil.db, repositoryId, { type: 'commit', id: 0 });
    expect(why.caveats).toEqual(['The entity no longer exists in the index.']);

    const history = buildTimeline(fossil.db, repositoryId, fileId('src/tax/vat.ts'));
    const reduced = history.entries[1];
    const commitWhy = investigateWhy(fossil.db, repositoryId, {
      type: 'commit',
      id: findCommitId(reduced?.sha ?? ''),
    });
    expect(commitWhy.statements.map((s) => s.text)).toContain(
      'Its commit message explains: "Workaround for legacy invoices. Fixes #12"',
    );
    expect(vat).toBeDefined();
  });

  const findCommitId = (sha: string): number =>
    fossil.sqlite.prepare('SELECT id FROM commits WHERE sha = ?').pluck().get(sha) as number;

  it('states the absence of origin evidence instead of guessing', async () => {
    const other = openDatabase(IN_MEMORY);
    try {
      const { repositoryId: id } = await runIndex(other.db, sample?.repo.root ?? '', {
        now,
        since: new Date('2026-01-01T10:00:00Z'),
      });
      const [vat] = symbolsByName(other.db, id, 'calculateVAT');
      const why = investigateWhy(other.db, id, { type: 'symbol', id: vat?.id ?? 0 });
      expect(why.statements[1]?.text).toMatch(
        /^The indexed history does not show where it was introduced/,
      );
      expect(why.caveats).toContain('No introducing commit is recorded for this symbol.');
    } finally {
      other.close();
    }
  });
});

describe('parseQuestion', () => {
  it.each([
    ['Why does calculateVAT exist?', 'why', 'calculateVAT'],
    ['why is `src/tax/vat.ts` here', 'why', 'src/tax/vat.ts'],
    ['What is Cart.total for?', 'why', 'Cart.total'],
    ['What depends on src/payment/vat.ts?', 'impact', 'src/payment/vat.ts'],
    ['Who uses npm:zod', 'impact', 'npm:zod'],
    ['what breaks if I change calculateVAT', 'impact', 'calculateVAT'],
    ['History of src/tax/vat.ts', 'timeline', 'src/tax/vat.ts'],
    ['What changed in "src/app.ts"?', 'timeline', 'src/app.ts'],
  ])('%s → %s about %s', (question, kind, target) => {
    const parsed = parseQuestion(question);
    expect(parsed?.kind).toBe(kind);
    expect(parsed?.candidates[0]).toBe(target);
  });

  it('declines questions it cannot answer deterministically', () => {
    expect(parseQuestion('Summarize the architecture for me')).toBeNull();
    expect(parseQuestion('Is this code any good?')).toBeNull();
  });
});

describe('isTestPath', () => {
  it.each([
    ['src/a.test.ts', true],
    ['src/a.spec.tsx', true],
    ['tests/test_api.py', true],
    ['pkg/server_test.go', true],
    ['__tests__/x.js', true],
    ['src/contest.ts', false],
    ['src/latest.ts', false],
  ])('%s → %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});
