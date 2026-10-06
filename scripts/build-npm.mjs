// Build the publishable `codefossil` npm package into packaging/npm.
//
// The workspace packages are bundled into one file; third-party packages stay
// ordinary dependencies. Tree-sitter grammars ship as WebAssembly files so
// installing the package never compiles anything, and the SQLite migrations
// ship beside the bundle where the database client looks for them.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'packaging', 'npm');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

/** Third-party runtime dependencies of the bundled workspace packages. */
const EXTERNAL = [
  '@anthropic-ai/sdk',
  '@fastify/rate-limit',
  '@modelcontextprotocol/server',
  'better-sqlite3',
  'commander',
  'drizzle-orm',
  'fastify',
  'smol-toml',
  'web-tree-sitter',
  'zod',
];
const GRAMMARS = [
  ['tree-sitter-typescript', ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm']],
  ['tree-sitter-javascript', ['tree-sitter-javascript.wasm']],
  ['tree-sitter-python', ['tree-sitter-python.wasm']],
  ['tree-sitter-go', ['tree-sitter-go.wasm']],
  ['tree-sitter-rust', ['tree-sitter-rust.wasm']],
];

function versionOf(name) {
  for (const dir of [
    'apps/cli',
    'apps/api',
    'packages/ai',
    'packages/db',
    'packages/graph',
    'packages/parser',
  ]) {
    const version = read(`${dir}/package.json`).dependencies?.[name];
    if (version) return version;
  }
  throw new Error(`No workspace package declares ${name}`);
}

for (const generated of [
  'dist',
  'drizzle',
  'grammars',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]) {
  rmSync(join(out, generated), { recursive: true, force: true });
}
mkdirSync(join(out, 'grammars'), { recursive: true });

await build({
  entryPoints: [join(root, 'apps/cli/src/bin.ts')],
  outfile: join(out, 'dist/codefossil.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['@codefossil/source'],
  external: EXTERNAL,
  legalComments: 'none',
  logLevel: 'warning',
});

cpSync(join(root, 'packages/db/drizzle'), join(out, 'drizzle'), { recursive: true });

const notices = [
  '# Third-party notices',
  '',
  'The `grammars/` directory contains Tree-sitter grammars:',
  '',
];
for (const [pkg, files] of GRAMMARS) {
  const dir = join(root, 'packages/parser/node_modules', pkg);
  for (const file of files) cpSync(join(dir, file), join(out, 'grammars', file));
  const license = existsSync(join(dir, 'LICENSE'))
    ? readFileSync(join(dir, 'LICENSE'), 'utf8').trim()
    : 'MIT';
  notices.push(
    `## ${pkg} ${read(`packages/parser/node_modules/${pkg}/package.json`).version}`,
    '',
    '```text',
    license,
    '```',
    '',
  );
}
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const cli = read('apps/cli/package.json');
const manifest = {
  name: 'codefossil',
  version: cli.version,
  description:
    'Ask your Git history why code exists — evidence-first answers with provenance, hotspots, impact and dead-intent detection. Local-first.',
  keywords: [
    'git',
    'git-history',
    'software-archaeology',
    'code-intelligence',
    'provenance',
    'hotspots',
    'impact-analysis',
    'developer-tools',
    'cli',
    'tree-sitter',
  ],
  license: 'MIT',
  homepage: 'https://github.com/ludicolijn1985-blip/codefossil#readme',
  bugs: 'https://github.com/ludicolijn1985-blip/codefossil/issues',
  repository: { type: 'git', url: 'git+https://github.com/ludicolijn1985-blip/codefossil.git' },
  type: 'module',
  bin: { codefossil: 'dist/codefossil.js' },
  files: ['dist', 'drizzle', 'grammars', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  engines: { node: '>=22.12.0' },
  dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, versionOf(name)])),
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`codefossil ${manifest.version} written to packaging/npm`);
