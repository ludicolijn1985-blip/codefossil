// Bundle the extension into one CommonJS file VS Code loads; `vscode` is provided by the editor.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'warning',
});
