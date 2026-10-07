import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ENTITY_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_LEVELS,
  RELATION_TYPES,
  SYMBOL_KINDS,
  type Provenance,
} from '@codefossil/shared';

/** An issue GitHub links to a pull request as closed by it; `repo` is `owner/name`. */
export interface ClosingRef {
  readonly repo: string;
  readonly number: number;
}

/** `('FACT', 'DERIVED', 'INFERRED')` for use in CHECK constraints. */
const evidenceLevelList = sql.raw(`(${EVIDENCE_LEVELS.map((level) => `'${level}'`).join(', ')})`);

/** All timestamps are stored as ISO-8601 text so they sort and read naturally. */
const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const repositories = sqliteTable('repositories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  name: text('name').notNull(),
  remoteUrl: text('remote_url'),
  defaultBranch: text('default_branch'),
  indexedAt: text('indexed_at'),
  /** HEAD commit the dependency graph snapshot was last built from. */
  graphIndexedSha: text('graph_indexed_sha'),
  createdAt: createdAt(),
});

export const commits = sqliteTable(
  'commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email').notNull(),
    authoredAt: text('authored_at').notNull(),
    committedAt: text('committed_at').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull().default(''),
  },
  (t) => [uniqueIndex('commits_repository_sha_idx').on(t.repositoryId, t.sha)],
);

/**
 * Parent links for commits. Merge commits have several parents, so this is a
 * separate table rather than a single `parent_sha` column.
 */
export const commitParents = sqliteTable(
  'commit_parents',
  {
    commitId: integer('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    parentSha: text('parent_sha').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commitId, t.ordinal] }),
    index('commit_parents_parent_sha_idx').on(t.parentSha),
  ],
);

export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    language: text('language'),
    firstSeenCommitId: integer('first_seen_commit_id').references(() => commits.id),
    lastSeenCommitId: integer('last_seen_commit_id').references(() => commits.id),
    deletedAt: text('deleted_at'),
  },
  (t) => [uniqueIndex('files_repository_path_idx').on(t.repositoryId, t.path)],
);

export const fileChanges = sqliteTable(
  'file_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commitId: integer('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['added', 'modified', 'deleted', 'renamed'] }).notNull(),
    previousPath: text('previous_path'),
    /** Null when git cannot count lines (binary files) — unknown, not zero. */
    additions: integer('additions'),
    deletions: integer('deletions'),
    patchHash: text('patch_hash'),
    /** When symbols were extracted from this change; null means not yet (or unsupported language). */
    symbolsIndexedAt: text('symbols_indexed_at'),
  },
  (t) => [
    uniqueIndex('file_changes_file_commit_idx').on(t.fileId, t.commitId),
    index('file_changes_commit_idx').on(t.commitId),
  ],
);

export const symbols = sqliteTable(
  'symbols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    stableKey: text('stable_key').notNull(),
    name: text('name').notNull(),
    /** Dotted path of enclosing containers plus the name, e.g. `Cart.total`. */
    qualifiedName: text('qualified_name').notNull().default(''),
    kind: text('kind', { enum: SYMBOL_KINDS }).notNull(),
    signature: text('signature'),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    /** Hash of the latest indexed version, used to detect changes. */
    contentHash: text('content_hash'),
    /** Whether the symbol exists at HEAD (reconciled after each index run). */
    current: integer('current', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    uniqueIndex('symbols_file_stable_key_idx').on(t.fileId, t.stableKey),
    index('symbols_name_idx').on(t.name),
    index('symbols_qualified_name_idx').on(t.qualifiedName),
  ],
);

export const symbolVersions = sqliteTable(
  'symbol_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    commitId: integer('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    signature: text('signature'),
  },
  (t) => [
    uniqueIndex('symbol_versions_symbol_commit_idx').on(t.symbolId, t.commitId),
    // Finds identical content in other files: copies and moves of a symbol.
    index('symbol_versions_content_hash_idx').on(t.contentHash),
  ],
);

