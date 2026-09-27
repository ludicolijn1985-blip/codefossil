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
pnpm build       # compile packages to dist/, build the web UI
pnpm format      # Prettier
pnpm --filter @codefossil/web e2e   # Playwright against a fixture repository (after pnpm build)
```

Workspace packages point their `@codefossil/source` export condition at `src/`, so tests and
typechecking run against source without a build step.

### Packages

| Package                 | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `@codefossil/shared`    | Evidence model: entity/relation types, FACT/DERIVED/INFERRED rules, provenance (Zod)      |
| `@codefossil/db`        | SQLite + Drizzle schema, migrations, repository and relation access                       |
| `@codefossil/git`       | Native git access (argument arrays, never a shell) and a streaming history reader         |
| `@codefossil/parser`    | Tree-sitter (WebAssembly) symbol extraction for TS/TSX/JS, Python, Go and Rust            |
| `@codefossil/graph`     | Manifest parsing and deterministic import resolution (files, workspaces, packages)        |
| `@codefossil/providers` | GitHub REST client (rate limits, request budget, host-pinned token) and reference parsing |
| `@codefossil/core`      | Git, symbol and dependency indexers, each relation citing evidence                        |
| `@codefossil/query`     | Evidence graph: bounded traversal, chain scoring, target resolution, graph export         |
| `@codefossil/api`       | Local JSON API (Fastify, Zod-validated, loopback-only)                                    |
| `@codefossil/cli`       | The `fossil` command                                                                      |
| `@codefossil/web`       | Local web UI (Next.js) over the API: overview, investigations, files, graph, dependencies |

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
node /path/to/codefossil/apps/cli/dist/bin.js connect github       # link issues and PRs (token from env or gh)
node /path/to/codefossil/apps/cli/dist/bin.js trace calculateVAT     # evidence chains (--route origin|history|impact)
node /path/to/codefossil/apps/cli/dist/bin.js export graph.json     # the evidence graph as JSON
node /path/to/codefossil/apps/cli/dist/bin.js why calculateVAT       # where it comes from, with evidence
node /path/to/codefossil/apps/cli/dist/bin.js impact src/tax/vat.ts # what depends on it
node /path/to/codefossil/apps/cli/dist/bin.js timeline src/tax/vat.ts
node /path/to/codefossil/apps/cli/dist/bin.js query "what depends on calculateVAT?"
```

Inside this repository, `pnpm fossil <command>` does the same.

### Using the web UI

The UI reads everything from `fossil serve`; start both from an indexed repository:

```bash
node /path/to/codefossil/apps/cli/dist/bin.js serve          # API on 127.0.0.1:4000
pnpm --filter @codefossil/web start                          # UI on http://127.0.0.1:3000
```

Set `FOSSIL_API_URL` when the API listens elsewhere on this machine. The browser never talks to
the API directly: requests go through the UI server, which forwards only read routes and
investigations, and only for requests addressed to a loopback host. `/` focuses search;
`g` then `o`/`i`/`f`/`g`/`d` jumps between sections.

### Known limitations

- `impact` is file-level: call-level edges are not indexed, so a file that imports the defining
  file counts as a dependent even if it never calls the symbol.

- GitHub links from closing keywords (`Fixes #12`) are DERIVED with confidence 0.9: GitHub closes
  the issue only when the change reaches the default branch, which is not verified.
- Only same-repository references are linked; `other/repo#12` is ignored.
- A closing keyword in a commit that was later reverted (`This reverts commit …`) only counts as
  a reference. GitHub lists at most 250 commits per pull request; longer PRs link only those.

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
  manifests: Python imports whose name differs from the distribution (`yaml` from PyYAML) or that
  are standard library, and Go `replace` directives.
- TypeScript `paths` and `baseUrl` come from the nearest `tsconfig.json` (or `jsconfig.json`)
  above the importing file, with `extends` followed only through files in the repository. A base
  config from a package (`@tsconfig/node22`) is skipped, as are `include`/`exclude`, project
  references and non-default config names such as `tsconfig.build.json` used via `tsc -p`.
