import {
  commitsByShaPrefix,
  dependenciesByName,
  entityKey,
  filesByPath,
  issueOrPullRequestByNumber,
  symbolsByName,
  type FossilDb,
} from '@codefossil/db';
import type { EntityRef } from '@codefossil/shared';
import { describeEntities } from './describe.js';

export interface TargetMatch {
  readonly ref: EntityRef;
  readonly label: string;
  /** Which rule matched, e.g. `file path`, `symbol name`, `commit sha prefix`. */
  readonly how: string;
}

const ISSUE_NUMBER = /^(?:#|GH-)(\d+)$/i;
const DEPENDENCY = /^(npm|go|cargo|pypi):(.+)$/;
const SHA_PREFIX = /^[0-9a-f]{7,64}$/i;
/** `src/tax/vat.ts:calculateVAT` — a symbol within one file. */
const FILE_SYMBOL = /^(.+\.[A-Za-z0-9]+):([^/:]+)$/;

/**
 * Find what a user means by `input`: `#12` or `GH-12` (issue or pull request),
 * `npm:zod` (dependency), a commit sha prefix, a repository-relative file path,
 * `path:Symbol`, or a symbol name. Every rule that applies contributes, so an
 * ambiguous input yields several matches — the caller asks instead of guessing.
 */
export function resolveTarget(db: FossilDb, repositoryId: number, input: string): TargetMatch[] {
  const text = input.trim();
  const found: { ref: EntityRef; how: string }[] = [];

  const issue = ISSUE_NUMBER.exec(text);
  if (issue?.[1]) {
    for (const row of issueOrPullRequestByNumber(db, repositoryId, Number(issue[1]))) {
      found.push({ ref: { type: row.type, id: row.id }, how: 'issue or pull request number' });
    }
  }

  const dependency = DEPENDENCY.exec(text);
  if (dependency?.[1] && dependency[2]) {
    for (const row of dependenciesByName(db, repositoryId, dependency[2], dependency[1])) {
      found.push({ ref: { type: 'dependency', id: row.id }, how: 'dependency' });
    }
  }

  if (SHA_PREFIX.test(text)) {
    for (const row of commitsByShaPrefix(db, repositoryId, text)) {
      found.push({ ref: { type: 'commit', id: row.id }, how: 'commit sha prefix' });
    }
  }

  for (const row of filesByPath(db, repositoryId, text.replaceAll('\\', '/'))) {
    found.push({ ref: { type: 'file', id: row.id }, how: 'file path' });
  }

  const fileSymbol = FILE_SYMBOL.exec(text);
  if (fileSymbol?.[1] && fileSymbol[2]) {
    for (const file of filesByPath(db, repositoryId, fileSymbol[1].replaceAll('\\', '/'))) {
      for (const row of symbolsByName(db, repositoryId, fileSymbol[2], file.id)) {
        found.push({ ref: { type: 'symbol', id: row.id }, how: 'symbol in file' });
      }
    }
  } else if (!ISSUE_NUMBER.test(text) && !DEPENDENCY.test(text)) {
    for (const row of symbolsByName(db, repositoryId, text)) {
      found.push({ ref: { type: 'symbol', id: row.id }, how: 'symbol name' });
    }
  }

  const unique = [...new Map(found.map((f) => [entityKey(f.ref), f])).values()];
  const descriptions = describeEntities(
    db,
    unique.map((f) => f.ref),
  );
  return unique.map((f) => ({
    ...f,
    label: descriptions.get(entityKey(f.ref))?.label ?? entityKey(f.ref),
  }));
}
