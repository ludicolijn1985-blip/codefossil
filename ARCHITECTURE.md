# Architecture

## Data flow

```text
Repository
  -> Git scanner
  -> Commit/File history
  -> AST parser
  -> Symbols/Imports/Calls
  -> Relationship builder
  -> Evidence graph
  -> Analyzers
  -> Query engine
  -> CLI/API/UI
```

External providers:
GitHub / GitLab / Jira / Linear / Sentry / Slack / Notion

Providers must normalize external records into the internal evidence model.

## Evidence levels

FACT
Directly observed from a source.

DERIVED
Computed deterministically from facts.

INFERRED
A conclusion produced by a heuristic or AI model.

Every relationship has:

- source
- target
- relation type
- evidence type
- confidence
- provenance
- created_at

## Example

```text
Issue #398
  RESOLVED_BY
PR #421
  IMPLEMENTED_BY
Commit abc123
  MODIFIES
src/payment/vat.ts
  CONTAINS
calculateVAT()
  TESTED_BY
vat.test.ts
```

A natural-language answer must be generated from these records, not invented independently.

## Core algorithms

### Change hotspot

For each file:

```text
score = normalized(commit_count) * normalized(churn) * normalized(defect_links + 1)
```

### Historical risk

```text
risk =
  change_frequency
  * dependency_centrality
  * historical_bug_density
  * test_coverage_inverse
```

Normalize each component to [0,1]. Display the components rather than only a single score.

### Dead intent candidate

Flag when:

- code was introduced by a commit containing workaround/compatibility/deprecation language
- related issue/PR has an expiration or old version reference
- current project metadata indicates the referenced version/platform is no longer supported
- no recent evidence confirms the workaround is still required

This is a CANDIDATE, never a fact.

### Impact analysis

Build reverse dependency traversal from:

```text
symbol -> callers -> modules -> tests -> routes -> packages
```

Return direct and transitive dependencies with path explanations.
