import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedPythonImports, packageConfigPath, withPackageExtends } from './installed.js';

describe('installed packages', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codefossil-installed-'));
    outside = await mkdtemp(join(tmpdir(), 'codefossil-outside-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const write = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };

  it('follows a workspace package in node_modules back into the repository', async () => {
    await write(join(root, 'packages/tsconfig/base.json'), '{}');
    await mkdir(join(root, 'node_modules/@repo'), { recursive: true });
    // pnpm and npm workspaces link packages; a junction needs no privileges on Windows.
    await symlink(
      join(root, 'packages/tsconfig'),
      join(root, 'node_modules/@repo/tsconfig'),
      'junction',
    );
    await write(join(outside, 'base.json'), '{}');
    await mkdir(join(root, 'node_modules/@tsconfig'), { recursive: true });
    await symlink(outside, join(root, 'node_modules/@tsconfig/node22'), 'junction');

    expect(packageConfigPath(root, 'apps/web/tsconfig.json', '@repo/tsconfig/base.json')).toBe(
      'packages/tsconfig/base.json',
    );
    expect(packageConfigPath(root, 'tsconfig.json', '@repo/tsconfig/base')).toBe(
      'packages/tsconfig/base.json',
    );
    // Installed from a registry, outside the repository: not read.
    expect(packageConfigPath(root, 'tsconfig.json', '@tsconfig/node22/base.json')).toBeNull();
    expect(packageConfigPath(root, 'tsconfig.json', '@repo/../../etc/passwd')).toBeNull();
    expect(packageConfigPath(root, 'tsconfig.json', 'missing/tsconfig.json')).toBeNull();

    const config = withPackageExtends(root, {
      path: 'apps/web/tsconfig.json',
      extends: ['@repo/tsconfig/base.json', './local.json', '@tsconfig/node22/base.json'],
    } as never);
    expect(config.extends).toEqual([
      '../../packages/tsconfig/base.json',
      './local.json',
      '@tsconfig/node22/base.json',
    ]);
  });

  it('reads the import names of distributions in a virtual environment', async () => {
    const site = join(root, '.venv/lib/python3.12/site-packages');
    await write(join(root, '.venv/pyvenv.cfg'), 'home = /usr/bin\n');
    await write(join(site, 'PyYAML-6.0.2.dist-info/top_level.txt'), '_yaml\nyaml\n');
    await write(
      join(site, 'beautifulsoup4-4.12.3.dist-info/RECORD'),
      'bs4/__init__.py,sha256=x,1\nbs4/element.py,sha256=y,2\nbeautifulsoup4-4.12.3.dist-info/METADATA,,\n',
    );
    await write(join(site, 'six-1.16.0.dist-info/RECORD'), 'six.py,sha256=z,3\n');

    const imports = installedPythonImports(root);

    expect(imports.get('yaml')).toEqual(['PyYAML']);
    expect(imports.get('bs4')).toEqual(['beautifulsoup4']);
    expect(imports.get('six')).toEqual(['six']);
  });

  it('reads nothing without a virtual environment', () => {
    expect(installedPythonImports(root).size).toBe(0);
  });
});
