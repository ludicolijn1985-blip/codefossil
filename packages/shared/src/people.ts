/** Emails that say nothing about who wrote a commit. */
const ANONYMOUS_EMAIL = /^(|.*noreply.*|.*@localhost.*|unknown|none)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What identifies a commit's author. */
export interface AuthoredCommit {
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committedAt: string;
}

/** Days before a repository's latest commit within which an author counts as active. */
export const ACTIVE_DAYS = 365;

/**
 * The people of a repository's history. One person per identity: names
 * compared without case and spacing, joined with every other name used with
 * the same email address (`Tj Holowaychuk`, `TJ Holowaychuk` and
 * `visionmedia` committing as tj@…), shown under the name of their latest
 * commit. Activity is measured back from the repository's latest commit, not
 * from today, so an old clone is read as of its own time.
 */
export class People {
  private readonly parent = new Map<string, string>();
  private readonly display = new Map<string, { name: string; at: string }>();
  private readonly lastSeen = new Map<string, string>();
  /** The repository's latest commit; null for an empty history. */
  readonly asOf: string | null;

  constructor(
    commits: readonly AuthoredCommit[],
    private readonly activeDays = ACTIVE_DAYS,
  ) {
    for (const commit of commits) {
      const name = nameKey(commit.authorName);
      this.find(name);
      const email = commit.authorEmail.trim().toLowerCase();
      if (!ANONYMOUS_EMAIL.test(email)) this.union(name, `email:${email}`);
    }
    let asOf: string | null = null;
    for (const commit of commits) {
      const root = this.find(nameKey(commit.authorName));
      const known = this.display.get(root);
      if (!known || commit.committedAt > known.at) {
        this.display.set(root, { name: commit.authorName, at: commit.committedAt });
      }
      if (asOf === null || commit.committedAt > asOf) asOf = commit.committedAt;
    }
    for (const { name, at } of this.display.values()) this.lastSeen.set(name, at);
    this.asOf = asOf;
  }

  private find(key: string): string {
    let root = key;
    for (let next = this.parent.get(root); next !== undefined && next !== root;) {
      root = next;
      next = this.parent.get(root);
    }
    this.parent.set(key, root);
    return root;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** The person who wrote a commit, by the name they are shown under. */
  personOf(commit: { readonly authorName: string }): string {
    return this.display.get(this.find(nameKey(commit.authorName)))?.name ?? commit.authorName;
  }

  /** A person's latest commit anywhere in the repository. */
  lastCommitOf(person: string): string | null {
    return this.lastSeen.get(person) ?? null;
  }

  /** Whether a person committed within the activity window before the latest commit. */
  isActive(person: string): boolean {
    const last = this.lastCommitOf(person);
    if (last === null || this.asOf === null) return false;
    return Date.parse(last) >= Date.parse(this.asOf) - this.activeDays * DAY_MS;
  }
}

const nameKey = (name: string) => `name:${name.toLowerCase().replace(/\s+/g, ' ').trim()}`;
