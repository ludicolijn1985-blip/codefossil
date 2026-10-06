# Changelog

All notable changes to CODEFOSSIL. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **MCP server.** `codefossil mcp` gives AI coding agents (Claude Code, Cursor, VS Code) eight
  read-only, offline tools: `why`, `impact`, `timeline`, `symbols`, `hotspots`, `dead_intent`,
  `fossils` and `change_report`, with the same evidence and labels as the CLI.
- **Changed code that broke before.** `codefossil report --base` and the pull-request comment
  now lead with the functions a change modifies whose history holds earlier fixes, with those
  fixes, their issues and how many files depend on them. Repository-wide sections fold away on
  pull requests.
- **Fossils.** `codefossil fossils` lists the oldest functions, methods and classes still present,
  with the commit that introduced each and what changed since, or (`--order untouched`) the code
  that has gone longest without a change.
- **Functions fixed most often.** `codefossil hotspots --symbols` ranks functions, methods and
  classes by the fix commits that changed them; on Express, `res.send` leads with 17.
- **Copied and moved code.** A new function, method or class whose content is identical to one in
  another file is recorded as copied from it (`COPIED_FROM`, DERIVED, confidence 0.9) instead of
  introduced; `why` and `fossils` follow it back to the original. A name defined once at HEAD now
  resolves to that definition even when removed copies share the name.

- **Import resolution.** Go `replace` directives that point at a directory of the repository
  resolve to its packages. Python imports from the standard library are recognised as built-in
  (including modules removed in 3.12 and 3.13), and well-known import names that differ from their
  distribution (`yaml`, `PIL`, `sklearn`, `bs4`, …) resolve to the declared distribution.

### Fixed

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
