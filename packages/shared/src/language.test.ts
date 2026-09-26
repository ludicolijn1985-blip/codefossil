import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language.js';

describe('detectLanguage', () => {
  it.each([
    ['src/payment/vat.ts', 'typescript'],
    ['App.TSX', 'typescript'],
    ['lib/util.mjs', 'javascript'],
    ['main.py', 'python'],
    ['cmd/server/main.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['docs/v1.2/README.md', 'markdown'],
  ])('%s is %s', (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });

  it.each(['Makefile', '.gitignore', 'assets/logo.png', 'archive.tar.xz', 'dir.d/file'])(
    'returns null for %s',
    (path) => {
      expect(detectLanguage(path)).toBeNull();
    },
  );
});
