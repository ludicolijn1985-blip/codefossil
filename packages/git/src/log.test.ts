import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readCommits } from './log.js';
import { GitParseError, type GitCommit } from './parse.js';
import {
  createFixtureRepo,
  createSampleHistory,
  type FixtureRepo,
  type SampleHistory,
} from './testing/index.js';

async function collect(iterable: AsyncIterable<GitCommit>): Promise<GitCommit[]> {
  const out: GitCommit[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('readCommits', () => {
  let sample: SampleHistory | undefined;
  let commits: GitCommit[];

  beforeAll(async () => {
    sample = await createSampleHistory();
    commits = await collect(readCommits(sample.repo.root));
  });

  const history = (): SampleHistory => {
    if (!sample) throw new Error('sample history was not created');
    return sample;
  };

  afterAll(async () => {
    await sample?.repo.cleanup();
  });

  const bySha = (sha: string) => {
    const commit = commits.find((c) => c.sha === sha);
    if (!commit) throw new Error(`commit ${sha} not found`);
    return commit;
  };

  it('yields every commit reachable from HEAD', () => {
    expect(commits.map((c) => c.sha).sort()).toEqual(Object.values(history().shas).sort());
  });

  it('yields parents before children', () => {
    const seen = new Set<string>();
    for (const commit of commits) {
      for (const parent of commit.parents) expect(seen.has(parent)).toBe(true);
      seen.add(commit.sha);
    }
  });

  it('reads deterministic metadata', () => {
    const first = bySha(history().shas.addVat);
    expect(first).toMatchObject({
      parents: [],
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authoredAt: '2026-01-01T09:00:00.000Z',
      subject: 'Add VAT calculation',
      body: '',
    });
    expect(bySha(history().shas.reducedRate).body).toBe(
      'Workaround for legacy invoices.\nFixes #12',
    );
  });

  it('reports additions with line counts', () => {
    expect(bySha(history().shas.addVat).changes).toEqual([
      { status: 'added', path: 'README.md', previousPath: null, additions: 1, deletions: 0 },
      {
        status: 'added',
        path: 'src/payment/vat.ts',
        previousPath: null,
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it('reports modifications, renames, deletions and binary files', () => {
    expect(bySha(history().shas.reducedRate).changes).toEqual([
      {
        status: 'modified',
        path: 'src/payment/vat.ts',
        previousPath: null,
        additions: 2,
        deletions: 1,
      },
    ]);
    expect(bySha(history().shas.moveToTax).changes).toEqual([
      {
        status: 'renamed',
        path: 'src/tax/vat.ts',
        previousPath: 'src/payment/vat.ts',
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(bySha(history().shas.removeReadme).changes).toEqual([
      { status: 'deleted', path: 'README.md', previousPath: null, additions: 0, deletions: 1 },
    ]);
    expect(bySha(history().shas.addLogo).changes).toEqual([
      {
        status: 'added',
        path: 'assets/logo.png',
        previousPath: null,
        additions: null,
        deletions: null,
      },
    ]);
  });

  it('reports merge commits with both parents and no changes', () => {
    const merge = bySha(history().shas.merge);
    expect(merge.parents).toEqual([history().shas.removeReadme, history().shas.addLogo]);
    expect(merge.changes).toEqual([]);
  });

  it('filters by commit date with since', async () => {
    const recent = await collect(
      readCommits(history().repo.root, { since: new Date('2026-01-01T12:00:00Z') }),
    );
    expect(recent.map((c) => c.subject)).toEqual(
      expect.arrayContaining(['Remove README', 'Merge branch feature/logo']),
    );
    expect(recent.map((c) => c.subject)).not.toContain('Add VAT calculation');
  });
});

describe('readCommits with hostile input', () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('parses commit messages that contain the record separator byte', async () => {
    repo = await createFixtureRepo();
    await repo.write('a.txt', 'a\n');
    await repo.commit('First\n\nbinary junk \x1e and more \x1e');
    await repo.write('b.txt', 'b\n');
    await repo.commit('Second');

    const commits = await collect(readCommits(repo.root));
    expect(commits.map((c) => c.subject)).toEqual(['First', 'Second']);
    expect(commits[0]?.body).toBe('binary junk \x1e and more \x1e');
    expect(commits[1]?.changes.map((c) => c.path)).toEqual(['b.txt']);
  });

  it('refuses to buffer a commit record larger than the limit', async () => {
    repo = await createFixtureRepo();
    await repo.write('a.txt', 'a\n');
    await repo.commit(`Huge\n\n${'x'.repeat(5_000)}`);

    await expect(
      collect(readCommits(repo.root, { maxRecordLength: 1_000 })),
    ).rejects.toBeInstanceOf(GitParseError);
  });
});
