# CODEFOSSIL

> Your code tells you WHAT. Git history tells you WHEN. CODEFOSSIL tells you WHY.

CODEFOSSIL is a local-first software archaeology and repository intelligence platform. It reconstructs the relationships between requirements, issues, pull requests, commits, files, symbols, tests, dependencies and incidents.

## Core principles

- Evidence first: every inferred relationship has provenance.
- Local first: a repository can be analyzed without uploading source code.
- AI is optional: deterministic indexing and graph construction work without an LLM.
- Explainable: never present an AI inference as a fact.
- Git-native: history is a first-class data source.
- Extensible: providers and analyzers are plugins.

## MVP

1. Clone/open a Git repository.
2. Index commits, branches, tags and file history.
3. Parse TypeScript/JavaScript/Python/Go/Rust.
4. Build symbol and dependency graph.
5. Connect GitHub issues and pull requests.
6. Build a causal evidence graph.
7. Local web UI with repository overview, timeline, graph and investigation view.
8. CLI queries:
   - `fossil init`
   - `fossil index`
   - `fossil status`
   - `fossil investigate`
   - `fossil why <symbol>`
   - `fossil impact <symbol-or-file>`
   - `fossil timeline <path>`
9. JSON API.
10. GitHub Action for scheduled re-indexing.

## Non-goals for v1

- Cloud-hosted source-code storage.
- Autonomous code modifications.
- Claiming certainty about developer intent.
- Supporting every programming language.

## Development

Requires Node.js 22.12+ and pnpm 10 (`corepack enable` picks up the pinned version).

```bash
pnpm install
pnpm test        # Vitest across all packages
pnpm lint        # ESLint (type-aware)
pnpm typecheck   # tsc --noEmit
pnpm build       # compile packages to dist/
pnpm format      # Prettier
```

Workspace packages point their `@codefossil/source` export condition at `src/`, so tests and
typechecking run against source without a build step.

### Packages

| Package              | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `@codefossil/shared` | Evidence model: entity/relation types, FACT/DERIVED/INFERRED rules, provenance (Zod) |
| `@codefossil/db`     | SQLite + Drizzle schema, migrations, repository and relation access                  |
| `@codefossil/git`    | Native git access (argument arrays, never a shell) and a streaming history reader    |
| `@codefossil/parser` | Tree-sitter (WebAssembly) symbol extraction for TS/TSX/JS, Python, Go and Rust       |
| `@codefossil/graph`  | Manifest parsing and deterministic import resolution (files, workspaces, packages)   |
| `@codefossil/core`   | Git, symbol and dependency indexers, each relation citing evidence                   |
| `@codefossil/cli`    | The `fossil` command                                                                 |

### Using the CLI

```bash
pnpm build
cd /path/to/any/git/repo
node /path/to/codefossil/apps/cli/dist/bin.js init     # creates .codefossil/ (ignores itself)
node /path/to/codefossil/apps/cli/dist/bin.js index    # incremental; --since 2025-01-01 to limit
node /path/to/codefossil/apps/cli/dist/bin.js status   # --json for scripts
node /path/to/codefossil/apps/cli/dist/bin.js symbols src/app.ts   # symbol tree with origins
node /path/to/codefossil/apps/cli/dist/bin.js deps src/app.ts      # imports and importers
node /path/to/codefossil/apps/cli/dist/bin.js deps                 # declared dependencies
```

Inside this repository, `pnpm fossil <command>` does the same.

### Known limitations

- Only history reachable from HEAD is indexed; other branches and tags are not yet.
- Rewritten history (rebase, force-push) is not detected: commits that are no longer reachable
  stay in the index.
- Symbols are identified by kind and qualified name within a file. Renaming a function looks like
  one symbol removed and another introduced; moving it to another file likewise.
- Merge commits are stored without file changes; a file deleted _by_ a merge gets the merge date
  as an upper bound for `deleted_at`.
- The dependency graph is a snapshot of HEAD. When imports that no longer hold are removed,
  their edges go too; dependency history is not tracked yet.
- Import resolution leaves unresolved (and says why) what it cannot decide from files and
  manifests: TypeScript `paths` aliases, Python imports whose name differs from the distribution
  (`yaml` from PyYAML) or that are standard library, and Go `replace` directives.
