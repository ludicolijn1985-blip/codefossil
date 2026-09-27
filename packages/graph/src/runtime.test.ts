import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifests.js';
import { compareVersions, formatVersion, minimumVersion } from './runtime.js';

describe('minimumVersion', () => {
  it.each([
    ['>=22', { major: 22, minor: 0 }],
    ['>= 18.12.0', { major: 18, minor: 12 }],
    ['^20.x', { major: 20, minor: 0 }],
    ['^18 || ^20 || >=22', { major: 18, minor: 0 }],
    ['>=3.10,<3.13', { major: 3, minor: 10 }],
    ['~=3.9', { major: 3, minor: 9 }],
    ['>=1.22', { major: 1, minor: 22 }],
    ['22', { major: 22, minor: 0 }],
    ['v16', { major: 16, minor: 0 }],
  ])('%s admits %o at the oldest', (constraint, expected) => {
    expect(minimumVersion(constraint)).toEqual(expected);
  });

  it('finds no lower bound in upper-only or open constraints', () => {
    expect(minimumVersion('<23')).toBeNull();
    expect(minimumVersion('*')).toBeNull();
    expect(minimumVersion('!=3.0')).toBeNull();
  });

  it('orders and formats versions per runtime', () => {
    expect(compareVersions({ major: 3, minor: 9 }, { major: 3, minor: 10 })).toBeLessThan(0);
    expect(formatVersion({ major: 22, minor: 0 }, 'node')).toBe('22');
    expect(formatVersion({ major: 1, minor: 22 }, 'go')).toBe('1.22');
    expect(formatVersion({ major: 3, minor: 10 }, 'python')).toBe('3.10');
  });
});

describe('declared runtimes', () => {
  it('reads engines.node from package.json', () => {
    const manifest = parseManifest('package.json', '{"engines":{"node":">=22.12"}}');
    expect(manifest.runtimes).toEqual([{ runtime: 'node', constraint: '>=22.12' }]);
  });

  it('reads the go directive, rust-version and requires-python', () => {
    expect(parseManifest('go.mod', 'module x\n\ngo 1.22\n').runtimes).toEqual([
      { runtime: 'go', constraint: '>=1.22' },
    ]);
    expect(
      parseManifest('Cargo.toml', '[package]\nname = "x"\nrust-version = "1.70"\n').runtimes,
    ).toEqual([{ runtime: 'rust', constraint: '>=1.70' }]);
    expect(
      parseManifest('pyproject.toml', '[project]\nname = "x"\nrequires-python = ">=3.10"\n')
        .runtimes,
    ).toEqual([{ runtime: 'python', constraint: '>=3.10' }]);
    expect(
      parseManifest('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.9"\n').runtimes,
    ).toEqual([{ runtime: 'python', constraint: '^3.9' }]);
  });

  it('declares nothing when the manifest is silent', () => {
    expect(parseManifest('package.json', '{"name":"x"}').runtimes).toEqual([]);
    expect(parseManifest('requirements.txt', 'zod\n').runtimes).toEqual([]);
  });
});
