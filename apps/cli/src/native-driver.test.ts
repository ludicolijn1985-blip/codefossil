import { describe, expect, it } from 'vitest';
import { explainMissingNativeDriver } from './native-driver.js';

describe('explainMissingNativeDriver', () => {
  it('explains a missing better-sqlite3 binary and how to allow install scripts', () => {
    const message = 'Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node';

    const explanation = explainMissingNativeDriver(message);

    expect(explanation).toContain('ignore-scripts=true');
    expect(explanation).toContain('npx --ignore-scripts=false codefossil');
    expect(explanation).not.toContain('better_sqlite3.node');
  });

  it('leaves other errors alone', () => {
    expect(explainMissingNativeDriver('SQLITE_BUSY: database is locked')).toBeNull();
  });
});
