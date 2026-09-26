# CLI

Implemented: `init`, `index`, `status`, `symbols <path>`. All commands accept `--repo <path>`
and `--json`. The rest of this file is the target surface.

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

fossil connect github
Configure GitHub integration.

fossil export graph.json
Export evidence graph.

fossil doctor
Check Git, Node, database and parser health.
