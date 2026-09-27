// Print the CHANGELOG.md section of one version (release notes).
// Usage: node scripts/changelog-section.mjs 0.1.0
import { readFileSync } from 'node:fs';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: changelog-section.mjs <version>');
  process.exit(2);
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && /^## \[/.test(line));
console.log(
  lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => !/^\[[^\]]+\]: /.test(line))
    .join('\n')
    .trim(),
);
