import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type FossilDatabase } from './client.js';
import * as schema from './schema.js';
import { openTestDatabase } from './test-helpers.js';

const EXPECTED_TABLES = [
  'calls',
  'commit_parents',
  'commits',
  'dependencies',
  'evidence',
  'file_changes',
  'files',
  'foreign_lookups',
  'imports',
  'incidents',
  'investigations',
  'issues',
  'provider_connections',
  'pull_request_commits',
  'pull_requests',
  'relations',
  'repositories',
  'reviews',
  'symbol_versions',
  'symbols',
  'tests',
];

describe('openDatabase', () => {
  let fossil: FossilDatabase | undefined;
  let tempDir: string | undefined;

  afterEach(() => {
    fossil?.close();
    fossil = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('creates every schema table', () => {
    fossil = openTestDatabase();
    const tables = fossil.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .pluck()
      .all();
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('enforces foreign keys', () => {
    fossil = openTestDatabase();
    const db = fossil.db;
    expect(() =>
      db.insert(schema.files).values({ repositoryId: 999, path: 'orphan.ts' }).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('uses WAL for file-backed databases and is safe to reopen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'codefossil-db-'));
    const path = join(tempDir, 'fossil.db');

    fossil = openDatabase(path);
    expect(fossil.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    fossil.db.insert(schema.repositories).values({ path: '/repo', name: 'repo' }).run();
    fossil.close();

    fossil = openDatabase(path);
    const count = fossil.db.select().from(schema.repositories).all().length;
    expect(count).toBe(1);
  });
});
