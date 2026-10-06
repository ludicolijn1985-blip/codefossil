// Render captured CODEFOSSIL terminal output as a PNG for the README and posts.
//
//   node scripts/terminal-shot.mjs --title expressjs/express \
//     --command "npx codefossil why res.sendFile" --input why.txt --output docs/images/why.png
//
// The text is escaped and coloured by pattern (levels, short shas, section headings);
// nothing in it is interpreted as HTML. Uses the Playwright Chromium installed for apps/web's end-to-end tests.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'apps', 'web', 'package.json'))('@playwright/test');

const { values } = parseArgs({
  options: {
    title: { type: 'string', default: '' },
    command: { type: 'string', default: '' },
    input: { type: 'string' },
    output: { type: 'string' },
    width: { type: 'string', default: '1180' },
  },
});
if (!values.input || !values.output) {
  console.error('Usage: terminal-shot.mjs --input <file> --output <png> [--title t] [--command c]');
  process.exit(2);
}

const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const LEVELS = { FACT: 'fact', DERIVED: 'derived', INFERRED: 'inferred' };
const HEADINGS = new Set(['Statements', 'Evidence', 'Notes', 'Direct', 'Transitive']);

function colour(line, index) {
  const html = escape(line);
  if (index === 0) return `<b>${html}</b>`;
  if (HEADINGS.has(line.trim()) || /^[A-Z][\w -]+ \(\d+\)$/.test(line.trim())) {
    return `<span class="dim">${html}</span>`;
  }
  return html
    .replace(
      /\b(FACT|DERIVED|INFERRED)\b/g,
      (level) => `<span class="${LEVELS[level]}">${level}</span>`,
    )
    .replace(/(^|[\s(])([0-9a-f]{7})(?=[\s")]|$)/g, '$1<span class="sha">$2</span>')
    .replace(/^(\s*)(\[\d+\])/, '$1<span class="dim">$2</span>');
}

const lines = readFileSync(resolve(values.input), 'utf8').replace(/\s+$/, '').split('\n');
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #0b0d10; }
  .window { width: ${Number(values.width)}px; background: #0f1216; border: 1px solid #232831;
    font: 14.5px/1.6 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace; color: #e6e9ee; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #1d2229; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { margin-left: 14px; color: #8b93a1; font-size: 12.5px; }
  pre { margin: 0; padding: 22px 20px 26px; white-space: pre-wrap; font: inherit; }
  .prompt { color: #4ade80; } .fact { color: #5eead4; } .derived { color: #93a8ff; }
  .inferred { color: #fbbf24; } .sha { color: #c084fc; } .dim { color: #8b93a1; } b { color: #fff; }
</style><div class="window"><div class="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
  <span class="dot" style="background:#28c840"></span><span class="title">${escape(values.title)}</span></div>
<pre>${values.command ? `<span class="prompt">$</span> <b>${escape(values.command)}</b>\n\n` : ''}${lines.map(colour).join('\n')}</pre></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: Number(values.width), height: 400 },
  });
  await page.setContent(html);
  await page.locator('.window').screenshot({ path: resolve(values.output) });
} finally {
  await browser.close();
}
console.log(`Wrote ${values.output}`);
