import { afterAll, describe, expect, it } from 'vitest';
import { SymbolExtractor } from './parser.js';
import type { GrammarId } from './spec.js';

const extractor = new SymbolExtractor();

afterAll(async () => {
  await extractor.dispose();
});

async function imports(grammar: GrammarId, source: string) {
  const result = await extractor.extract(source, grammar);
  return result?.imports.map(({ specifier, kind, line, names }) =>
    names === undefined ? { specifier, kind, line } : { specifier, kind, line, names },
  );
}

describe('ECMAScript imports', () => {
  it('finds static, re-exported, required and dynamic imports', async () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from '../types';",
      "import './side-effect';",
      "export { c } from '@scope/pkg/sub';",
      "export * from 'lib';",
      'export const local = 1;',
      "const fs = require('node:fs');",
      'async function load() {',
      "  const m = await import('./lazy.js');",
      '  const dynamic = await import(name);',
      '}',
      "import './a.js';",
    ].join('\n');
    expect(await imports('typescript', source)).toEqual([
      { specifier: './a.js', kind: 'import', line: 1 },
      { specifier: '../types', kind: 'import', line: 2 },
      { specifier: './side-effect', kind: 'import', line: 3 },
      { specifier: '@scope/pkg/sub', kind: 'reexport', line: 4 },
      { specifier: 'lib', kind: 'reexport', line: 5 },
      { specifier: 'node:fs', kind: 'require', line: 7 },
      { specifier: './lazy.js', kind: 'dynamic', line: 9 },
    ]);
  });

  it('works for JavaScript and TSX grammars', async () => {
    expect(await imports('javascript', "const x = require('x');")).toEqual([
      { specifier: 'x', kind: 'require', line: 1 },
    ]);
    expect(
      await imports('tsx', "import React from 'react';\nexport const A = () => <div />;"),
    ).toEqual([{ specifier: 'react', kind: 'import', line: 1 }]);
  });
});

describe('Python imports', () => {
  it('finds plain, aliased, from and relative imports with their names', async () => {
    const source = [
      'import os, json as j',
      'import pkg.sub',
      'from . import models, views as v',
      'from ..core.db import connect',
      'from requests import Session',
      'def f():',
      '    import lazy',
    ].join('\n');
    expect(await imports('python', source)).toEqual([
      { specifier: 'os', kind: 'import', line: 1 },
      { specifier: 'json', kind: 'import', line: 1 },
      { specifier: 'pkg.sub', kind: 'import', line: 2 },
      { specifier: '.', kind: 'from', line: 3, names: ['models', 'views'] },
      { specifier: '..core.db', kind: 'from', line: 4, names: ['connect'] },
      { specifier: 'requests', kind: 'from', line: 5, names: ['Session'] },
      { specifier: 'lazy', kind: 'import', line: 7 },
    ]);
  });
});

describe('repeated imports', () => {
  it('merges the names of every Python from-import of the same module', async () => {
    const source = ['from pkg import a', 'def f():', '    from pkg import b, a'].join('\n');
    expect(await imports('python', source)).toEqual([
      { specifier: 'pkg', kind: 'from', line: 1, names: ['a', 'b'] },
    ]);
  });
});

describe('Go imports', () => {
  it('finds single and grouped imports, with or without aliases', async () => {
    const source = [
      'package main',
      'import "fmt"',
      'import (',
      '  "github.com/acme/shop/tax"',
      '  log "github.com/sirupsen/logrus"',
      ')',
    ].join('\n');
    expect(await imports('go', source)).toEqual([
      { specifier: 'fmt', kind: 'import', line: 2 },
      { specifier: 'github.com/acme/shop/tax', kind: 'import', line: 4 },
      { specifier: 'github.com/sirupsen/logrus', kind: 'import', line: 5 },
    ]);
  });
});

describe('Rust imports', () => {
  it('finds module files, use paths and extern crates', async () => {
    const source = [
      'mod tax;',
      'mod inline { pub fn f() {} }',
      'use crate::tax::{rate, apply};',
      'use super::util::*;',
      'use std::io::Read;',
      'use serde::Serialize as Ser;',
      'extern crate log;',
    ].join('\n');
    expect(await imports('rust', source)).toEqual([
      { specifier: 'tax', kind: 'mod', line: 1 },
      { specifier: 'crate::tax', kind: 'use', line: 3 },
      { specifier: 'super::util', kind: 'use', line: 4 },
      { specifier: 'std::io::Read', kind: 'use', line: 5 },
      { specifier: 'serde::Serialize', kind: 'use', line: 6 },
      { specifier: 'log', kind: 'use', line: 7 },
    ]);
  });
});
