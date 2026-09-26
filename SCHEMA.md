# Database schema

The source of truth is `packages/db/src/schema.ts`; SQL migrations are generated into
`packages/db/drizzle/` with `pnpm --filter @codefossil/db db:generate`.

All timestamps are ISO-8601 text.

Core tables:

repositories

- id
- path
- name
- remote_url
- default_branch
- indexed_at
- graph_indexed_sha (HEAD the dependency graph snapshot was built from)

commits

- id
- repository_id
- sha
- author_name
- author_email
- authored_at
- committed_at
- subject
- body

commit_parents

- commit_id
- parent_sha
- ordinal (0 = first parent; merges have several rows)

files

- id
- repository_id
- path
- language
- first_seen_commit_id (earliest _indexed_ commit touching the path, by commit date; with
  `--since` this can be later than the true first appearance)
- last_seen_commit_id (latest indexed commit touching the path, by commit date)
- deleted_at (null when the path exists at HEAD — reconciled with `git ls-tree HEAD` after each
  index run; otherwise the date of the latest recorded deletion, or the HEAD commit date as an
  upper bound when the deletion happened in a merge commit)

file_changes

- id
- commit_id
- file_id
- status (added | modified | deleted | renamed)
- previous_path
- additions (null for binary files — unknown, not zero)
- deletions (null for binary files)
- patch_hash
- symbols_indexed_at (null until symbols were extracted; stays null for unsupported languages)

symbols

- id
- file_id
- stable_key (`kind:Qualified.name`, `#n` suffix for duplicates such as overloads)
- name
- qualified_name
- kind
- signature
- start_line
- end_line
- content_hash (SHA-256 of the latest indexed version)
- current (exists at HEAD; reconciled after each index run)

symbol_versions

- id
- symbol_id
- commit_id
- content_hash
- signature

relations

- id
- repository_id
- source_type
- source_id
- relation
- target_type
- target_id
- confidence (CHECK 0..1)
- evidence_type (CHECK FACT | DERIVED | INFERRED; FACT requires confidence = 1)
- provenance_json (producer, method, evidenceIds, observedAt, details)
- created_at

issues

- id
- repository_id
- provider
- external_id
- title
- body
- state
- url
- created_at
- closed_at

pull_requests

- id
- repository_id
- provider
- external_id
- title
- body
- state
- url
- created_at
- merged_at

reviews

- id
- pull_request_id
- author
- body
- submitted_at

tests

- id
- symbol_id
- file_id
- framework
- name

dependencies

- id
- repository_id
- ecosystem
- name
- version
- manifest_file
- scope (runtime | dev | peer | optional | build)
- current (declared by the manifest at HEAD)
- internal (a package defined in this repository, e.g. a workspace)

imports (snapshot at HEAD; replaced when the file changes)

- id
- file_id
- specifier (as written: `./vat.js`, `..models`, `crate::tax`)
- kind (import | reexport | require | dynamic | from | mod | use)
- line
- names_json (Python `from x import a, b`)
- evidence_id
- resolution (files | dependency | builtin | unresolved)
- resolution_detail (target, or the reason it is unresolved)

incidents

- id
- repository_id
- provider
- external_id
- title
- severity
- occurred_at
- resolved_at

investigations

- id
- repository_id
- query
- answer
- confidence
- classification (FACT | DERIVED | INFERRED)
- evidence_ids_json
- created_at

evidence

- id
- repository_id
- type
- locator
- excerpt
- metadata_json
- created_at

Indexes (unique where marked):

- commits(repository_id, sha) unique
- files(repository_id, path) unique
- file_changes(file_id, commit_id) unique
- symbols(file_id, stable_key) unique
- relations(repository_id, source_type, source_id)
- relations(repository_id, target_type, target_id)
- relations(repository_id, source, relation, target) unique — re-indexing updates edges in place
- issues(repository_id, provider, external_id) unique
- pull_requests(repository_id, provider, external_id) unique
