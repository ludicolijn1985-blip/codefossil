import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIndex } from '@codefossil/core';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createSampleHistory, type SampleHistory } from '@codefossil/git/testing';
import { analyzeDeadIntent, DEAD_INTENT_CONFIDENCE } from './dead-intent.js';
import { DEFECT_CONFIDENCE } from './defects.js';
import { analyzeHotspots } from './hotspots.js';
import { buildReport } from './report.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

/**
 * The sample history (VAT added, reduced rate as a "workaround for legacy
 * invoices", moved to src/tax) plus: a checkout importing it, a test, a
 * declared Node.js floor, a shim for an old Node version, a fix and a revert.
 */
async function buildHistory(): Promise<SampleHistory> {
  const sample = await createSampleHistory();
  const { repo } = sample;
  await repo.write('package.json', '{ "name": "shop", "engines": { "node": ">=22" } }\n');
  await repo.write(
    'src/checkout.ts',
    "import { calculateVAT } from './tax/vat.js';\n\nexport const total = (n: number) => n + calculateVAT(n);\n",
  );
  await repo.write(
    'src/tax/vat.test.ts',
    "import { calculateVAT } from './vat.js';\n\nexport const check = () => calculateVAT(100);\n",
  );
  await repo.commit('Add checkout and a VAT test');
  await repo.write(
    'src/compat.ts',
    'export function legacyFetch(url: string) {\n  return url;\n}\n',
  );
  await repo.commit(
    'Add fetch shim for Node 14\n\nTemporary until 2023-06; remove once Node 14 support is dropped.',
  );
  await repo.write(
    'src/tax/vat.ts',
    [
      'export const calculateVAT = (n: number, reduced = false) =>',
      '  Math.round(n * (reduced ? 0.09 : 0.21) * 100) / 100;',
      '',
    ].join('\n'),
  );
  await repo.commit('fix: round VAT to cents');
  await repo.write(
    'src/checkout.ts',
    "import { calculateVAT } from './tax/vat.js';\n\nexport const total = (n: number) => n + calculateVAT(n) + 1;\n",
  );
  await repo.commit('Add handling fee');
  await repo.git('revert', '--no-edit', 'HEAD');
  return sample;
}

