import { describe, expect, it } from 'vitest';
import { parseReferences } from './references.js';
import { defaultApiUrl, parseGitHubRemote, parseGitHubSlug } from './remote.js';

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/acme/shop.git', 'github.com', 'acme', 'shop'],
    ['https://github.com/acme/shop', 'github.com', 'acme', 'shop'],
    ['git@github.com:acme/shop.git', 'github.com', 'acme', 'shop'],
    ['ssh://git@github.example.com/acme/shop.js.git', 'github.example.com', 'acme', 'shop.js'],
  ])('%s', (remote, host, owner, name) => {
    expect(parseGitHubRemote(remote)).toEqual({ host, owner, name });
  });

  it.each([
    '/local/path/repo',
    'https://github.com/acme',
    'https://github.com/a/b/c',
    'file:///x/y',
  ])('rejects %s', (remote) => {
    expect(parseGitHubRemote(remote)).toBeNull();
  });

  it('parses slugs and derives API URLs', () => {
    expect(parseGitHubSlug('acme/shop')).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'shop',
    });
    expect(parseGitHubSlug('acme')).toBeNull();
    expect(parseGitHubSlug('acme/shop/x')).toBeNull();
    expect(defaultApiUrl('github.com')).toBe('https://api.github.com');
    expect(defaultApiUrl('git.corp.example')).toBe('https://git.corp.example/api/v3');
  });
});

describe('parseReferences', () => {
  const refs = (text: string) => parseReferences(text, 'acme', 'shop');

  it('finds closing keywords in their documented forms', () => {
    expect(refs('Fixes #12')).toEqual([{ number: 12, repo: null, closing: true }]);
    expect(refs('This closes: #3 and resolved acme/shop#4')).toEqual([
      { number: 3, repo: null, closing: true },
      { number: 4, repo: null, closing: true },
    ]);
    expect(refs('FIX #5')).toEqual([{ number: 5, repo: null, closing: true }]);
  });

  it('treats a bare mention as a non-closing reference', () => {
    expect(refs('Follow-up to #7 (see GH-8)')).toEqual([
      { number: 7, repo: null, closing: false },
      { number: 8, repo: null, closing: false },
    ]);
  });

  it('only closes the issue the keyword applies to', () => {
    expect(refs('Fixes #1, #2')).toEqual([
      { number: 1, repo: null, closing: true },
      { number: 2, repo: null, closing: false },
    ]);
  });

  it('merges repeated mentions, closing if any mention closes', () => {
    expect(refs('See #9. Later: fixes #9.')).toEqual([{ number: 9, repo: null, closing: true }]);
  });

  it('ignores URL fragments, HTML entities, colors and prefixes', () => {
    expect(refs('https://x.org/page#2 &#3; color #fff abc#4 prefix-#5 issue#6')).toEqual([]);
  });

  it('reports references to other repositories with their lower-cased name', () => {
    expect(refs('Fixes Other/Repo#1, see other/repo#1 and #1')).toEqual([
      { number: 1, repo: 'other/repo', closing: true },
      { number: 1, repo: null, closing: false },
    ]);
  });

  it('matches the repository case-insensitively', () => {
    expect(refs('fixes ACME/Shop#10')).toEqual([{ number: 10, repo: null, closing: true }]);
  });

  it('ignores "fixes" that is not directly before the reference', () => {
    expect(refs('This fixes the bug described in #11')).toEqual([
      { number: 11, repo: null, closing: false },
    ]);
  });
});
