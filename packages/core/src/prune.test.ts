import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findCommitBySha,
  findEvidenceId,
  getInvestigation,
  IN_MEMORY,
  openDatabase,
  saveInvestigation,
  type FossilDatabase,
  type FossilDb,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');

/** What answers can see of an index, without database ids, so two indexes can be compared. */
function snapshot(db: FossilDb) {
  const rows = <T>(query: ReturnType<typeof sql>) => db.all<T>(query);
  return {
    commits: rows(sql`SELECT sha FROM commits ORDER BY sha`),
    files: rows(sql`SELECT f.path, a.sha AS first, b.sha AS last, f.deleted_at AS deletedAt
                    FROM files f LEFT JOIN commits a ON a.id = f.first_seen_commit_id
                    LEFT JOIN commits b ON b.id = f.last_seen_commit_id ORDER BY f.path`),
    symbols:
      rows(sql`SELECT f.path, s.stable_key AS key, s.start_line AS start, s.end_line AS "end",
                        s.current, (SELECT count(*) FROM symbol_versions v WHERE v.symbol_id = s.id) AS versions,
                        (SELECT group_concat(c.sha) FROM relations r JOIN commits c ON c.id = r.target_id
                         WHERE r.source_type = 'symbol' AND r.source_id = s.id
                           AND r.relation = 'INTRODUCED_BY') AS introducedBy
                      FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY f.path, s.stable_key`),
    relations: rows(sql`SELECT relation, evidence_type AS level, count(*) AS n FROM relations
                        GROUP BY relation, evidence_type ORDER BY relation, evidence_type`),
    commitEvidence: rows(sql`SELECT locator FROM evidence WHERE type = 'commit' ORDER BY locator`),
    imports:
      rows(sql`SELECT f.path, i.specifier, i.line FROM imports i JOIN files f ON f.id = i.file_id
                      ORDER BY f.path, i.line`),
  };
}

/** The relations that point at a commit row that no longer exists. */
const danglingCommitRelations = (db: FossilDb) =>
  db.all(sql`SELECT id FROM relations WHERE
    (source_type = 'commit' AND source_id NOT IN (SELECT id FROM commits)) OR
    (target_type = 'commit' AND target_id NOT IN (SELECT id FROM commits))`);

