import { describe, expect, it } from 'vitest';
import { mdCode, mdText } from './format-report.js';

describe('markdown escaping for untrusted repository text', () => {
  it('keeps text on one line and inside its table cell', () => {
    expect(mdText('fix: a | b\n\n| injected | row |')).toBe(
      'fix: a \\| b \\| injected \\| row \\|',
    );
  });

  it('neutralizes HTML, links, emphasis and mentions', () => {
    const escaped = mdText(
      '<img src=x onerror=alert(1)> [click](https://evil.example) **bold** @maintainer',
    );
    expect(escaped).not.toMatch(/(^|[^\\])[<[(*]/);
    expect(escaped).toContain('@\u200bmaintainer');
  });

  it('shortens long text', () => {
    expect(mdText('a'.repeat(500), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('keeps a code span inside its table cell', () => {
    expect(mdCode('src/a|b.ts')).toBe('`src/a\\|b.ts`');
  });

  it('keeps inline code closed and silent', () => {
    expect(mdCode('src/`x`.ts')).toBe('`src/ x .ts`');
    expect(mdCode('@team/pkg')).toBe('`@\u200bteam/pkg`');
  });
});
