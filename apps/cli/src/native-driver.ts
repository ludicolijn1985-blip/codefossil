/**
 * better-sqlite3 ships its native driver through an install script. When npm
 * skipped that script (often a repository's own `.npmrc` with
 * `ignore-scripts=true`, which npx honours in that directory), loading fails
 * with a long list of tried paths. Returns a short explanation with the fix,
 * or null for any other error.
 */
export function explainMissingNativeDriver(message: string): string | null {
  if (!message.includes('Could not locate the bindings file')) return null;
  return [
    'the SQLite driver (better-sqlite3) was installed without its native binary.',
    'npm skipped its install script, usually because an .npmrc in this repository sets',
    'ignore-scripts=true. Allow scripts for this one command:',
    '',
    '  npx --ignore-scripts=false codefossil <command>',
    '',
    'or install it once globally: npm install -g codefossil',
  ].join('\n');
}
