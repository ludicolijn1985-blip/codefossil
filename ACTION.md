# CODEFOSSIL GitHub Action

Runs CODEFOSSIL in a workflow. Each run does three things:

1. It indexes the repository's history into an index kept in the Actions cache, so later runs only
   index new commits.
2. It writes a report to the job summary.
3. Optionally, it posts the report on the pull request and updates that comment in place on later
   runs.

## Usage

```yaml
name: CODEFOSSIL
on:
  pull_request:
  schedule:
    - cron: '17 4 * * 1' # weekly re-index keeps the cache warm
  workflow_dispatch:

permissions:
  contents: read
  issues: read # GitHub sync: issues cited as evidence
  pull-requests: read # use `write` together with `comment: 'true'`

jobs:
  codefossil:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # the whole history; a shallow clone indexes only what was fetched
      - uses: ludicolijn1985-blip/codefossil@main
        with:
          comment: 'false'
```

## Inputs

| Input                 | Default               | Meaning                                                                     |
| --------------------- | --------------------- | --------------------------------------------------------------------------- |
| `base`                | pull request base     | Revision to report changes against; empty outside pull requests.            |
| `github-sync`         | `true`                | Sync issues and pull requests with `github-token` so answers can cite them. |
| `github-token`        | `${{ github.token }}` | Used for the sync and the comment; never stored.                            |
| `github-max-requests` | `1000`                | GitHub API requests per run; a larger sync continues on the next run.       |
| `hotspots`            | `10`                  | Hotspots listed in the report.                                              |
| `comment`             | `false`               | Post or update a pull-request comment (needs `pull-requests: write`).       |
| `cache`               | `true`                | Keep the index in the Actions cache.                                        |
| `working-directory`   | `.`                   | The checked-out repository.                                                 |

The Action has one output: `report-path`, the Markdown report of the run.

## The report

- **Size and evidence.** The size of the index and its relations per evidence level.
- **Files changed** (pull requests, or with `base`). For each file:
  - its rank among files with history;
  - commits and defect commits;
  - hotspot and risk scores;
  - how many files depend on it directly and transitively, with examples;
  - how many test files reach it.

  Deleted, generated and not-yet-indexed files are marked as such.

- **Historical hotspots.**
- **Dead-intent candidates.** These are always inferences.

The same report is available locally with `fossil report --base origin/main`.

## Security

- **Nothing leaves the runner.** The Action runs CODEFOSSIL's deterministic pipeline only, with
  no AI layer, and sends nothing anywhere except GitHub API calls made with the token you give it.
- **Pull requests from forks.** Use `pull_request`, not `pull_request_target`. The indexer parses
  code and never executes it, and a fork's token is read-only: the sync only reads, and a comment
  that cannot be posted leaves a warning while the report stays in the job summary.
- **Untrusted text.** Commit subjects, paths and issue text are escaped before they reach Markdown.
  They cannot add table rows, HTML or links, and `@mentions` are defused so nobody is notified.
- **No injection through inputs.** Inputs reach shell steps only through environment variables,
  never through `${{ }}` inside scripts. The base revision is resolved to a commit before git
  sees it.
- **Comment updates.** Only a bot comment that starts with the report marker is updated.
- **Cache scope.** Caches written by a pull request are only visible to that pull request.
- **Runner version.** The pinned actions run on Node.js 24 and need runner 2.327.1 or newer, which
  GitHub-hosted runners have.
- **GitHub.com only.** On GitHub Enterprise Server, set `github-sync: 'false'` or run the CLI with
  `fossil connect github --api-url`.
