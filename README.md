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
