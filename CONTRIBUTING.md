# Contributing

Thanks for helping! Bug reports with a public repository that reproduces them are gold: they
show exactly what CODEFOSSIL got wrong about real history.

## Good first contributions

- **A new language.** Add a Tree-sitter grammar and a `LanguageSpec` in
  `packages/parser/src/languages/`. Java, Ruby, C#, PHP and Kotlin are wanted.
- **An import resolver.** Resolve that language's imports in `packages/graph/src/resolve/`.
- **A provider.** GitLab, Bitbucket, Jira or Linear, normalized into the evidence model like
  `packages/providers/src/github/`.
- **False positives.** Report a hotspot defect heuristic or dead-intent candidate that is wrong on
  a public repository, and send a test that pins the fix.

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
pnpm codefossil why <target>        # run the CLI from this checkout (after pnpm build)
node scripts/build-npm.mjs          # build the publishable package into packaging/npm
```

Workspace packages point their `@codefossil/source` export condition at `src/`, so tests and
typechecking run against source without a build step. `pnpm test`, `pnpm lint` and
`pnpm typecheck` must pass before a pull request is merged.

## Rules of the codebase

- **Evidence.** Never invent evidence. Every relationship stores its provenance and cites
  evidence that exists.
- **Levels.** Keep FACT, DERIVED and INFERRED apart. A heuristic is INFERRED, whatever its
  confidence.
- **Determinism.** Prefer deterministic algorithms. AI is optional and held to evidence.
- **Untrusted input.** Repository content is untrusted input: parse it, never execute it; run git
  with argument arrays.
- **Tests.** Every core algorithm has unit tests.

Every new analyzer documents its input facts, deterministic algorithm, output classification,
confidence calculation, known false positives and test fixtures (see ARCHITECTURE.md).

## Packages

| Package                 | Purpose                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `@codefossil/shared`    | Evidence model: entity/relation types, FACT/DERIVED/INFERRED rules, provenance (Zod)             |
| `@codefossil/db`        | SQLite + Drizzle schema, migrations, repository and relation access                              |
| `@codefossil/git`       | Native git access (argument arrays, never a shell) and a streaming history reader                |
| `@codefossil/parser`    | Tree-sitter (WebAssembly) symbol extraction for TS/TSX/JS, Python, Go and Rust                   |
| `@codefossil/graph`     | Manifest parsing and deterministic import resolution (files, workspaces, packages)               |
| `@codefossil/providers` | GitHub REST client (rate limits, request budget, host-pinned token) and reference parsing        |
| `@codefossil/core`      | Git, symbol and dependency indexers, each relation citing evidence                               |
| `@codefossil/query`     | Evidence graph: bounded traversal, chain scoring, target resolution, graph export                |
| `@codefossil/analyzers` | Historical hotspots, risk components, dead-intent candidates and CI reports                      |
| `@codefossil/ai`        | Optional AI layer: evidence-grounded answers and summaries (Ollama or Anthropic), off by default |
| `@codefossil/api`       | Local JSON API (Fastify, Zod-validated, loopback-only)                                           |
| `@codefossil/cli`       | The `codefossil` command                                                                         |
| `@codefossil/web`       | Local web UI (Next.js) over the API                                                              |

## Pull requests

1. Fork and create a branch.
2. Add tests that fail without your change.
3. Run `pnpm lint`, `pnpm typecheck` and `pnpm test`.
4. Describe what changed and why; link the issue.

By contributing you agree that your contributions are licensed under the MIT License.