export const evidence = sqliteTable(
  'evidence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    type: text('type', { enum: EVIDENCE_KINDS }).notNull(),
    /** Stable pointer into the source, e.g. a commit SHA or `path#L10-L20`. */
    locator: text('locator').notNull(),
    excerpt: text('excerpt'),
    metadataJson: text('metadata_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('evidence_repository_locator_idx').on(t.repositoryId, t.type, t.locator)],
);

export const relations = sqliteTable(
  'relations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sourceType: text('source_type', { enum: ENTITY_TYPES }).notNull(),
    sourceId: integer('source_id').notNull(),
    relation: text('relation', { enum: RELATION_TYPES }).notNull(),
    targetType: text('target_type', { enum: ENTITY_TYPES }).notNull(),
    targetId: integer('target_id').notNull(),
    confidence: real('confidence').notNull(),
    evidenceType: text('evidence_type', { enum: EVIDENCE_LEVELS }).notNull(),
    provenanceJson: text('provenance_json', { mode: 'json' }).$type<Provenance>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('relations_source_idx').on(t.repositoryId, t.sourceType, t.sourceId),
    index('relations_target_idx').on(t.repositoryId, t.targetType, t.targetId),
    uniqueIndex('relations_edge_idx').on(
      t.repositoryId,
      t.sourceType,
      t.sourceId,
      t.relation,
      t.targetType,
      t.targetId,
    ),
    check('relations_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check('relations_evidence_type_valid', sql`${t.evidenceType} IN ${evidenceLevelList}`),
    check('relations_fact_is_certain', sql`${t.evidenceType} <> 'FACT' OR ${t.confidence} = 1`),
  ],
);

export const issues = sqliteTable(
  'issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /**
     * `owner/name` of the repository the issue lives in when that is not the
     * indexed repository (a cross-repository reference); empty otherwise.
     */
    sourceRepo: text('source_repo').notNull().default(''),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    state: text('state').notNull(),
    url: text('url'),
    author: text('author'),
    labelsJson: text('labels_json', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at'),
    closedAt: text('closed_at'),
  },
  (t) => [
    uniqueIndex('issues_external_repo_idx').on(
      t.repositoryId,
      t.provider,
      t.sourceRepo,
      t.externalId,
    ),
  ],
);

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    state: text('state').notNull(),
    url: text('url'),
    author: text('author'),
    labelsJson: text('labels_json', { mode: 'json' }).$type<string[]>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at'),
    closedAt: text('closed_at'),
    mergedAt: text('merged_at'),
    mergeCommitSha: text('merge_commit_sha'),
    baseBranch: text('base_branch'),
    headBranch: text('head_branch'),
    /** When commits, reviews and merge details were fetched; null or older than updated_at means pending. */
    detailsSyncedAt: text('details_synced_at'),
    /**
     * The issues GitHub links to this pull request as closed by it (its
     * `closingIssuesReferences`); null until fetched.
     */
    closingRefsJson: text('closing_refs_json', { mode: 'json' }).$type<ClosingRef[]>(),
    closingRefsSyncedAt: text('closing_refs_synced_at'),
  },
  (t) => [uniqueIndex('pull_requests_external_idx').on(t.repositoryId, t.provider, t.externalId)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pullRequestId: integer('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    author: text('author').notNull(),
    state: text('state'),
    body: text('body').notNull().default(''),
    submittedAt: text('submitted_at').notNull(),
  },
  (t) => [uniqueIndex('reviews_external_idx').on(t.pullRequestId, t.externalId)],
);

/**
 * Lookups of issues in other repositories (`owner/name#12`), so a reference
 * that cannot be read (private, deleted, not an issue) is not asked again on
 * every sync.
 */
