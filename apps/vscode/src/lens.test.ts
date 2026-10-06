import { describe, expect, it } from 'vitest';
import {
  escapeMarkdown,
  hoverMarkdown,
  lensTitle,
  parseLens,
  symbolAt,
  type LensEntry,
} from './lens.js';

const entry = (overrides: Partial<LensEntry> = {}): LensEntry => ({
  qualifiedName: 'res.send',
  kind: 'method',
  startLine: 126,
  endLine: 200,
  born: {
    sha: '99820e7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    date: '2011-02-04',
    subject: 'Refactored req/res proto assignments',
    author: 'TJ',
    level: 'DERIVED',
    issues: ['#12'],
  },
  copiedFrom: null,
  changes: 78,
  fixes: 17,
  authors: 23,
  callers: 64,
  lastChange: {
    sha: '9a34acfbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    date: '2026-09-15',
    subject: 'fix: ETag',
  },
  ...overrides,
});

describe('lens text', () => {
  it('summarises a function in one line, leaving out zero fixes and callers', () => {
    expect(lensTitle(entry())).toBe('born 2011 · 78 changes · 17 fixes · 64 callers');
    expect(
      lensTitle(entry({ born: null, changes: 1, fixes: 0, callers: 0, copiedFrom: 'lib/http.js' })),
    ).toBe('born before the indexed history · moved · 1 change');
  });

  it('keeps repository text from becoming links, HTML or formatting in hovers', () => {
    const hostile = entry({
      born: {
        sha: 'abcdef1234567',
        date: '2020-01-01',
        subject: '[click](https://evil.example) <img src=x> **bold**',
        author: '@someone',
        level: 'DERIVED',
        issues: [],
      },
    });
    const markdown = hoverMarkdown(hostile);
    expect(markdown).not.toContain('[click](');
    // Every markdown and HTML character arrives escaped, so it renders as plain text.
    expect(markdown).not.toMatch(/(?<!\\)<img/);
    expect(markdown).toContain('\\<img src=x\\>');
    expect(markdown).toContain('\\[click\\]\\(https://evil\\.example\\)');
    expect(escapeMarkdown('a\nb')).toBe('a b');
  });
});

describe('lens data', () => {
  it('parses the lens JSON and ignores malformed entries', () => {
    const lens = parseLens(
      JSON.stringify({ path: 'lib/response.js', headSha: 'abc', symbols: [entry(), { nope: 1 }] }),
    );
    expect(lens?.symbols).toHaveLength(1);
    expect(parseLens('not json')).toBeNull();
    expect(parseLens('{"symbols": []}')).toBeNull();
  });

  it('finds the innermost symbol at a line', () => {
    const lens = {
      path: 'a.ts',
      headSha: null,
      symbols: [
        entry({ qualifiedName: 'Cart', startLine: 1, endLine: 50 }),
        entry({ qualifiedName: 'Cart.total', startLine: 10, endLine: 20 }),
      ],
    };
    expect(symbolAt(lens, 15)?.qualifiedName).toBe('Cart.total');
    expect(symbolAt(lens, 30)?.qualifiedName).toBe('Cart');
    expect(symbolAt(lens, 60)).toBeNull();
  });
});
