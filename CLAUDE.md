# CODEFOSSIL — Claude Code Build Instructions

You are building a production-quality open-source developer tool.

## Mission

Build CODEFOSSIL as an evidence-first software archaeology platform.

The product must answer:

- Why does this code exist?
- What changed and when?
- Which issue/PR/commit introduced it?
- What depends on it?
- What historically broke around it?
- Which workarounds may be obsolete?
- Which architectural decisions are undocumented?

## Required stack

- Monorepo: pnpm + Turborepo
- Language: TypeScript strict mode
- Runtime: Node.js 22+
- CLI: Commander
- API: Fastify
- UI: Next.js + React
- Styling: Tailwind CSS
- Graph UI: React Flow
- Database: SQLite + Drizzle ORM
- Validation: Zod
- Parsing: Tree-sitter
- Git: isomorphic-git where practical; native git fallback for advanced history
- Testing: Vitest + Playwright
- Lint/format: ESLint + Prettier
- Package manager: pnpm

## Architecture

apps/cli
apps/web
apps/api
packages/core
packages/git
packages/parser
packages/graph
packages/providers
packages/analyzers
packages/query
packages/db
packages/shared
packages/ui

## Engineering rules

1. Never silently invent evidence.
2. Store provenance for every relationship.
3. Separate FACT, DERIVED and INFERRED records.
4. Every AI-generated conclusion must contain confidence and evidence IDs.
5. Never send source code to an external AI provider unless the user explicitly configures it.
6. Prefer deterministic algorithms before AI.
7. Every public API endpoint requires Zod validation.
8. Every core algorithm requires unit tests.
9. CLI commands must work headlessly.
10. `pnpm test`, `pnpm lint`, `pnpm typecheck` must pass before considering a feature complete.

## Build order

Phase 1: workspace + DB + shared types
Phase 2: Git indexing
Phase 3: AST/symbol indexing
Phase 4: dependency graph
Phase 5: GitHub provider
Phase 6: evidence/causal graph
Phase 7: CLI investigations
Phase 8: web UI
Phase 9: risk/hotspot analyzers
Phase 10: optional AI layer
Phase 11: GitHub Action
Phase 12: documentation and release automation

## Product language

Use:

- evidence
- provenance
- relationship
- inference
- confidence
- investigation
- timeline
- lineage
- impact
- historical hotspot

Avoid:

- magic
- guaranteed intent
- "AI knows why"
