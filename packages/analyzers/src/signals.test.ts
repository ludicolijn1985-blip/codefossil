import { describe, expect, it } from 'vitest';
import type { AnalysisChange, AnalysisCommit, CommitDiscussion } from '@codefossil/db';
import { classifyDefects, DEFECT_CONFIDENCE } from './defects.js';
import { fileActivity } from './file-history.js';
import { isCodePath, isDeclarationPath, isGeneratedPath } from './hotspots.js';
import { importReach } from './reach.js';
import {
  deadlines,
  isBelowMinimum,
  versionReferences,
  workaroundLanguage,
} from './text-signals.js';

describe('workaroundLanguage', () => {
  it('finds the first workaround wording and the line it is on', () => {
    const match = workaroundLanguage('Handle reduced VAT rate\n\nWorkaround for legacy invoices.');
    expect(match).toEqual({
      phrase: 'Workaround',
      excerpt: 'Workaround for legacy invoices.',
      inFirstLine: false,
    });
  });

  it('does not count wording that removes a workaround, and knows a subject from a body', () => {
    expect(workaroundLanguage('remove deprecated express.createServer() method')).toBeNull();
    expect(workaroundLanguage('Drop the legacy shim\n\nNo longer needed.')).toBeNull();
    expect(workaroundLanguage('Add fetch shim for Node 14')).toMatchObject({
      phrase: 'shim',
      inFirstLine: true,
    });
    expect(workaroundLanguage('remove old code\n\nKeep a temporary fallback for IE')).toMatchObject(
      {
        phrase: 'temporary',
        inFirstLine: false,
      },
    );
  });

  it.each([
    'Add polyfill for fetch',
    'Temporary shim until upstream is fixed',
    'Keep backwards compatibility with v1 clients',
    'Remove this once Safari supports it',
    'monkey-patch the logger',
  ])('flags %j', (text) => {
    expect(workaroundLanguage(text)).not.toBeNull();
  });

  it('ignores ordinary wording', () => {
    expect(workaroundLanguage('Add checkout total')).toBeNull();
    expect(workaroundLanguage('Organise the hackathon page')).toBeNull();
  });
});

describe('versionReferences', () => {
  it('reads runtime versions with and without a minor number', () => {
    expect(
      versionReferences('Support Node 14 and node.js v16.3, Python 2.7, Go 1.20 and rustc 1.60'),
    ).toEqual([
      { runtime: 'node', major: 14, minor: null, phrase: 'Node 14' },
      { runtime: 'node', major: 16, minor: 3, phrase: 'node.js v16.3' },
      { runtime: 'python', major: 2, minor: 7, phrase: 'Python 2.7' },
      { runtime: 'go', major: 1, minor: 20, phrase: 'Go 1.20' },
      { runtime: 'rust', major: 1, minor: 60, phrase: 'rustc 1.60' },
    ]);
  });

  it('treats a bare major version as the whole series', () => {
    const python3 = { runtime: 'python' as const, major: 3, minor: null, phrase: 'Python 3' };
    expect(isBelowMinimum(python3, { major: 3, minor: 10 })).toBe(false);
    expect(isBelowMinimum({ ...python3, minor: 8 }, { major: 3, minor: 10 })).toBe(true);
    expect(isBelowMinimum({ ...python3, major: 2 }, { major: 3, minor: 10 })).toBe(true);
    expect(isBelowMinimum({ ...python3, minor: 12 }, { major: 3, minor: 10 })).toBe(false);
  });
});

describe('deadlines', () => {
  it('reads the end of the period a deadline names', () => {
    expect(
      deadlines('Keep until 2024-06, remove after Q1 2025; expires 2023-02-14').map((d) => d.date),
    ).toEqual(['2024-06-30', '2025-03-31', '2023-02-14']);
    expect(deadlines('Remove by 2026')[0]?.date).toBe('2026-12-31');
  });

  it('ignores numbers that are not plausible dates', () => {
    expect(deadlines('Speeds up by 1000 items, until 9999')).toEqual([]);
    expect(deadlines('until 2024-13')).toEqual([]);
  });
});

const change = (
  fileId: number,
  commitId: number,
  committedAt: string,
  extra: Partial<AnalysisChange> = {},
): AnalysisChange => ({
  fileId,
  commitId,
  status: 'modified',
  previousPath: null,
  additions: 1,
  deletions: 1,
  committedAt,
  ...extra,
});

