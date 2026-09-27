import { describe, expect, it } from 'vitest';
import {
  extendedConfigPaths,
  isTsConfigPath,
  parseTsConfig,
  resolveExtends,
  stripJsonComments,
  TsConfigParseError,
} from './tsconfig.js';

describe('tsconfig parsing', () => {
  it('accepts comments, trailing commas and a BOM, leaving strings intact', () => {
    const content = [
      '﻿{',
      '  // line comment',
      '  "extends": "./base", /* block */',
      '  "compilerOptions": {',
      '    "baseUrl": "./src",',
      '    "paths": { "@/*": ["./*",], "url": ["http://x/*,}"], },',
      '  },',
      '}',
    ].join('\n');
    expect(parseTsConfig('app/tsconfig.json', content)).toEqual({
      path: 'app/tsconfig.json',
      extends: ['./base'],
      baseUrl: './src',
      paths: { '@/*': ['./*'], url: ['http://x/*,}'] },
    });
  });

  it('keeps escaped quotes and comment markers inside strings', () => {
    expect(JSON.parse(stripJsonComments('{"a": "x\\" // y", "b": "/* z */"}'))).toEqual({
      a: 'x" // y',
      b: '/* z */',
    });
  });

  it('reads extends arrays and drops patterns TypeScript rejects', () => {
    const config = parseTsConfig(
      'tsconfig.json',
      JSON.stringify({
        extends: ['./a.json', './b.json'],
        compilerOptions: { paths: { '*/*': ['x'], 'ok/*': ['a/*/*', 'src/*'] } },
      }),
    );
    expect(config.extends).toEqual(['./a.json', './b.json']);
    expect(config.paths).toEqual({ 'ok/*': ['src/*'] });
    expect(config.baseUrl).toBeNull();
  });

  it('reports invalid content as a parse error', () => {
    expect(() => parseTsConfig('tsconfig.json', '{ nope')).toThrow(TsConfigParseError);
    expect(() => parseTsConfig('tsconfig.json', '[]')).toThrow(/not a JSON object/);
  });

  it('recognises config file names', () => {
    expect(isTsConfigPath('tsconfig.json')).toBe(true);
    expect(isTsConfigPath('apps/web/tsconfig.base.json')).toBe(true);
    expect(isTsConfigPath('jsconfig.json')).toBe(true);
    expect(isTsConfigPath('src/config.json')).toBe(false);
    expect(isTsConfigPath('tsconfig.ts')).toBe(false);
  });

  it('resolves extends only within the repository', () => {
    const files = new Set(['tsconfig.base.json', 'apps/web/tsconfig.json', 'configs/strict.json']);
    expect(resolveExtends('apps/web/tsconfig.json', '../../tsconfig.base.json', files)).toBe(
      'tsconfig.base.json',
    );
    // Like tsc, the `.json` extension may be left out.
    expect(resolveExtends('apps/web/tsconfig.json', '../../configs/strict', files)).toBe(
      'configs/strict.json',
    );
    expect(resolveExtends('apps/web/tsconfig.json', '../../../outside.json', files)).toBeNull();
    expect(resolveExtends('tsconfig.json', '@tsconfig/node22/tsconfig.json', files)).toBeNull();
    expect(resolveExtends('tsconfig.json', '/etc/tsconfig.json', files)).toBeNull();
    expect(resolveExtends('tsconfig.json', './missing.json', files)).toBeNull();

    const config = parseTsConfig(
      'apps/web/tsconfig.json',
      JSON.stringify({ extends: ['../../tsconfig.base.json', '@tsconfig/next'] }),
    );
    expect(extendedConfigPaths(config, files)).toEqual(['tsconfig.base.json']);
  });
});
