# Changelog

All notable changes to CODEFOSSIL. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Who wrote this function.** `why` states how many people made a symbol's commits, who made
  most, and whether they still commit; the lens (`codefossil lens`, MCP, VS Code) adds
  "mostly Ada (left 2020)" when one person made at least half of them, and the history page names
  the main authors. People are matched across name spellings and email addresses, as in `owners`.
- **Callers in the PR comment.** The functions a change touches are listed with how many functions
  call them (calls resolved at HEAD), so a small edit to widely used code stands out.

## [0.3.0] - 2026-10-07

### Added

- **Who knows this code.** `codefossil owners [path]` (also an MCP tool, an API endpoint and a web
  UI page): each file's authors by share of the lines changed and whether they still commit, files
  whose main author left, and the bus factor. People are matched across name spellings and shared
  email addresses. INFERRED.
- **GitLab.** `codefossil connect gitlab` syncs issues and merge requests; the issues GitLab records
  as closed by a merged request are FACT.
- **Jira and Linear.** `codefossil connect jira <url>` / `connect linear`: issues named by key in
  commits and pull requests (`PROJ-123`) are read and linked; a commit naming a bug ticket counts as
  a fix (INFERRED).
- **Exact TypeScript callers.** `codefossil index --typescript` resolves calls with the TypeScript
  type checker (DERIVED 1.0), opt-in; `--typescript-from-repo` also allows the repository's own
  compiler.
- **The functions a change touches.** The PR report (and the Action's comment) lists them as new,
  changed, renamed or moved, with the lines that ran in the tests.
- **Stated types in Java, C# and Go**, like TypeScript, JavaScript and Python.
- **`codefossil gc`** trims the parse cache and compacts the index.
- **GitHub's own closing links.** With a token, the issues GitHub records as closed by a merged
  pull request (also ones linked by hand) are FACT, replacing that PR's keyword reading. Issues of
  other public repositories (`other/repo#12`) are read and linked; failures are reported, never
  fatal.
- **Renamed and moved symbols.** A symbol renamed in place (identical but for its name, DERIVED)
  or moved to another file with edits (INFERRED 0.6) is followed back to its earlier self; `why`,
  `fossils`, `lens`, the story page and the VS Code lens say "renamed", "moved" or "copied".
- **More callers.** Calls through names whose type the code states (`new Repo()`, `repo: Repo`,
  `this.repo = new Repo()`, Python `r = Repo()`) resolve to the type's method, and functions
  passed by name (`app.get('/', handler)`) count as INFERRED callers. `impact` leaves out files that import only other names from the defining file.
- **Line coverage.** An lcov report (`coverage/lcov.info`) is read when present: hotspots use the
  uncovered share of lines, and `why` states how many of a symbol's lines ran in the tests.
- **Installed environment.** Python import names map to declared distributions through a
  `.venv`'s `*.dist-info`; a tsconfig `extends` through a workspace package in `node_modules` is
  followed.

### Changed

- **Faster branch switching.** Parse results are cached by blob, so content seen before is not
  parsed again (Express, an old tag and back: 6.8 s instead of 10.1 s).

### Fixed

- **False fixes.** Fixes to type annotations and linter findings ("fix typing", "fix mypy
  finding") no longer count as defect fixes.
- **Hostile text.** Reference parsing stays linear on adversarial commit messages; author names
  and server errors are printed without control characters.
- **Commits outside HEAD's history.** The index only ever added commits, so after a reset, a
  rebase, a deleted branch, an older checkout or a CI run that restored another branch's cached
  index, answers could cite commits HEAD does not contain. Every index run (and every question
  that updates the index) now removes them, with their symbols, relations and evidence, and
  rebuilds the symbol history of the files they touched and the dependency graph; GitHub data and
  saved investigations are kept. A shallow clone keeps indexed commits it does not have. When the index is not updated (`CODEFOSSIL_AUTO_INDEX=0`, or the API serving an older
  index), `status`, `doctor`, the Markdown report, `GET /api/repositories/:id/status` (new `head`
  field) and the web UI warn that HEAD left the indexed history. Existing indexes are re-indexed
  once on the next question.

## [0.2.0] - 2026-10-07

### Added

- **MCP server.** `codefossil mcp` gives AI coding agents (Claude Code, Cursor, VS Code) nine
  read-only, offline tools: `why`, `impact`, `timeline`, `symbols`, `hotspots`, `dead_intent`,
  `fossils`, `lens` and `change_report`, with the same evidence and labels as the CLI.
- **Changed code that broke before.** `codefossil report --base` and the pull-request comment
  now lead with the functions a change modifies whose history holds earlier fixes, with those
  fixes, their issues and how many files depend on them. Repository-wide sections fold away on
  pull requests.
- **Fossils.** `codefossil fossils` lists the oldest functions, methods and classes still present,
  with the commit that introduced each and what changed since, or (`--order untouched`) the code
  that has gone longest without a change.
- **VS Code extension** (`apps/vscode`). One line of history above every function, class and
  method, details on hover, and the full history on a click, from one local `codefossil mcp`
  process per workspace. `codefossil lens <file> [--json]` and the MCP `lens` tool provide the data
  for any editor.
- **Fossil sites.** `codefossil site <dir>` writes a static website about a repository: the oldest
  code, code untouched the longest, functions fixed most often, hotspots and dead intent, with a
  history page for every function it names. `site/` holds the demo for Express and React.
- **Shareable history pages.** `codefossil why <symbol> --html <file>` writes one
  self-contained page with the symbol's birth, moves, every change on a timeline, its fixes,
  linked issues and callers.
- **Functions fixed most often.** `codefossil hotspots --symbols` ranks functions, methods and
  classes by the fix commits that changed them; on Express, `res.send` leads with 17.
- **Copied and moved code.** A new function, method or class whose content is identical to one in
  another file is recorded as copied from it (`COPIED_FROM`, DERIVED, confidence 0.9) instead of
  introduced; `why` and `fossils` follow it back to the original. A name defined once at HEAD now
  resolves to that definition even when removed copies share the name.

- **Call graph.** Call sites and import bindings are read at HEAD and resolved to `CALLS` edges
  where exactly one definition fits: the method's own class, the definition an import binds, one
  in the calling file (all DERIVED), or a unique qualified name (INFERRED). Parameters and locals
  that shadow a name, and `this` inside nested functions, are taken into account. `impact` on a
  symbol lists the functions that call it, directly and transitively, before the files that
  import it.
- **Wrapped modules.** Definitions inside a module-level IIFE (`(function () { … })()`,
  `!function () { … }()`, `.call(this)`) or a UMD factory are symbols, as at the top of a file.
- **Java, C#, Ruby and PHP.** Symbols, history, call sites and imports for four more languages.
  Java imports resolve to class files and packages by path, Ruby `require`/`require_relative` and
  PHP `require`/`use` (PSR-4 paths) to repository files, standard libraries count as built-in;
  C# namespaces stay unresolved since they are not tied to files.
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

[0.3.0]: https://github.com/ludicolijn1985-blip/codefossil/releases/tag/v0.3.0
[0.2.0]: https://github.com/ludicolijn1985-blip/codefossil/releases/tag/v0.2.0
[0.1.0]: https://github.com/ludicolijn1985-blip/codefossil/releases/tag/v0.1.0
