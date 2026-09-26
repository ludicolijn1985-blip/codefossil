/** A reference to an issue or pull request of the same repository found in text. */
export interface TextReference {
  readonly number: number;
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
const REFERENCE = /(^|[^\w/&#-])(?:([\w.-]+\/[\w.-]+)#|#|GH-)(\d+)\b/gi;

/**
 * Find issue and pull request references in a commit message or PR body.
 * References to other repositories are ignored; the same number is reported
 * once, as closing if any of its mentions is.
 */
export function parseReferences(text: string, owner: string, name: string): TextReference[] {
  const found = new Map<number, boolean>();
  const self = `${owner}/${name}`.toLowerCase();
  for (const match of text.matchAll(REFERENCE)) {
    const [, prefix = '', repo, digits = ''] = match;
    if (repo && repo.toLowerCase() !== self) continue;
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const before = text.slice(0, match.index + prefix.length);
    found.set(number, (found.get(number) ?? false) || CLOSING.test(before));
  }
  return [...found].map(([number, closing]) => ({ number, closing }));
}
