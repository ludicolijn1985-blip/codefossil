import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureRepo, type FixtureRepo } from './testing/index.js';
import { isPathTracked, listHeadFiles } from './tree.js';

describe('tree helpers', () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('lists the files committed at HEAD, ignoring uncommitted changes', async () => {
    repo = await createFixtureRepo();
    await repo.write('src/a.ts', 'a');
    await repo.write('docs/b c.md', 'b');
    await repo.commit('Add files');
    await repo.write('untracked.txt', 'u');

    expect(await listHeadFiles(repo.root)).toEqual(new Set(['docs/b c.md', 'src/a.ts']));
  });

  it('tells whether a path is tracked', async () => {
    repo = await createFixtureRepo();
    await repo.write('.codefossil/fossil.db', 'x');
    await repo.commit('Commit a workspace by mistake');

    expect(await isPathTracked(repo.root, '.codefossil')).toBe(true);
    expect(await isPathTracked(repo.root, 'nothing-here')).toBe(false);
  });
});
