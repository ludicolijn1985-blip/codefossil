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
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]*:?[ \t]+$/i;
/** A closing keyword sits right before its reference: only this much text before it is tested. */
export const CLOSING_WINDOW = 24;
/** Longest text scanned for references; commit messages and PR bodies are untrusted. */
export const MAX_REFERENCE_TEXT = 100_000;

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
  for (const match of text.slice(0, MAX_REFERENCE_TEXT).matchAll(REFERENCE)) {
    const [, prefix = '', named, digits = ''] = match;
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const repo = named && named.toLowerCase() !== self ? named.toLowerCase() : null;
    const end = match.index + prefix.length;
    const before = text.slice(Math.max(0, end - CLOSING_WINDOW), end);
    const key = `${repo ?? ''}#${String(number)}`;
    const closing = (found.get(key)?.closing ?? false) || CLOSING.test(before);
    found.set(key, { number, repo, closing });
  }
  return [...found.values()];
}
