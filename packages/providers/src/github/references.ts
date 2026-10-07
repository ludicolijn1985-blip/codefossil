/** A reference to an issue or pull request found in text. */
export interface TextReference {
  readonly number: number;
  /** Lower-cased `owner/name` when the reference names another repository; null otherwise. */
  readonly repo: string | null;
  /**
   * Written with a GitHub closing keyword (`Fixes #12`), which closes the
   * issue when the change lands on the default branch.
   */
  readonly closing: boolean;
}

/** GitHub's documented closing keywords. */
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+$/i;

/**
 * `#12`, `GH-12` or `owner/name#12`, not part of a longer word, URL fragment
 * (`page#12`) or HTML entity (`&#12;`).
 */
const REFERENCE = /(^|[^\w/&#.-])(?:([\w.-]+\/[\w.-]+)#|#|GH-)(\d+)\b/gi;

/**
 * Find issue and pull request references in a commit message or PR body.
 * `owner/name#12` naming the repository itself counts as `#12`; references
 * to other repositories carry their `repo`. The same reference is reported
 * once, as closing if any of its mentions is.
 */
export function parseReferences(text: string, owner: string, name: string): TextReference[] {
  const found = new Map<string, TextReference>();
  const self = `${owner}/${name}`.toLowerCase();
  for (const match of text.matchAll(REFERENCE)) {
    const [, prefix = '', named, digits = ''] = match;
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const repo = named && named.toLowerCase() !== self ? named.toLowerCase() : null;
    const before = text.slice(0, match.index + prefix.length);
    const key = `${repo ?? ''}#${String(number)}`;
    const closing = (found.get(key)?.closing ?? false) || CLOSING.test(before);
    found.set(key, { number, repo, closing });
  }
  return [...found.values()];
}