describe('risk analyzers on an indexed history', () => {
  let sample: SampleHistory | undefined;
  let fossil: FossilDatabase;
  let repositoryId: number;

  beforeAll(async () => {
    sample = await buildHistory();
    fossil = openDatabase(IN_MEMORY);
    repositoryId = (await runIndex(fossil.db, sample.repo.root, { now })).repositoryId;
  });

  afterAll(async () => {
    fossil.close();
    await sample?.repo.cleanup();
  });

  describe('hotspots', () => {
    it('ranks files by change, churn and defect commits, followed across renames', () => {
      const report = analyzeHotspots(fossil.db, repositoryId);
      const scores = report.hotspots.map((h) => h.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      const top = report.hotspots.find((h) => h.file.path === 'src/tax/vat.ts');
      // Added, reduced rate, fix; the move into src/tax is a pure rename and not a change.
      expect(top?.commits).toBe(3);
      expect(top?.defects).toEqual([
        expect.objectContaining({
          subject: 'fix: round VAT to cents',
          level: 'INFERRED',
          confidence: DEFECT_CONFIDENCE.conventionalFix,
        }),
      ]);
      expect(top?.classification).toBe('INFERRED');
      expect(top?.evidenceIds.length).toBeGreaterThan(0);
      expect(top?.components.changeFrequency).toBe(1);
    });

    it('reports risk components: import reach, tests reaching the file, bug density', () => {
      const vat = analyzeHotspots(fossil.db, repositoryId).hotspots.find(
        (h) => h.file.path === 'src/tax/vat.ts',
      );
      expect(vat?.risk).toMatchObject({ dependents: 2, testsReaching: 1 });
      expect(vat?.risk.components.testReachInverse).toBe(0.5);
      expect(vat?.risk.components.bugDensity).toBeCloseTo(1 / 3, 3);
    });

    it('counts a revert as a defect-related change', () => {
      const checkout = analyzeHotspots(fossil.db, repositoryId).hotspots.find(
        (h) => h.file.path === 'src/checkout.ts',
      );
      expect(checkout?.commits).toBe(3);
      expect(checkout?.defects[0]).toMatchObject({
        reason: 'reverts an earlier change',
        confidence: DEFECT_CONFIDENCE.revert,
      });
    });

    it('leaves tests out unless asked, limits and orders by risk on request', () => {
      const paths = (r: ReturnType<typeof analyzeHotspots>) => r.hotspots.map((h) => h.file.path);
      expect(paths(analyzeHotspots(fossil.db, repositoryId))).not.toContain('src/tax/vat.test.ts');
      expect(paths(analyzeHotspots(fossil.db, repositoryId, { includeTests: true }))).toContain(
        'src/tax/vat.test.ts',
      );
      expect(analyzeHotspots(fossil.db, repositoryId, { limit: 1 }).hotspots).toHaveLength(1);
      const byRisk = analyzeHotspots(fossil.db, repositoryId, { orderBy: 'risk' }).hotspots;
      const scores = byRisk.map((h) => h.risk.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('counts only changes since a date', () => {
      const report = analyzeHotspots(fossil.db, repositoryId, { since: '2999-01-01' });
      expect(report.hotspots).toEqual([]);
      expect(report.since).toBe('2999-01-01');
    });
  });

  describe('report', () => {
    it('summarizes the index, hotspots and dead intent', () => {
      const report = buildReport(fossil.db, repositoryId, { now: now(), hotspotLimit: 2 });
      expect(report.counts.commits).toBeGreaterThan(5);
      expect(report.hotspots).toHaveLength(2);
      expect(report.deadIntent.map((c) => c.target.path)).toContain('src/compat.ts');
      expect(report).toMatchObject({ base: null, changed: null, changedTotal: 0 });
    });

    it('reports each changed file with its history and dependents, most depended-on first', () => {
      const report = buildReport(fossil.db, repositoryId, {
        now: now(),
        base: 'main~3',
        changedPaths: [
          'src/tax/vat.ts',
          'src/compat.ts',
          'README.md',
          'pnpm-lock.yaml',
          'src/new.ts',
        ],
      });
      expect(report.changedTotal).toBe(5);
      const byPath = new Map(report.changed?.map((f) => [f.path, f]));
      expect(report.changed?.[0]?.path).toBe('src/tax/vat.ts');
      expect(byPath.get('src/tax/vat.ts')).toMatchObject({
        status: 'changed',
        history: { commits: 3, defectCount: 1, classification: 'INFERRED' },
        impact: { direct: 2, tests: 1, examples: ['src/checkout.ts', 'src/tax/vat.test.ts'] },
      });
      expect(byPath.get('README.md')?.status).toBe('deleted');
      expect(byPath.get('pnpm-lock.yaml')?.status).toBe('generated');
      expect(byPath.get('src/new.ts')?.status).toBe('unindexed');
      expect(byPath.get('src/compat.ts')?.impact?.direct).toBe(0);
    });

    it('examines at most the requested number of changed files but counts them all', () => {
      const report = buildReport(fossil.db, repositoryId, {
        changedPaths: ['src/tax/vat.ts', 'src/compat.ts', 'src/checkout.ts'],
        changedLimit: 1,
      });
      expect(report.changed).toHaveLength(1);
      expect(report.changedTotal).toBe(3);
    });
  });

  describe('dead intent', () => {
    it('flags a shim for a Node version below the declared floor, with a passed deadline', () => {
      const report = analyzeDeadIntent(fossil.db, repositoryId, { now: now() });
      const [first] = report.candidates;
      expect(first?.target).toMatchObject({ kind: 'symbol', path: 'src/compat.ts' });
      expect(first?.target.label).toContain('legacyFetch');
      expect(first?.classification).toBe('INFERRED');
      expect(first?.signals.map((s) => s.kind)).toEqual([
        'workaround_language',
        'unsupported_version',
        'deadline_passed',
      ]);
      expect(first?.signals[1]?.text).toContain('declares node >=22');
      expect(first?.confidence).toBe(
        DEAD_INTENT_CONFIDENCE.workaround_language +
          DEAD_INTENT_CONFIDENCE.unsupported_version +
          DEAD_INTENT_CONFIDENCE.deadline_passed,
      );
      // Cites the commit and the manifest that declares the floor.
      expect(first?.evidenceIds.length).toBeGreaterThanOrEqual(2);
      expect(report.runtimes).toEqual([
        expect.objectContaining({
          runtime: 'node',
          constraint: '>=22',
          minimum: '22',
          manifest: 'package.json',
        }),
      ]);
    });

    it('flags the reduced-rate change for its "workaround for legacy invoices" wording only', () => {
      const vat = analyzeDeadIntent(fossil.db, repositoryId, { now: now() }).candidates.find((c) =>
        c.target.label.includes('calculateVAT'),
      );
      expect(vat?.commits.map((c) => c.subject)).toEqual(['Handle reduced VAT rate']);
      expect(vat?.signals.map((s) => s.kind)).toEqual(['workaround_language']);
      expect(vat?.confidence).toBe(DEAD_INTENT_CONFIDENCE.workaround_language);
    });

    it('adds silence as a weak signal once the code has not changed for long', () => {
      const later = analyzeDeadIntent(fossil.db, repositoryId, {
        now: new Date('2040-01-01T00:00:00Z'),
      });
      const shim = later.candidates.find((c) => c.target.path === 'src/compat.ts');
      expect(shim?.signals.at(-1)).toMatchObject({ kind: 'unconfirmed', level: 'DERIVED' });
      expect(shim?.confidence).toBeLessThanOrEqual(DEAD_INTENT_CONFIDENCE.max);
    });

    it('leaves code alone that no workaround wording touched', () => {
      const labels = analyzeDeadIntent(fossil.db, repositoryId, { now: now() }).candidates.map(
        (c) => c.target.label,
      );
      expect(labels.some((label) => label.includes('total'))).toBe(false);
    });
  });
});
