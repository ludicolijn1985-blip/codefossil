# CLI

Install nothing: `npx codefossil <command>` runs the latest release (Node.js 22.12+), or install it
with `npm install -g codefossil`. Every command accepts `--repo <path>`; most accept `--json`.

Questions (`why`, `impact`, `timeline`, `query`, `trace`, `hotspots`, `dead-intent`, `report`,
`ask`, `serve` and the rest) bring the index up to date first: the first one in a repository
creates `.codefossil/` and indexes the history, later ones add only new commits. This automatic
indexing is offline; `codefossil index` also syncs GitHub, GitLab, Jira and Linear. Set `CODEFOSSIL_AUTO_INDEX=0` to use the
index exactly as it is. Progress goes to standard error, so `--json` output stays clean.

codefossil init
Initialize `.codefossil/`.

codefossil index
Index Git history, source files, AST and dependencies.

codefossil index --since 2025-01-01
Incremental historical indexing.

codefossil index --typescript
Also resolve TypeScript calls with the TypeScript type checker: calls through variables, return
types, generics, overloads and re-exports become exact `CALLS` edges (DERIVED, 1) that replace the
name-based reading of the same call sites. It compiles the root tsconfig.json and its references,
or each package's tsconfig.json in a monorepo; files with uncommitted changes are skipped. It uses
the TypeScript installed next to codefossil (`npm install -g codefossil typescript`);
`--typescript-from-repo` also allows the compiler the repository installed, which runs the
repository's code, so use it only for repositories you trust. `CODEFOSSIL_TYPESCRIPT=1` makes
type checking the default (also for automatic indexing), never the repository's compiler.

Indexing also reads line coverage from an lcov report in the working tree (`coverage/lcov.info`,
`lcov.info` or `coverage/lcov/lcov.info`) when there is one, and a Python virtual environment
(`.venv`, `venv`, `env`) and workspace packages in `node_modules` to resolve imports.

codefossil gc [--max-cache n]
Shrink the index: drop cached parse results of other extraction versions and beyond the limit
(200,000 by default), then compact the database. Nothing an answer cites is removed.

codefossil status
Show index health and counts.

codefossil symbols src/payment/vat.ts
Show a file's current symbols, their versions and the commit that introduced each one.

codefossil deps src/app.ts
Show what a file imports (resolved, built-in or unresolved with the reason) and which files
import it.

codefossil deps
List declared dependencies per manifest and how many files import each.

codefossil timeline src/payment/vat.ts
Show every change to a file, following renames back, with the symbols each commit changed and
the pull requests and issues behind it.

codefossil why calculateVAT [--json] [--no-save]
Explain where a symbol, file, commit, issue or dependency comes from. The answer is a list of
statements, each with its evidence level, confidence and cited evidence; its overall confidence
is that of its weakest statement. Missing evidence is stated, not filled in. `--json` returns the
API.md investigation shape.

codefossil why res.send --html res-send.html
Also write a one-page history of a symbol as self-contained HTML (no scripts, no external
resources, all repository text escaped): its birth followed back through copies, every change on
a timeline, which changes read as fixes, linked issues and pull requests, and its callers.

codefossil site fossil-site [--limit n] [--name acme/shop]
Write a static website about the repository's history: an overview of the oldest code, code
untouched the longest, functions fixed most often, hotspots and dead-intent candidates, and a
one-page history for every function it names. No scripts or external resources; open
`fossil-site/index.html` or host the folder anywhere.

codefossil impact calculateVAT [--depth n]
Show what depends on a target, with distances, routes and which are tests. For a symbol: the
functions (or files, at module level) that call it, directly and through other calls, then the
files that import its file. A call resolves at HEAD only where one definition fits: the method's
own class for `this`/`self` (DERIVED), the definition an import binds (DERIVED, 0.95), a definition
in the calling file (DERIVED), or, for `a.b()` and for names that are parameters or locals, a
unique qualified name anywhere (INFERRED, 0.6). A call through a name whose type the code states
(`new Repo()`, `repo: Repo`, a typed field or parameter; TypeScript, JavaScript, Python, Java, C#,
Go) is read as a call on that type (×0.9), and a function passed by name counts as an INFERRED
caller (at most 0.8). Ambiguous calls are left out, never guessed. Files count when they import the
defining file and do not name only other things from it.

codefossil hotspots [--since date] [--limit n] [--order hotspot|risk] [--tests] [--generated] [--json]
Rank files by historical change: hotspot score (change frequency × churn × defect commits) and
risk (change frequency × import centrality × bug density × test reach inverse), each shown with
its components and the defect commits behind it. With a current coverage report, "test reach
inverse" is the uncovered share of the file's lines. Tests and lockfiles/generated files are left
out unless `--tests` / `--generated` is given.

codefossil hotspots --symbols [--limit n] [--tests] [--json]
Rank functions, methods and classes instead: by the fix commits that changed them, then by all
their changes, with the latest fixes. Fix commits are inferences unless an issue labelled as a bug
links them.

