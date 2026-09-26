import { describe, expect, it } from 'vitest';
import { GitParseError, parseCommitRecord } from './parse.js';

const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

function header(overrides: Partial<Record<'parents' | 'body' | 'date', string>> = {}): string {
  return [
    SHA,
    overrides.parents ?? PARENT,
    'Ada Lovelace',
    'ada@example.com',
    overrides.date ?? '2026-01-01T10:00:00+02:00',
    '2026-01-01T10:00:00+02:00',
    'Add VAT',
    overrides.body ?? '',
  ].join('\0');
}

const raw = (status: string, ...paths: string[]) =>
  [`:100644 100644 ${ZERO} ${ZERO} ${status}`, ...paths].join('\0');

describe('parseCommitRecord', () => {
  it('parses header fields and normalizes dates to UTC', () => {
    const commit = parseCommitRecord(`${header({ body: 'Line one\nFixes #12\n' })}\0\0`);
    expect(commit).toEqual({
      sha: SHA,
      parents: [PARENT],
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authoredAt: '2026-01-01T08:00:00.000Z',
      committedAt: '2026-01-01T08:00:00.000Z',
      subject: 'Add VAT',
      body: 'Line one\nFixes #12',
      changes: [],
    });
  });

  it('parses a root commit with no parents', () => {
    expect(parseCommitRecord(`${header({ parents: '' })}\0\0`).parents).toEqual([]);
  });

  it('parses several parents for a merge commit', () => {
    const commit = parseCommitRecord(`${header({ parents: `${PARENT} ${ZERO}` })}\0\0`);
    expect(commit.parents).toEqual([PARENT, ZERO]);
  });

  it('combines raw status with numstat counts', () => {
    const record = [
      header(),
      '',
      `\n${raw('A', 'src/new.ts')}`,
      raw('M', 'src/old file.ts'),
      raw('D', 'gone.ts'),
      '3\t0\tsrc/new.ts',
      '1\t2\tsrc/old file.ts',
      '0\t7\tgone.ts',
      '',
    ].join('\0');
    expect(parseCommitRecord(record).changes).toEqual([
      { status: 'added', path: 'src/new.ts', previousPath: null, additions: 3, deletions: 0 },
      {
        status: 'modified',
        path: 'src/old file.ts',
        previousPath: null,
        additions: 1,
        deletions: 2,
      },
      { status: 'deleted', path: 'gone.ts', previousPath: null, additions: 0, deletions: 7 },
    ]);
  });

  it('parses renames from both raw and numstat', () => {
    const record = [
      header(),
      '',
      `\n${raw('R087', 'src/a.ts', 'src/b.ts')}`,
      '1\t1\t',
      'src/a.ts',
      'src/b.ts',
      '',
    ].join('\0');
    expect(parseCommitRecord(record).changes).toEqual([
      { status: 'renamed', path: 'src/b.ts', previousPath: 'src/a.ts', additions: 1, deletions: 1 },
    ]);
  });

  it('treats a copy as an addition without a previous path', () => {
    const record = [
      header(),
      '',
      `\n${raw('C100', 'src/a.ts', 'src/copy.ts')}`,
      '0\t0\t',
      'src/a.ts',
      'src/copy.ts',
      '',
    ].join('\0');
    expect(parseCommitRecord(record).changes).toEqual([
      { status: 'added', path: 'src/copy.ts', previousPath: null, additions: 0, deletions: 0 },
    ]);
  });

  it('reports binary line counts as unknown rather than zero', () => {
    const record = [header(), '', `\n${raw('A', 'logo.png')}`, '-\t-\tlogo.png', ''].join('\0');
    expect(parseCommitRecord(record).changes[0]).toMatchObject({
      additions: null,
      deletions: null,
    });
  });

  it('keeps non-ASCII paths intact', () => {
    const record = [
      header(),
      '',
      `\n${raw('A', 'docs/résumé.md')}`,
      '1\t0\tdocs/résumé.md',
      '',
    ].join('\0');
    expect(parseCommitRecord(record).changes[0]?.path).toBe('docs/résumé.md');
  });

  it('rejects a truncated record', () => {
    expect(() => parseCommitRecord(`${SHA}\0${PARENT}`)).toThrow(GitParseError);
  });

  it('rejects an invalid SHA', () => {
    expect(() => parseCommitRecord(`${header()}\0\0`.replace(SHA, 'nope'))).toThrow(
      /Invalid commit SHA/,
    );
  });

  it('rejects an invalid date', () => {
    expect(() => parseCommitRecord(`${header({ date: 'not a date' })}\0\0`)).toThrow(
      /Invalid date/,
    );
  });

  it('rejects an unknown change status', () => {
    const record = [header(), '', `\n${raw('X', 'weird')}`, ''].join('\0');
    expect(() => parseCommitRecord(record)).toThrow(/Unsupported change status/);
  });
});