describe('pruning history that HEAD no longer reaches', () => {
  let fossil: FossilDatabase;
  let fresh: FossilDatabase;
  let repo: FixtureRepo;

  beforeEach(async () => {
    fossil = openDatabase(IN_MEMORY);
    fresh = openDatabase(IN_MEMORY);
    repo = await createFixtureRepo();
    await repo.write('src/cart.js', 'export function total(items) {\n  return items.length;\n}\n');
    await repo.write('src/main.js', "import { total } from './cart.js';\n");
    await repo.commit('Add cart');
    await repo.write(
      'src/cart.js',
      'export function total(items) {\n  return items.reduce((s, i) => s + i, 0);\n}\n',
    );
    await repo.commit('Sum the cart');
  });

  afterEach(async () => {
    fossil.close();
    fresh.close();
    await repo.cleanup();
  });

  /**
   * Commits named by evidence an answer can reach (cited by a relation or an
   * import) that are not in HEAD's history.
   */
  const citedOutsideHead = async (db: FossilDb) => {
    const history = new Set((await repo.git('rev-list', 'HEAD')).trim().split('\n'));
    return db
      .all<{ type: string; locator: string }>(
        sql`SELECT DISTINCT type, locator FROM evidence WHERE id IN (
              SELECT e.value FROM relations, json_each(relations.provenance_json, '$.evidenceIds') AS e
              UNION SELECT evidence_id FROM imports)`,
      )
      .filter(({ type, locator }) => {
        const sha = type === 'commit' ? locator : /@([0-9a-f]{40})/.exec(locator)?.[1];
        return sha !== undefined && !history.has(sha);
      });
  };

  /** The incrementally maintained index must equal one built from scratch at the same HEAD. */
  const expectSameAsFreshIndex = async () => {
    await runIndex(fresh.db, repo.root, { now });
    expect(snapshot(fossil.db)).toEqual(snapshot(fresh.db));
    expect(danglingCommitRelations(fossil.db)).toEqual([]);
    expect(await citedOutsideHead(fossil.db)).toEqual([]);
  };

  it('forgets the commits of a deleted branch, with their files and symbols', async () => {
    await repo.git('checkout', '-q', '-b', 'demo-pr');
    await repo.write(
      'src/cart.js',
      'export function total(items) {\n  return 0;\n}\nexport function discount() {}\n',
    );
    await repo.write('src/demo.js', 'export function demo() {}\n');
    const demo = await repo.commit('demo: rewrite the cart');
    const first = await runIndex(fossil.db, repo.root, { now });
    expect(findCommitBySha(fossil.db, first.repositoryId, demo)).toBeDefined();

    await repo.git('checkout', '-q', 'main');
    await repo.git('branch', '-q', '-D', 'demo-pr');
    const second = await runIndex(fossil.db, repo.root, { now });

    expect(second.commitsPruned).toBe(1);
    expect(findCommitBySha(fossil.db, second.repositoryId, demo)).toBeUndefined();
    expect(findEvidenceId(fossil.db, second.repositoryId, 'commit', demo)).toBeUndefined();
    await expectSameAsFreshIndex();
  });

  it('follows a reset and indexes the commits made after it', async () => {
    const dropped = await repo.commit('Empty commit that will be reset away');
    await runIndex(fossil.db, repo.root, { now });
    await repo.git('reset', '-q', '--hard', 'HEAD~1');
    await repo.write('src/cart.js', 'export function total() {\n  return 1;\n}\n');
    await repo.commit('Replace the total');

    const result = await runIndex(fossil.db, repo.root, { now });

    expect(result).toMatchObject({ commitsPruned: 1, commitsIndexed: 1 });
    expect(findCommitBySha(fossil.db, result.repositoryId, dropped)).toBeUndefined();
    await expectSameAsFreshIndex();
  });

  it('restores a file renamed only on the abandoned branch, with its symbol history', async () => {
    await repo.git('checkout', '-q', '-b', 'move');
    await repo.move('src/cart.js', 'lib/basket.js');
    await repo.commit('Move the cart');
    await repo.write('lib/basket.js', 'export function total() {\n  return 2;\n}\n');
    await repo.commit('Change the moved cart');
    await runIndex(fossil.db, repo.root, { now });

    await repo.git('checkout', '-q', 'main');
    const result = await runIndex(fossil.db, repo.root, { now });

    expect(result.commitsPruned).toBe(2);
    await expectSameAsFreshIndex();
  });

  it('re-adds a branch when it is checked out again', async () => {
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/feature.js', 'export function feature() {}\n');
    const feature = await repo.commit('Add feature');
    await runIndex(fossil.db, repo.root, { now });
    await repo.git('checkout', '-q', 'main');
    await runIndex(fossil.db, repo.root, { now });

    await repo.git('checkout', '-q', 'feature');
    const result = await runIndex(fossil.db, repo.root, { now });

    expect(result).toMatchObject({ commitsPruned: 0, commitsIndexed: 1 });
    expect(findCommitBySha(fossil.db, result.repositoryId, feature)).toBeDefined();
    await expectSameAsFreshIndex();
  });

  it('keeps commits a shallow clone does not have, since they may be older history', async () => {
    const shas = (await repo.git('rev-list', 'HEAD')).trim().split('\n');
    const result = await runIndex(fossil.db, repo.root, { now });
    // Make the repository a depth-1 clone of itself: the older commit is gone from it.
    await repo.write('.git/shallow', `${shas[0] ?? ''}\n`);
    await repo.git('reflog', 'expire', '--expire=now', '--all');
    await repo.git('gc', '-q', '--prune=now');
    expect((await repo.git('rev-list', 'HEAD')).trim().split('\n')).toHaveLength(1);
    await repo.commit('After the shallow fetch');

    const again = await runIndex(fossil.db, repo.root, { now });

    expect(again).toMatchObject({ commitsPruned: 0, commitsIndexed: 1 });
    for (const sha of shas) {
      expect(findCommitBySha(fossil.db, result.repositoryId, sha)).toBeDefined();
    }
  });

  it('keeps saved investigations and the evidence they cite', async () => {
    await repo.git('checkout', '-q', '-b', 'gone');
    const gone = await repo.commit('Commit that an investigation cited');
    const indexed = await runIndex(fossil.db, repo.root, { now });
    const evidenceId = findEvidenceId(fossil.db, indexed.repositoryId, 'commit', gone);
    if (evidenceId === undefined) throw new Error('commit evidence was not recorded');
    const saved = saveInvestigation(fossil.db, {
      repositoryId: indexed.repositoryId,
      query: 'why cart',
      kind: 'why',
      targetKey: 'file:1',
      answer: 'Cited the commit.',
      confidence: 1,
      classification: 'FACT',
      evidenceIds: [evidenceId],
      result: {},
      headSha: gone,
    });

    await repo.git('checkout', '-q', 'main');
    await runIndex(fossil.db, repo.root, { now });

    expect(getInvestigation(fossil.db, indexed.repositoryId, saved.id)).toBeDefined();
    expect(findEvidenceId(fossil.db, indexed.repositoryId, 'commit', gone)).toBe(evidenceId);
    expect(danglingCommitRelations(fossil.db)).toEqual([]);
  });
});
