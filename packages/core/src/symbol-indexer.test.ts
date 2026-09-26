import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findFileByPath,
  getIndexStatus,
  IN_MEMORY,
  listFileSymbols,
  openDatabase,
  outgoingRelations,
  type FossilDatabase,
} from '@codefossil/db';
import {
  createFixtureRepo,
  createSampleHistory,
  type FixtureRepo,
  type SampleHistory,
} from '@codefossil/git/testing';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

describe('indexSymbols', () => {
  let fossil: FossilDatabase;
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    fossil = openDatabase(IN_MEMORY);
    sample = await createSampleHistory();
  });

  afterEach(async () => {
    fossil.close();
    await sample?.repo.cleanup();
  });

  const history = (): SampleHistory => {
    if (!sample) throw new Error('sample history was not created');
    return sample;
  };

  const symbolsOf = (repositoryId: number, path: string) => {
    const file = findFileByPath(fossil.db, repositoryId, path);
    if (!file) throw new Error(`${path} was not indexed`);
    return listFileSymbols(fossil.db, file.id);
  };

  it('keeps symbol history across a file rename and names the introducing commit', async () => {
    const result = await runIndex(fossil.db, history().repo.root, { now });

    expect(result.symbols).toMatchObject({
      versionsParsed: 3,
      symbolVersions: 2,
      symbolsIntroduced: 1,
    });
    const [vat] = symbolsOf(result.repositoryId, 'src/tax/vat.ts');
    expect(vat).toMatchObject({
      stableKey: 'function:calculateVAT',
      kind: 'function',
      startLine: 1,
      endLine: 2,
      versions: 2,
      introducedBy: { sha: history().shas.addVat, subject: 'Add VAT calculation' },
    });
    expect(symbolsOf(result.repositoryId, 'src/payment/vat.ts')).toEqual([]);
  });

  it('records CONTAINS as FACT and MODIFIES/INTRODUCED_BY as DERIVED, citing AST evidence', async () => {
    const { repositoryId } = await runIndex(fossil.db, history().repo.root, { now });
    const [vat] = symbolsOf(repositoryId, 'src/tax/vat.ts');
    const introduced = outgoingRelations(fossil.db, repositoryId, {
      type: 'symbol',
      id: vat?.id ?? 0,
    });

    expect(introduced).toHaveLength(1);
    expect(introduced[0]).toMatchObject({
      relation: 'INTRODUCED_BY',
      evidenceType: 'DERIVED',
      confidence: 1,
    });
    expect(introduced[0]?.provenanceJson.evidenceIds).toHaveLength(1);

    const status = getIndexStatus(fossil.db, repositoryId);
    expect(status?.counts).toMatchObject({ symbols: 1, currentSymbols: 1, symbolVersions: 2 });
    // 6 MODIFIES(file) + 6 PARENT_OF + 1 CONTAINS
    expect(status?.counts.relations.FACT).toBe(13);
    // 2 MODIFIES(symbol) + 1 INTRODUCED_BY
    expect(status?.counts.relations.DERIVED).toBe(3);
  });

  it('is incremental and tracks additions and removals in later commits', async () => {
    const repo = history().repo;
    const { repositoryId } = await runIndex(fossil.db, repo.root, { now });

    await repo.write(
      'src/tax/vat.ts',
      'export function applyVAT(n: number) {\n  return n * 1.21;\n}\n',
    );
    const replaced = await repo.commit('Replace calculateVAT with applyVAT');
    const second = await runIndex(fossil.db, repo.root, { now });

    expect(second.symbols).toMatchObject({
      versionsParsed: 1,
      symbolVersions: 1,
      symbolsIntroduced: 1,
    });
    const current = symbolsOf(repositoryId, 'src/tax/vat.ts');
    expect(current.map((s) => s.stableKey)).toEqual(['function:applyVAT']);
    expect(current[0]?.introducedBy?.sha).toBe(replaced);
    expect(getIndexStatus(fossil.db, repositoryId)?.counts).toMatchObject({
      symbols: 2,
      currentSymbols: 1,
    });

    const third = await runIndex(fossil.db, repo.root, { now });
    expect(third.symbols).toMatchObject({ versionsParsed: 0, symbolVersions: 0 });
  });
});

describe('indexSymbols at the edges of the evidence', () => {
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

  const symbolsOf = (repositoryId: number, path: string) => {
    const file = findFileByPath(fossil.db, repositoryId, path);
    if (!file) throw new Error(`${path} was not indexed`);
    return listFileSymbols(fossil.db, file.id);
  };

  it('makes no introduction claim for symbols first seen at the start of a --since window', async () => {
    const r = fixture();
    await r.write('lib.py', 'def old():\n    pass\n');
    await r.commit('Old history');
    await r.write('lib.py', 'def old():\n    return 1\n\ndef newer():\n    pass\n');
    await r.commit('Inside the window');

    const { repositoryId } = await runIndex(fossil.db, r.root, {
      now,
      since: new Date('2026-01-01T10:00:00Z'),
    });

    const symbols = symbolsOf(repositoryId, 'lib.py');
    expect(symbols.map((s) => s.stableKey)).toEqual(['function:old', 'function:newer']);
    expect(symbols.every((s) => s.introducedBy === null)).toBe(true);
  });

  it('knows symbols that exist at HEAD even when only a merge added them', async () => {
    const r = fixture();
    await r.write('app.go', 'package app\n\nfunc Start() {}\n');
    await r.commit('Start');
    await r.git('checkout', '-q', '-b', 'side');
    await r.write('other.txt', 'x\n');
    await r.commit('Side');
    await r.git('checkout', '-q', 'main');
    await r.git('merge', '-q', '--no-ff', '--no-commit', 'side');
    await r.write('app.go', 'package app\n\nfunc Start() {}\n\nfunc Stop() {}\n');
    await r.git('add', 'app.go');
    await r.commit('Merge side and add Stop');

    const { repositoryId } = await runIndex(fossil.db, r.root, { now });

    const symbols = symbolsOf(repositoryId, 'app.go');
    expect(symbols.map((s) => s.stableKey)).toEqual(['function:Start', 'function:Stop']);
    // Stop's origin is a merge commit whose diff is not indexed: no claim is made.
    expect(symbols.find((s) => s.name === 'Stop')?.introducedBy).toBeNull();
    expect(symbols.find((s) => s.name === 'Start')?.introducedBy).not.toBeNull();
  });

  it('skips binary content and unsupported languages without failing', async () => {
    const r = fixture();
    await r.write('fake.ts', new Uint8Array([0x00, 0x01, 0x02]));
    await r.write('notes.md', '# Notes\n');
    await r.commit('Odd files');

    const result = await runIndex(fossil.db, r.root, { now });

    expect(result.symbols).toMatchObject({ versionsParsed: 0, versionsSkipped: 1 });
  });

  it('marks symbols of a deleted file as no longer current', async () => {
    const r = fixture();
    await r.write('gone.rs', 'fn vanish() {}\n');
    await r.commit('Add');
    const { repositoryId } = await runIndex(fossil.db, r.root, { now });
    expect(symbolsOf(repositoryId, 'gone.rs')).toHaveLength(1);

    await r.remove('gone.rs');
    await r.commit('Remove');
    await runIndex(fossil.db, r.root, { now });

    expect(symbolsOf(repositoryId, 'gone.rs')).toEqual([]);
  });
});