codefossil fossils [--order introduced|untouched] [--limit n] [--tests] [--json]
The oldest functions, methods and classes still present, with the commit that introduced each one
and what changed since; `--order untouched` lists the code that has gone longest without a change.
Code copied or moved to another file with identical content, or renamed in place, is dated from
its original (DERIVED, 0.9); code moved to another file with edits is followed when its name left
the other file in the same commit (INFERRED, 0.6). Only origins the indexed history establishes are dated; older code
is counted, never guessed. Tests, examples and docs are left out unless `--tests` is given.

codefossil owners [path] [--limit n] [--active-days n] [--tests] [--json]
Who wrote the code: per file each author's share of the lines changed and whether they still
commit (within `--active-days` of the latest commit, 365 by default), files mostly written by an
author who left (at risk), and the bus factor of the files in scope. People are matched across
name spellings and shared email addresses. INFERRED: authorship stands in for knowledge.

codefossil dead-intent [--limit n] [--stale-days n] [--json]
List code changed by commits (or linked issues and pull requests) that speak of workarounds,
compatibility or legacy support, with the signals that strengthen each candidate: runtime versions
below the declared minimum, passed deadlines, and long silence. Always INFERRED candidates.

codefossil report [--base <revision>] [--limit n] [--json]
Write a Markdown report (for CI summaries and pull-request comments): index size, historical
hotspots, dead-intent candidates and, with `--base`, the functions the change touches (new,
changed, renamed, moved, with the lines that ran in the tests when a coverage report is current)
and every file changed since the merge base with its history, hotspot and risk scores, dependents
and the tests that reach it. Repository text is
escaped, and `@mentions` are defused.

codefossil ai configure --provider ollama|anthropic [--model m] [--base-url url] [--allow-cloud] [--include-source]
codefossil ai status [--json]
codefossil ai off
Turn the optional AI layer on or off. It is off by default. A provider that runs off this machine
needs `--allow-cloud`; source excerpts are withheld unless `--include-source`. No key is stored.

codefossil ask "Why did we keep the legacy invoice path?" [--json]
Answer an open question with the AI layer. Evidence is gathered deterministically first (why
investigations of entities the question names, commits using its words); the model answers only
from that, and every claim must cite it. If nothing relates, the model is not asked.

codefossil why calculateVAT --summarize
The deterministic answer followed by an AI summary citing the same evidence (INFERRED, never
more certain than the investigation).

codefossil investigate [--list] [--show <id>]
Interactive investigation (why/impact/timeline/questions), also scriptable through standard
input. `why`, `impact` and `query` answers are saved and can be shown again later.

codefossil query "Why does this module exist?"
Answer a recognized question (why …, what depends on …, history of …) deterministically;
open-ended questions are declined until the optional AI layer is configured.

codefossil connect github [owner/name] [--api-url URL] [--no-verify]
Link the repository to GitHub (defaults to the origin remote). Access is verified with the token
from `GITHUB_TOKEN`, `GH_TOKEN` (github.com), `GH_ENTERPRISE_TOKEN` (Enterprise Server) or
`gh auth login`; the token is never stored. A remote on another host than github.com must be
confirmed with `--api-url`. Afterwards
`codefossil index` syncs issues, pull requests and reviews incrementally (`--offline` skips the
network, `--github-max-requests N` caps one run; a larger sync continues on the next run).

codefossil connect gitlab [group/name] [--api-url URL] [--no-verify]
Link the repository to a GitLab project (defaults to the origin remote; nested groups allowed).
The token comes from `GITLAB_TOKEN` and is never stored; without one only public projects sync,
within a small budget. A remote on another host than gitlab.com must be confirmed with
`--api-url https://host/api/v4`. `codefossil index` then syncs issues and merge requests: their
commits, merge commits and the issues GitLab records as closed by them (FACT).

codefossil connect jira <url> [--projects KEY,KEY]
codefossil connect linear [--projects KEY,KEY]
Link an issue tracker. `codefossil index` reads the issues that commits and pull requests name by
key (`PROJ-123`) — only keys of projects (teams) the tracker knows, each at most weekly — with
`JIRA_API_TOKEN` (plus `JIRA_EMAIL` for Jira Cloud) or `LINEAR_API_KEY`, never stored. A commit
naming a bug ticket counts as a fix (INFERRED, 0.7).

codefossil export graph.json [--root <target>] [--depth n]
Export the evidence graph (format `codefossil.graph/v1`: nodes, edges with provenance, cited
evidence), whole or around one target. `-` writes to standard output.

codefossil trace <target> [--route origin|history|impact] [--depth n]
Show raw evidence chains from a target, every link with its level, confidence, producer and
evidence. Targets: a symbol, a path, `path:Symbol`, a commit sha, `#123` or `npm:package`;
an ambiguous target lists the candidates instead of picking one.

codefossil serve [--port 4000] [--allow-network]
Serve the JSON API (see API.md) on this machine only.

codefossil mcp
Serve this repository to AI coding agents over the Model Context Protocol (stdio). Tools: `why`,
`impact`, `timeline`, `symbols`, `hotspots`, `dead_intent`, `fossils`, `lens`, `owners` and `change_report`, each the
command of the same name, read-only and offline. The index is brought up to date before the first
answer; progress goes to stderr. Use `--repo <path>` when the client cannot set the directory.

codefossil doctor
Check Git, Node, database and parser health.