export const foreignLookups = sqliteTable(
  'foreign_lookups',
  {
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** Lower-cased `owner/name#number`. */
    reference: text('reference').notNull(),
    found: integer('found', { mode: 'boolean' }).notNull(),
    checkedAt: text('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.reference] })],
);

/** Commits GitHub reports as part of a pull request (whether or not they are indexed locally). */
export const pullRequestCommits = sqliteTable(
  'pull_request_commits',
  {
    pullRequestId: integer('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pullRequestId, t.sha] }),
    index('pull_request_commits_sha_idx').on(t.sha),
  ],
);

/**
 * A repository's link to a hosting provider: where to sync from and how far
 * the sync got. Holds no credentials.
 */
export const providerConnections = sqliteTable(
  'provider_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** `github`; or an issue tracker linked by keys (`PROJ-123`): `jira`, `linear`. */
    provider: text('provider', { enum: ['github', 'jira', 'linear'] }).notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    apiUrl: text('api_url').notNull(),
    /** `updated_at` of the newest issue/PR synced; the next sync resumes from it. */
    cursor: text('cursor'),
    lastSyncedAt: text('last_synced_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('provider_connections_repo_idx').on(t.repositoryId, t.provider)],
);

export const tests = sqliteTable('tests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  symbolId: integer('symbol_id').references(() => symbols.id, { onDelete: 'set null' }),
  fileId: integer('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  framework: text('framework').notNull(),
  name: text('name').notNull(),
});

export const dependencies = sqliteTable(
  'dependencies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    ecosystem: text('ecosystem').notNull(),
    name: text('name').notNull(),
    version: text('version'),
    manifestFile: text('manifest_file').notNull(),
    scope: text('scope', { enum: ['runtime', 'dev', 'peer', 'optional', 'build'] })
      .notNull()
      .default('runtime'),
    /** Whether the manifest at HEAD still declares it. */
    current: integer('current', { mode: 'boolean' }).notNull().default(true),
    /** A package defined in this repository (a workspace); imports resolve to its source files. */
    internal: integer('internal', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('dependencies_manifest_name_idx').on(
      t.repositoryId,
      t.manifestFile,
      t.ecosystem,
      t.name,
    ),
  ],
);

/**
 * Module references found in each file at HEAD (a snapshot, replaced when the
 * file changes), with the outcome of resolving them.
 */
export const imports = sqliteTable(
  'imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    specifier: text('specifier').notNull(),
    kind: text('kind', {
      enum: ['import', 'reexport', 'require', 'dynamic', 'from', 'mod', 'use'],
    }).notNull(),
    line: integer('line').notNull(),
    namesJson: text('names_json', { mode: 'json' }).$type<string[]>(),
    /** Local names the import binds: `{ local, imported }`, `imported` `*` for the whole module. */
    bindingsJson: text('bindings_json', { mode: 'json' }).$type<
      { local: string; imported: string }[]
    >(),
    evidenceId: integer('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    resolution: text('resolution', { enum: ['files', 'dependency', 'builtin', 'unresolved'] }),
    /** Target description or, when unresolved, the reason. */
    resolutionDetail: text('resolution_detail'),
  },
  (t) => [index('imports_file_idx').on(t.fileId)],
);

/**
 * Symbols parsed from one blob (file content), so content seen before — on
 * another branch, after a reset, in a revert — is not parsed again. Keyed by
 * content and grammar; `version` changes whenever extraction does. Holds no
 * claims, only a parse result, so pruning history leaves it alone.
 */
export const parsedBlobs = sqliteTable(
  'parsed_blobs',
  {
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    oid: text('oid').notNull(),
    grammar: text('grammar').notNull(),
    version: text('version').notNull(),
    resultJson: text('result_json', { mode: 'json' }).$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.oid, t.grammar] })],
);

/**
 * Line coverage of a file, from the last coverage report read (lcov). Only
 * files present in the report have a row; the report itself is the cited
 * evidence row.
 */
export const lineCoverage = sqliteTable('line_coverage', {
  fileId: integer('file_id')
    .primaryKey()
    .references(() => files.id, { onDelete: 'cascade' }),
  /** Lines the report instruments, ascending. */
  foundJson: text('found_json', { mode: 'json' }).$type<number[]>().notNull(),
  /** Instrumented lines run at least once, ascending. */
  hitJson: text('hit_json', { mode: 'json' }).$type<number[]>().notNull(),
  evidenceId: integer('evidence_id')
    .notNull()
    .references(() => evidence.id, { onDelete: 'cascade' }),
});

/**
 * Calls found in each file at HEAD (a snapshot, replaced when the file
 * changes): who calls what, as written, before resolution.
 */
export const calls = sqliteTable(
  'calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** `stableKey` of the calling symbol; null for module-level code. */
    callerKey: text('caller_key'),
    /** The callee's name path joined with dots: `utils.flatten`, `*.listen`. */
    callee: text('callee').notNull(),
    line: integer('line').notNull(),
    /** The callee's first name is declared inside the caller (parameter, variable, inner function). */
    localHead: integer('local_head', { mode: 'boolean' }).notNull().default(false),
    /** The callee's first name is the caller's own object (`this`, `self`, a Go receiver). */
    selfReceiver: integer('self_receiver', { mode: 'boolean' }).notNull().default(false),
    /**
     * Null for a plain call; `type` when a stated type stood in for the callee's
     * first name (`r.vat()` read as `Rates.vat`); `reference` for a function
     * passed by name rather than called.
     */
    via: text('via', { enum: ['type', 'reference'] }),
    /** The callee as written, when a stated type replaced part of it. */
    written: text('written'),
    /** The commit the file was read at, for evidence locators. */
    sha: text('sha').notNull(),
  },
  (t) => [index('calls_file_idx').on(t.fileId)],
);

export const incidents = sqliteTable(
  'incidents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    severity: text('severity'),
    occurredAt: text('occurred_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [uniqueIndex('incidents_external_idx').on(t.repositoryId, t.provider, t.externalId)],
);

export const investigations = sqliteTable(
  'investigations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    /** Which investigation answered the query. */
    kind: text('kind', { enum: ['why', 'impact'] }),
    /** The entity investigated, as `type:id`. */
    targetKey: text('target_key'),
    answer: text('answer').notNull(),
    confidence: real('confidence').notNull(),
    classification: text('classification', { enum: EVIDENCE_LEVELS }).notNull(),
    evidenceIdsJson: text('evidence_ids_json', { mode: 'json' }).$type<number[]>().notNull(),
    /** The full structured result, so a past investigation can be shown again as it was. */
    resultJson: text('result_json', { mode: 'json' }),
    /** HEAD when the investigation ran; later history may change the answer. */
    headSha: text('head_sha'),
    createdAt: createdAt(),
  },
  (t) => [
    index('investigations_repository_idx').on(t.repositoryId, t.createdAt),
    check('investigations_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check('investigations_classification_valid', sql`${t.classification} IN ${evidenceLevelList}`),
  ],
);
