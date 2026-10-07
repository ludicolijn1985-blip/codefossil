import { describe, expect, it } from 'vitest';
import { bindingMayReach } from './impact.js';

describe('bindingMayReach', () => {
  const defined = new Set(['calculateVAT', 'RATE', 'Cart', 'Cart.total', 'Outer.Inner']);

  it('keeps imports that may give access to the symbol', () => {
    expect(bindingMayReach('*', 'calculateVAT', defined)).toBe(true);
    expect(bindingMayReach('default', 'calculateVAT', defined)).toBe(true);
    expect(bindingMayReach('calculateVAT', 'calculateVAT', defined)).toBe(true);
    // The container of a method, and a member of the symbol (Java `import static C.m`).
    expect(bindingMayReach('Cart', 'Cart.total', defined)).toBe(true);
    expect(bindingMayReach('Cart.total', 'Cart', defined)).toBe(true);
    // Names the file does not define: a submodule (`from pkg import utils`), an alias, a nested
    // class imported by its own name.
    expect(bindingMayReach('utils', 'helper', defined)).toBe(true);
    expect(bindingMayReach('Inner', 'Outer.Inner', defined)).toBe(true);
  });

  it('leaves out an import that names another definition of the file', () => {
    expect(bindingMayReach('RATE', 'calculateVAT', defined)).toBe(false);
    expect(bindingMayReach('Cart', 'calculateVAT', defined)).toBe(false);
  });
});
