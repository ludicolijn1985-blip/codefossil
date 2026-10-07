# Changelog

All notable changes to CODEFOSSIL. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **MCP server.** `codefossil mcp` gives AI coding agents (Claude Code, Cursor, VS Code) seven
  read-only, offline tools: `why`, `impact`, `timeline`, `symbols`, `hotspots`, `dead_intent`
  and `change_report`, with the same evidence and labels as the CLI.
- **Changed code that broke before.** `codefossil report --base` and the pull-request comment
  now lead with the functions a change modifies whose history holds earlier fixes, with those
  fixes, their issues and how many files depend on them. Repository-wide sections fold away on
  pull requests.

### Fixed

- **Commits outside HEAD's history.** The index only ever added commits, so after a reset, a
  rebase, a deleted branch, an older checkout or a CI run that restored another branch's cached
  index, answers could cite commits HEAD does not contain. Every index run (and every question
  that updates the index) now removes them, with their symbols, relations and evidence, and
  rebuilds the symbol history of the files they touched and the dependency graph; GitHub data and
  saved investigations are kept. A shallow clone keeps indexed commits it does not have. When the index is not updated (`CODEFOSSIL_AUTO_INDEX=0`, or the API serving an older
  index), `status`, `doctor`, the Markdown report, `GET /api/repositories/:id/status` (new `head`
  field) and the web UI warn that HEAD left the indexed history. Existing indexes are re-indexed
  once on the next question.

- **Symbol history on branchy repositories.** A symbol version is now diffed against the same file
  in the commit's first parent, including versions only a merge produced. Before, it was diffed
  against the version indexed last, which on repositories with parallel release lines alternated
  between branches: Express's `res.sendFile` showed 17 changes where git shows 8. Existing indexes
  rebuild their symbol history once on the next `codefossil index` (or first question).

- **Missing SQLite binary.** When npm skipped install scripts (a repository `.npmrc` with
  `ignore-scripts=true`, as in Express), the CLI and `doctor` now explain the cause and the fix
  instead of printing the driver's list of tried paths.

## [0.1.0] - 2026-10-06

First public release.

### Added

- **One-command start.** `npx codefossil why <target>` indexes the repository on first use and
  only adds new commits afterwards; `codefossil doctor` checks the toolchain and the index.
- **Questions with evidence.** `why`, `impact`, `timeline`, `query`, `trace` and an interactive
  `investigate` build answers from statements labelled FACT, DERIVED or INFERRED, each with
  confidence and evidence, following files across renames.
- **Indexing.** Git history (streaming, incremental), symbols for TypeScript, JavaScript
  (including CommonJS and prototype-style assignments), Python, Go and Rust (Tree-sitter), and a
  dependency graph from imports and manifests (npm, Go, Cargo, Python), including TypeScript
  `paths`/`baseUrl` aliases.
- **GitHub provider.** Issues, pull requests and reviews become evidence; tokens are never stored
  and are scoped per host.
- **Risk analysis.** `hotspots` (change × churn × defect commits, with risk components) and
  `dead-intent` (workarounds whose reason may be gone, always INFERRED).
- **CI.** `codefossil report` for CI and pull requests, and a GitHub Action with a cached,
  incremental index.
- **Local UI and API.** A loopback-only JSON API (`codefossil serve`) and a local web UI.
- **Optional AI layer** (Ollama or Anthropic), off by default, held to the evidence it is shown.

[0.1.0]: https://github.com/ludicolijn1985-blip/codefossil/releases/tag/v0.1.0
