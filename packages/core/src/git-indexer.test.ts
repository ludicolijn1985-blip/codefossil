import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileHistory,
  findCommitBySha,
  findFileByPath,
  getIndexStatus,
  IN_MEMORY,
  incomingRelations,
  openDatabase,
  outgoingRelations,
  schema,
  type FossilDatabase,
} from '@codefossil/db';
import {
  createFixtureRepo,
  createSampleHistory,
  type FixtureRepo,
  type SampleHistory,
} from '@codefossil/git/testing';
import { GIT_INDEXER_PRODUCER, indexRepository } from './git-indexer.js';

const FIXED_NOW = new Date('2026-09-26T12:00:00.000Z');
const now = () => FIXED_NOW;

describe('indexRepository', () => {
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

  const file = (repositoryId: number, path: string) => {
    const row = findFileByPath(fossil.db, repositoryId, path);
    if (!row) throw new Error(`file ${path} was not indexed`);
    return row;
  };

  it('indexes every commit and file change as FACT relations', async () => {
    const result = await indexRepository(fossil.db, history().repo.root, { now });

    expect(result).toMatchObject({
      commitsIndexed: 6,
      commitsSkipped: 0,
      fileChanges: 6,
      // 6 MODIFIES + 6 PARENT_OF (5 single-parent commits + 2 merge parents - root has none)
      relations: 12,
    });
    const status = getIndexStatus(fossil.db, result.repositoryId);
    expect(status?.counts).toEqual({
      commits: 6,
      files: 4,
      currentFiles: 2,
      fileChanges: 6,
      evidence: 6,
      // The git indexer alone parses no symbols.
      symbols: 0,
      currentSymbols: 0,
      symbolVersions: 0,
      relations: { FACT: 12, DERIVED: 0, INFERRED: 0 },
    });
    expect(status?.repository).toMatchObject({
      path: history().repo.root,
      defaultBranch: 'main',
      indexedAt: FIXED_NOW.toISOString(),
    });
  });

  it('tracks renames, deletions and binary files without inventing data', async () => {
    const { repositoryId } = await indexRepository(fossil.db, history().repo.root, { now });

    const oldPath = file(repositoryId, 'src/payment/vat.ts');
    const newPath = file(repositoryId, 'src/tax/vat.ts');
    expect(oldPath.deletedAt).toBe('2026-01-01T11:00:00.000Z');
    expect(newPath).toMatchObject({ deletedAt: null, language: 'typescript' });
    expect(fileHistory(fossil.db, newPath.id)).toEqual([
      expect.objectContaining({
        sha: history().shas.moveToTax,
        status: 'renamed',
        previousPath: 'src/payment/vat.ts',
      }),
    ]);
    expect(fileHistory(fossil.db, oldPath.id).map((h) => h.subject)).toEqual([
      'Add VAT calculation',
      'Handle reduced VAT rate',
    ]);

    // Fifth commit: one hour per commit from 09:00.
    expect(file(repositoryId, 'README.md').deletedAt).toBe('2026-01-01T13:00:00.000Z');
    expect(fileHistory(fossil.db, file(repositoryId, 'assets/logo.png').id)[0]).toMatchObject({
      additions: null,
      deletions: null,
    });
    expect(file(repositoryId, 'assets/logo.png').language).toBeNull();
  });

  it('records provenance that cites the commit evidence', async () => {
    const { repositoryId } = await indexRepository(fossil.db, history().repo.root, { now });
    const commit = findCommitBySha(fossil.db, repositoryId, history().shas.reducedRate);
    expect(commit?.body).toBe('Workaround for legacy invoices.\nFixes #12');

    const [modifies] = outgoingRelations(fossil.db, repositoryId, {
      type: 'commit',
      id: commit?.id ?? 0,
    }).filter((r) => r.relation === 'MODIFIES');
    expect(modifies).toMatchObject({ evidenceType: 'FACT', confidence: 1 });
    expect(modifies?.provenanceJson).toMatchObject({
      producer: GIT_INDEXER_PRODUCER,
      method: 'git-log-raw',
      observedAt: FIXED_NOW.toISOString(),
    });
    expect(modifies?.provenanceJson.evidenceIds).toHaveLength(1);
  });

  it('links merge commits to both parents', async () => {
    const { repositoryId } = await indexRepository(fossil.db, history().repo.root, { now });
    const merge = findCommitBySha(fossil.db, repositoryId, history().shas.merge);
    const parents = incomingRelations(fossil.db, repositoryId, {
      type: 'commit',
      id: merge?.id ?? 0,
    }).filter((r) => r.relation === 'PARENT_OF');
    expect(parents).toHaveLength(2);
  });

  it('is incremental: a second run only writes new commits', async () => {
    const repo = history().repo;
    const first = await indexRepository(fossil.db, repo.root, { now });
    const unchanged = await indexRepository(fossil.db, repo.root, { now });
    expect(unchanged).toMatchObject({ commitsIndexed: 0, commitsSkipped: 6, relations: 0 });

    await repo.write('src/tax/vat.ts', 'export const calculateVAT = () => 0;\n');
    await repo.commit('Zero-rate everything');
    const next = await indexRepository(fossil.db, repo.root, { now });
    expect(next).toMatchObject({
      repositoryId: first.repositoryId,
      commitsIndexed: 1,
      commitsSkipped: 6,
      fileChanges: 1,
      relations: 2,
    });
  });

  it('writes in batches and reports progress', async () => {
    const progress: number[] = [];
    await indexRepository(fossil.db, history().repo.root, {
      now,
      batchSize: 4,
      onProgress: (n) => progress.push(n),
    });
    expect(progress).toEqual([4, 6]);
  });

  it('only indexes commits since the given date', async () => {
    const result = await indexRepository(fossil.db, history().repo.root, {
      now,
      since: new Date('2026-01-01T12:00:00Z'),
    });
    expect(result.commitsIndexed).toBeLessThan(6);
    const merge = findCommitBySha(fossil.db, result.repositoryId, history().shas.merge);
    expect(merge).toBeDefined();
    expect(findCommitBySha(fossil.db, result.repositoryId, history().shas.addVat)).toBeUndefined();
  });
});

