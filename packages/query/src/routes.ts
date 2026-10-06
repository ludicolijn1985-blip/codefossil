import type { Step, StepTable } from './traverse.js';

/**
 * From a change to its reasons: which pull request carried the commit, which
 * issue it resolved or mentioned. Shared by the origin and history routes.
 */
const CHANGE_CONTEXT: StepTable = {
  commit: [
    { relation: 'IMPLEMENTED_BY', direction: 'in', to: ['pull_request'] },
    { relation: 'RESOLVED_BY', direction: 'in', to: ['issue'] },
    { relation: 'REFERENCES', direction: 'out', to: ['issue', 'pull_request'] },
  ],
  pull_request: [
    { relation: 'RESOLVED_BY', direction: 'in', to: ['issue'] },
    { relation: 'REFERENCES', direction: 'out', to: ['issue'] },
  ],
};

/**
 * Why does this exist? Origin chains, as in ARCHITECTURE.md:
 * symbol → introduced by commit ← implemented by PR ← resolved by issue.
 * A file's origin is found among the commits that touched it.
 */
export const ORIGIN_ROUTE: StepTable = {
  ...CHANGE_CONTEXT,
  symbol: [{ relation: 'INTRODUCED_BY', direction: 'out', to: ['commit'] }],
  file: [{ relation: 'MODIFIES', direction: 'in', to: ['commit'] }],
};

/** What changed it, and why? Every commit that modified the symbol or file, with context. */
export const HISTORY_ROUTE: StepTable = {
  ...CHANGE_CONTEXT,
  symbol: [{ relation: 'MODIFIES', direction: 'in', to: ['commit'] }],
  file: [{ relation: 'MODIFIES', direction: 'in', to: ['commit'] }],
};

const IMPORTED_BY: Step = { relation: 'IMPORTS', direction: 'in', to: ['file'] };

/**
 * Who calls it? Callers of a symbol, transitively. A file calls only at module
 * level and has no callers itself, so a path ends there.
 */
export const CALLERS_ROUTE: StepTable = {
  symbol: [{ relation: 'CALLS', direction: 'in', to: ['symbol', 'file'] }],
};

/**
 * What depends on it? Reverse dependencies: a symbol's file, the files that
 * import it, and so on transitively; for a package, the files using it.
 */
export const IMPACT_ROUTE: StepTable = {
  symbol: [{ relation: 'CONTAINS', direction: 'in', to: ['file'] }],
  file: [IMPORTED_BY],
  dependency: [{ relation: 'DEPENDS_ON', direction: 'in', to: ['file'] }],
};
