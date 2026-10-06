# Changelog

All notable changes to CODEFOSSIL. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **TypeScript path aliases.** Imports through `paths` and `baseUrl` in the nearest
  `tsconfig.json`/`jsconfig.json` now resolve to repository files, following `extends` within
  the repository. The provenance names the config and pattern that matched.

## [0.1.0] - 2026-09-27

First public release.

### Added

- **One-command start.** `npx codefossil why <target>` indexes the repository on first use and
  only adds new commits afterwards; `codefossil doctor` checks the toolchain and the index.
- **Questions with evidence.** `why`, `impact`, `timeline`, `query`, `trace` and an interactive
  `investigate` build answers from statements labelled FACT, DERIVED or INFERRED, each with
  confidence and evidence, following files across renames.
- **Indexing.** Git history (streaming, incremental), symbols for TypeScript, JavaScript
  (including CommonJS and prototype-style assignments), Python, Go and Rust (Tree-sitter), and a
  dependency graph from imports and manifests (npm, Go, Cargo, Python).
- **GitHub provider.** Issues, pull requests and reviews become evidence; tokens are never stored
  and are scoped per host.
- **Risk analysis.** `hotspots` (change × churn × defect commits, with risk components) and
  `dead-intent` (workarounds whose reason may be gone, always INFERRED).
- **CI.** `codefossil report` for CI and pull requests, and a GitHub Action with a cached,
  incremental index.
- **Local UI and API.** A loopback-only JSON API (`codefossil serve`) and a local web UI.
- **Optional AI layer** (Ollama or Anthropic), off by default, held to the evidence it is shown.

[0.1.0]: https://github.com/ludicolijn1985-blip/codefossil/releases/tag/v0.1.0