describe('indexRepository file state across branches', () => {
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

  const fileState = (repositoryId: number, path: string) => {
    const row = findFileByPath(fossil.db, repositoryId, path);
    if (!row) throw new Error(`file ${path} was not indexed`);
    return row;
  };

  it('keeps a file that one branch deleted but the merge kept', async () => {
    const r = fixture();
    await r.write('rates.ts', 'export const rate = 21;\n');
    await r.commit('Add rates');
    await r.git('checkout', '-q', '-b', 'cleanup');
    await r.remove('rates.ts');
    await r.commit('Delete rates');
    await r.git('checkout', '-q', 'main');
    await r.write('rates.ts', 'export const rate = 9;\n');
    await r.commit('Lower rate');
    // Modify/delete conflict, resolved by keeping the file.
    await r.git('merge', '-q', '--no-ff', 'cleanup').catch(() => undefined);
    await r.git('add', 'rates.ts');
    await r.commit('Merge cleanup, keep rates');

    const { repositoryId } = await indexRepository(fossil.db, r.root, { now });

    expect(fileState(repositoryId, 'rates.ts').deletedAt).toBeNull();
    expect(getIndexStatus(fossil.db, repositoryId)?.counts.currentFiles).toBe(1);
  });

  it('marks a file removed by a merge commit as deleted at the merge date', async () => {
    const r = fixture();
    await r.write('keep.ts', 'k\n');
    await r.write('legacy.ts', 'l\n');
    await r.commit('Add files');
    await r.git('checkout', '-q', '-b', 'side');
    await r.write('side.ts', 's\n');
    await r.commit('Side work');
    await r.git('checkout', '-q', 'main');
    // An "evil merge": the merge itself removes legacy.ts, so no indexed diff shows it.
    await r.git('merge', '-q', '--no-ff', '--no-commit', 'side');
    await r.git('rm', '-q', 'legacy.ts');
    const mergeSha = await r.commit('Merge side and drop legacy');

    const { repositoryId } = await indexRepository(fossil.db, r.root, { now });

    const merge = findCommitBySha(fossil.db, repositoryId, mergeSha);
    expect(fileState(repositoryId, 'legacy.ts').deletedAt).toBe(merge?.committedAt);
    expect(fileState(repositoryId, 'keep.ts').deletedAt).toBeNull();
  });

  // Both branches edit shared.ts in different regions (so the merge is clean).
  // Git emits the two branches in the same structural order in both cases, so
  // in one of them processing order disagrees with date order.
  it.each([
    { newer: 'side', expectedSubject: 'Side edit' },
    { newer: 'main', expectedSubject: 'Main edit' },
  ])(
    'sets last-seen to the most recent edit when $newer is newer',
    async ({ newer, expectedSubject }) => {
      const r = fixture();
      const lines = Array.from({ length: 20 }, (_, n) => `line ${n}`);
      await r.write('shared.ts', `${lines.join('\n')}\n`);
      await r.commit('Base');

      const editSide = async () => {
        await r.git('checkout', '-q', '-b', 'side');
        await r.write('shared.ts', `${['side', ...lines.slice(1)].join('\n')}\n`);
        await r.commit('Side edit');
        await r.git('checkout', '-q', 'main');
      };
      const editMain = async () => {
        await r.write('shared.ts', `${[...lines.slice(0, 19), 'main'].join('\n')}\n`);
        await r.commit('Main edit');
      };
      if (newer === 'side') {
        await editMain();
        await r.git('branch', 'side', 'HEAD~1');
        await r.git('checkout', '-q', 'side');
        await r.write('shared.ts', `${['side', ...lines.slice(1)].join('\n')}\n`);
        await r.commit('Side edit');
        await r.git('checkout', '-q', 'main');
      } else {
        await editSide();
        await editMain();
      }
      await r.merge('side', 'Merge side');

      const { repositoryId } = await indexRepository(fossil.db, r.root, { now });
      const shared = fileState(repositoryId, 'shared.ts');
      const lastSeen = fossil.db
        .select()
        .from(schema.commits)
        .where(eq(schema.commits.id, shared.lastSeenCommitId ?? 0))
        .get();

      expect(lastSeen?.subject).toBe(expectedSubject);
      expect(shared.deletedAt).toBeNull();
    },
  );
});

describe('indexRepository on an empty repository', () => {
  it('registers the repository and indexes nothing', async () => {
    const { createFixtureRepo } = await import('@codefossil/git/testing');
    const repo = await createFixtureRepo();
    const fossil = openDatabase(IN_MEMORY);
    try {
      const result = await indexRepository(fossil.db, repo.root, { now });
      expect(result).toMatchObject({ commitsIndexed: 0, fileChanges: 0, relations: 0 });
      expect(getIndexStatus(fossil.db, result.repositoryId)?.repository.indexedAt).toBe(
        FIXED_NOW.toISOString(),
      );
    } finally {
      fossil.close();
      await repo.cleanup();
    }
  });
});