describe('fileActivity', () => {
  const files = [
    { id: 1, path: 'src/payment/vat.ts', deletedAt: '2026-01-03' },
    { id: 2, path: 'src/tax/vat.ts', deletedAt: null },
    { id: 3, path: 'logo.png', deletedAt: null },
  ];

  it('follows renames back and does not count a pure rename as a change', () => {
    const [vat] = fileActivity(files, [
      change(1, 10, '2026-01-01', { status: 'added', additions: 3, deletions: 0 }),
      change(1, 11, '2026-01-02', { additions: 2, deletions: 1 }),
      change(2, 12, '2026-01-03', {
        status: 'renamed',
        previousPath: 'src/payment/vat.ts',
        additions: 0,
        deletions: 0,
      }),
      change(2, 13, '2026-01-04'),
    ]);
    expect(vat).toMatchObject({ path: 'src/tax/vat.ts', churn: 8, lastChangedAt: '2026-01-04' });
    expect([...(vat?.commitIds ?? [])].sort()).toEqual([10, 11, 13]);
  });

  it('stops at the rename when the old path was reused later', () => {
    const [vat] = fileActivity(files, [
      change(1, 10, '2026-01-01'),
      change(2, 12, '2026-01-03', { status: 'renamed', previousPath: 'src/payment/vat.ts' }),
      change(1, 20, '2026-02-01'),
    ]);
    expect([...(vat?.commitIds ?? [])].sort()).toEqual([10, 12]);
  });

  it('counts binary changes apart and honours since', () => {
    const activity = fileActivity(
      files,
      [
        change(3, 30, '2025-01-01', { additions: null, deletions: null }),
        change(3, 31, '2026-01-01', { additions: null, deletions: null }),
      ],
      '2025-06-01',
    );
    expect(activity.find((f) => f.fileId === 3)).toMatchObject({ churn: 0, binaryChanges: 1 });
  });
});

describe('classifyDefects', () => {
  const commit = (id: number, subject: string, body = ''): AnalysisCommit => ({
    id,
    sha: String(id).padStart(40, 'a'),
    subject,
    body,
    committedAt: '2026-01-01',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
  });
  const evidence = new Map([[commit(1, '').sha, 101]]);

  it('reads a commit naming a Jira or Linear bug ticket as a fix (INFERRED)', () => {
    const ticket = (provider: string, labels: string[]): CommitDiscussion => ({
      commitId: 7,
      type: 'issue',
      number: 'PROJ-12',
      repo: null,
      provider,
      title: 'Checkout crashes',
      body: '',
      labels,
      relation: 'REFERENCES',
      level: 'DERIVED',
      confidence: 1,
      evidenceIds: [55],
    });
    const named = commit(7, 'PROJ-12 handle empty cart');
    const evidenceOf = new Map([[named.sha, 107]]);

    expect(classifyDefects([named], [ticket('jira', ['type:Bug'])], evidenceOf).get(7)).toEqual({
      reason: 'names Jira bug PROJ-12',
      level: 'INFERRED',
      confidence: 0.7,
      evidenceIds: [107, 55],
    });
    // A story is no bug; a GitHub mention without a closing keyword is no resolution either.
    expect(classifyDefects([named], [ticket('jira', ['type:Story'])], evidenceOf).size).toBe(0);
    expect(classifyDefects([named], [ticket('github', ['bug'])], evidenceOf).size).toBe(0);
  });

  it('reads labelled resolved issues, reverts and fix wording at their own certainty', () => {
    const bugIssue: CommitDiscussion = {
      commitId: 1,
      type: 'issue',
      number: '12',
      repo: null,
      provider: 'github',
      title: 'Crash on checkout',
      body: '',
      labels: ['bug', 'checkout'],
      relation: 'RESOLVED_BY',
      level: 'DERIVED',
      confidence: 0.9,
      evidenceIds: [55],
    };
    const result = classifyDefects(
      [
        commit(1, 'Handle empty cart', 'Fixes #12'),
        commit(2, 'Revert "Add cache"', 'This reverts commit abcdef1234.'),
        commit(3, 'fix(cart): rounding'),
        commit(4, 'Crash when cart is empty'),
        commit(5, 'fix typo in readme'),
        commit(6, 'Add cart'),
      ],
      [bugIssue],
      evidence,
    );
    expect(result.get(1)).toEqual({
      reason: 'resolves issue #12, labelled bug',
      level: 'DERIVED',
      confidence: 0.9,
      evidenceIds: [101, 55],
    });
    expect(result.get(2)).toMatchObject({
      level: 'INFERRED',
      confidence: DEFECT_CONFIDENCE.revert,
    });
    expect(result.get(3)).toMatchObject({ confidence: DEFECT_CONFIDENCE.conventionalFix });
    expect(result.get(4)).toMatchObject({
      reason: 'subject says "Crash"',
      confidence: DEFECT_CONFIDENCE.fixWords,
    });
    expect(result.has(5)).toBe(false);
    expect(result.has(6)).toBe(false);
  });

  it('ignores issues that are not labelled as bugs', () => {
    const feature = {
      commitId: 6,
      type: 'issue',
      number: '3',
      repo: null,
      provider: 'github',
      title: 'Cart',
      body: '',
      labels: ['feature'],
      relation: 'RESOLVED_BY',
      level: 'DERIVED',
      confidence: 0.9,
      evidenceIds: [],
    } as const;
    expect(classifyDefects([commit(6, 'Add cart')], [feature], evidence).size).toBe(0);
  });
});

