# CLI

Implemented: `init`, `index`, `status`, `symbols <path>`, `deps [path]`, `connect github`, `trace <target>`, `export <file>`, `why`, `impact`, `timeline`, `query`,
`investigate`, `serve`. All commands accept
`--repo <path>` and `--json`. The rest of this file is the target surface.

fossil init
Initialize `.codefossil/`.

fossil index
Index Git history, source files, AST and dependencies.

fossil index --since 2025-01-01
Incremental historical indexing.

fossil status
Show index health and counts.

fossil symbols src/payment/vat.ts
Show a file's current symbols, their versions and the commit that introduced each one.

fossil deps src/app.ts
Show what a file imports (resolved, built-in or unresolved with the reason) and which files
import it.

fossil deps
List declared dependencies per manifest and how many files import each.

fossil timeline src/payment/vat.ts
Show every change to a file, following renames back, with the symbols each commit changed and
the pull requests and issues behind it.

fossil why calculateVAT [--json] [--no-save]
Explain where a symbol, file, commit, issue or dependency comes from. The answer is a list of
statements, each with its evidence level, confidence and cited evidence; its overall confidence
is that of its weakest statement. Missing evidence is stated, not filled in. `--json` returns the
API.md investigation shape.

fossil impact calculateVAT [--depth n]
Show direct and transitive dependents with distances, routes and which are tests (file-level:
dependents import the file that defines a symbol).

fossil hotspots [--since date] [--limit n] [--order hotspot|risk] [--tests] [--generated] [--json]
Rank files by historical change: hotspot score (change frequency × churn × defect commits) and
risk (change frequency × import centrality × bug density × test reach inverse), each shown with
its components and the defect commits behind it. Tests and lockfiles/generated files are left out
unless `--tests` / `--generated` is given.

fossil dead-intent [--limit n] [--stale-days n] [--json]
List code changed by commits (or linked issues and pull requests) that speak of workarounds,
compatibility or legacy support, with the signals that strengthen each candidate: runtime versions
below the declared minimum, passed deadlines, and long silence. Always INFERRED candidates.

fossil investigate [--list] [--show <id>]
Interactive investigation (why/impact/timeline/questions), also scriptable through standard
input. `why`, `impact` and `query` answers are saved and can be shown again later.

fossil query "Why does this module exist?"
Answer a recognized question (why …, what depends on …, history of …) deterministically;
open-ended questions are declined until the optional AI layer is configured.

fossil connect github [owner/name] [--api-url URL] [--no-verify]
Link the repository to GitHub (defaults to the origin remote). Access is verified with the token
from `GITHUB_TOKEN`, `GH_TOKEN` (github.com), `GH_ENTERPRISE_TOKEN` (Enterprise Server) or
`gh auth login`; the token is never stored. A remote on another host than github.com must be
confirmed with `--api-url`. Afterwards
`fossil index` syncs issues, pull requests and reviews incrementally (`--offline` skips the
network, `--github-max-requests N` caps one run; a larger sync continues on the next run).

fossil export graph.json [--root <target>] [--depth n]
Export the evidence graph (format `codefossil.graph/v1`: nodes, edges with provenance, cited
evidence), whole or around one target. `-` writes to standard output.

fossil trace <target> [--route origin|history|impact] [--depth n]
Show raw evidence chains from a target, every link with its level, confidence, producer and
evidence. Targets: a symbol, a path, `path:Symbol`, a commit sha, `#123` or `npm:package`;
an ambiguous target lists the candidates instead of picking one.

fossil serve [--port 4000] [--allow-network]
Serve the JSON API (see API.md) on this machine only.

fossil doctor
Check Git, Node, database and parser health.
