# CLI

Implemented: `init`, `index`, `status`, `symbols <path>`, `deps [path]`, `connect github`. All commands accept
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
Show file evolution.

fossil why calculateVAT
Investigate symbol origin and intent.

fossil impact calculateVAT
Show direct/transitive consumers.

fossil hotspots
Show historical change hotspots.

fossil dead-intent
Show compatibility/workaround candidates.

fossil investigate
Interactive terminal investigation.

fossil query "Why does this module exist?"
Natural language query.

fossil connect github [owner/name] [--api-url URL] [--no-verify]
Link the repository to GitHub (defaults to the origin remote). Access is verified with the token
from `GITHUB_TOKEN`, `GH_TOKEN` (github.com), `GH_ENTERPRISE_TOKEN` (Enterprise Server) or
`gh auth login`; the token is never stored. A remote on another host than github.com must be
confirmed with `--api-url`. Afterwards
`fossil index` syncs issues, pull requests and reviews incrementally (`--offline` skips the
network, `--github-max-requests N` caps one run; a larger sync continues on the next run).

fossil export graph.json
Export evidence graph.

fossil doctor
Check Git, Node, database and parser health.