describe('importReach', () => {
  // app → cart → vat, test → cart, and a cycle vat → app.
  const edges = [
    { source: 1, target: 2 },
    { source: 2, target: 3 },
    { source: 4, target: 2 },
    { source: 3, target: 1 },
  ];

  it('counts direct and transitive importers once, and the tests among them', () => {
    const reach = importReach([1, 2, 3, 4], edges, (id) => id === 4);
    expect(reach.get(3)).toEqual({ dependents: 3, tests: 1 });
    expect(reach.get(2)).toEqual({ dependents: 3, tests: 1 });
    expect(reach.get(4)).toEqual({ dependents: 0, tests: 0 });
  });

  it('stops at the depth limit', () => {
    expect(importReach([3], edges, () => false, 1).get(3)).toEqual({ dependents: 1, tests: 0 });
  });
});

describe('isGeneratedPath', () => {
  it.each([
    'pnpm-lock.yaml',
    'apps/web/package-lock.json',
    'go.sum',
    'dist/index.js',
    'packages/ui/build/app.css',
    'vendor/lib/x.go',
    'static/app.min.js',
    'src/__snapshots__/a.test.ts.snap',
    'packages/db/drizzle/meta/0005_snapshot.json',
  ])('treats %s as generated', (path) => {
    expect(isGeneratedPath(path)).toBe(true);
  });

  it.each(['src/build.ts', 'packages/db/src/schema.ts', 'docs/vendoring.md', 'lock.ts'])(
    'treats %s as written by people',
    (path) => {
      expect(isGeneratedPath(path)).toBe(false);
    },
  );
});

describe('isCodePath', () => {
  it('ranks source code, not documentation or configuration', () => {
    expect(
      ['lib/response.js', 'src/app.ts', 'main.go', 'db/schema.sql', 'styles/app.css'].map(
        isCodePath,
      ),
    ).toEqual([true, true, true, true, true]);
    expect(
      [
        'History.md',
        'package.json',
        '.github/workflows/ci.yml',
        'Cargo.toml',
        'LICENSE',
        'logo.png',
      ].map(isCodePath),
    ).toEqual([false, false, false, false, false, false]);
  });
});

describe('defect wording that is not about code', () => {
  const commit = (id: number, subject: string): AnalysisCommit => ({
    id,
    sha: String(id).padStart(40, 'b'),
    subject,
    body: '',
    committedAt: '2026-01-01',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
  });
  it('ignores dependency bumps and documentation fixes', () => {
    const result = classifyDefects(
      [
        commit(1, 'fix(deps): qs@^6.14.0 (#6374)'),
        commit(2, 'deps: bump body-parser to fix CVE-2026-1'),
        commit(3, 'Fix an incorrect @api jsdoc'),
        commit(4, 'fix(ci): pin the runner'),
        commit(6, 'fix(refactor): prefix built-in node module imports'),
        commit(7, 'documentation language fix'),
        commit(5, 'fix(res.send): preserve ETag generation'),
      ],
      [],
      new Map(),
    );
    expect([...result.keys()]).toEqual([5]);
  });

  it('ignores fixes to type annotations and linter findings', () => {
    const result = classifyDefects(
      [
        commit(1, 'fix typing'),
        commit(2, 'fix pyright type errors'),
        commit(3, 'type hint fix for flask.send_file'),
        commit(4, 'fix mypy finding with new werkzeug endpoint type'),
        commit(5, 'Fix ruff warnings'),
        commit(6, 'Fix subdomain inheritance for nested blueprints.'),
      ],
      [],
      new Map(),
    );
    expect([...result.keys()]).toEqual([6]);
  });
});

describe('declaration files', () => {
  it('recognises TypeScript declaration files only', () => {
    expect(['index.d.ts', 'types/x.d.mts', 'a/b.d.cts'].every(isDeclarationPath)).toBe(true);
    expect(['index.ts', 'xd-ts', 'a.d.tsx', 'd.ts.js'].some(isDeclarationPath)).toBe(false);
  });
});
