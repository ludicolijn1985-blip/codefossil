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

### Chains

A chain holds only if every link holds: its confidence is the product of the edge confidences,
and its evidence level is that of its weakest edge (one DERIVED edge makes the chain DERIVED).
Traversals are bounded in depth, fan-out and number of paths; whatever a bound cuts off is
reported with the result, so a partial answer is never presented as complete.

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

### How the risk analyzers apply these definitions

`packages/analyzers` computes all three on demand from the index; nothing is stored, so the numbers
always match the current index.

- **Files ranked.** Files at HEAD with at least one change, followed back across renames. A pure
  rename is not a change. Tests, lockfiles, build output and generated files are left out unless
  asked for. `normalized(x)` is `x / max(x)` over the files ranked.
- **Defect links.** A commit counts as defect-related when:
  - it resolves an issue labelled as a bug (DERIVED, with the link's confidence),
  - it is a revert (INFERRED, 0.7), or
  - its subject marks a fix (`fix:`, INFERRED 0.6) or uses fix wording (INFERRED 0.5).

  Fixes to typos, docs or formatting do not count. A hotspot is DERIVED when it rests on counts
  alone, and INFERRED as soon as an inferred defect reading contributes.

- **Dependency centrality.** Files that import the file within 5 hops, divided by the maximum.
- **Historical bug density.** Defect-related commits divided by all commits to the file.
- **Test coverage inverse.** `1 / (1 + test files that import the file within 5 hops)`. This is
  import reach, not line coverage, and is labelled that way.
- **Dead intent.** A candidate needs workaround or compatibility wording (for example workaround,
  hack, temporary, compat, polyfill, shim, legacy, deprecated, "remove once …"). The wording must
  appear in a commit that changed code still present at HEAD, or in an issue or pull request
  linked to that commit. The target is each current symbol the commit changed; a file is the
  target when the commit changed no symbol in it. These signals add to the confidence:

  | Signal              | Level    | Adds | Meaning                                                                                                                                    |
  | ------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | Workaround wording  | INFERRED | 0.3  | The commit or its linked discussion uses the wording.                                                                                      |
  | Unsupported version | DERIVED  | 0.25 | The text names a runtime version below the lowest minimum the manifests declare (`engines.node`, `requires-python`, `go`, `rust-version`). |
  | Deadline passed     | DERIVED  | 0.2  | The text sets a deadline ("until 2024-06") that has passed.                                                                                |
  | No confirmation     | DERIVED  | 0.1  | The target has not changed for a year.                                                                                                     |

  The confidence is capped at 0.8, and the candidate is always INFERRED.

### Optional AI layer

`packages/ai` runs only when configured (`codefossil ai configure`). It never replaces the
deterministic pipeline; it reads from it:

1. **Gather.** Evidence is gathered deterministically: why-investigations of the entities the
   question names (words matching more than three entities are skipped), plus commits whose
   messages use its words. At most 40 items, excerpts at most 600 characters. Source excerpts are
   withheld unless allowed. If nothing is found, the model is not called.
2. **Ask.** The model gets the question, the established findings (with their levels) and the
   evidence as inert JSON marked untrusted. It must return `{answer, unanswerable, claims:
[{text, evidenceIds, confidence}], caveats}`.
3. **Hold to evidence.** A claim citing no evidence, or any id it was not given, is dropped
   (counted in `rejectedClaims`). Confidence is clamped to [0, min(0.6, ceiling)], where the
   ceiling is the investigation's own confidence for summaries. The answer's confidence is its
   weakest claim, and it is always INFERRED. An answer with no surviving claim is discarded.

Providers:

- **Ollama.** Local by default, JSON-schema `format`, reply validated.
- **Anthropic.** The official SDK with structured outputs, adaptive thinking and server-side
  refusal fallbacks. The stop reason is checked before the content.

### Impact analysis

Build reverse dependency traversal from:

```text
symbol -> callers -> modules -> tests -> routes -> packages
```

Return direct and transitive dependencies with path explanations.

**Call graph.** While reading imports at HEAD, the dependency indexer also records each file's
call sites (`calls` table) and the names each import binds (`import { a as b }`, `import * as u`,
`const u = require()`, Python `import m as u` and `from m import f`, Go package names). Per call
site the parser notes the callee as a name path (`utils.flatten`, `this.save`, `*.listen`), the
innermost symbol whose source range contains it, whether the first name is declared inside that
symbol (a parameter, variable or inner function), and whether it is the method's own object
(`this` outside nested functions, `self`, a Go receiver). After the import edges are rebuilt, a
call is recorded as `CALLS` (caller symbol, or the file for module-level code, to the callee)
only when exactly one definition fits, by the first rule its first name allows:

| First name of the callee | Rule                                                                                                                                                               | Level        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| The method's own object  | `this.validate()` in `Cart.total` → `Cart.validate` in the file                                                                                                    | DERIVED 1.0  |
| A parameter or local     | only the qualified-name rule below                                                                                                                                 | INFERRED 0.6 |
| Bound by an import       | `sum()` from `import { sum }`, `utils.sum()` from `import * as utils`: the definition in the file the import resolved to — never a same-named definition elsewhere | DERIVED 0.95 |
| Anything else            | a definition of that name in the calling file                                                                                                                      | DERIVED 1.0  |
| (fallback for `a.b()`)   | one definition named `a.b` in the repository                                                                                                                       | INFERRED 0.6 |

Each edge cites its call site as `ast_node` evidence (`path@sha#Lline`); a rebuild reuses the
evidence row of an unchanged call site, so its id stays stable. Calls whose receiver is an
expression (`getApp().listen()`), that fit several definitions, or whose calling symbol is not in
the index are not recorded. `impact`
walks `CALLS` backwards for callers, then `CONTAINS`/`IMPORTS` for files.
