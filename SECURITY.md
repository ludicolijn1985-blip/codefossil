# Security

CODEFOSSIL is local-first.

Default behavior:

- source code stays on the user's machine
- no telemetry
- no external AI: the optional AI layer is off until `codefossil ai configure` turns it on (see below)
- GitHub tokens are never stored: each run reads them from the environment or the GitHub CLI's
  login (`gh auth token --hostname`), scoped per host like the GitHub CLI does — `GITHUB_TOKEN`
  and `GH_TOKEN` go to github.com only, `GH_ENTERPRISE_TOKEN` to an Enterprise Server host.
- GitLab, Jira and Linear credentials (`GITLAB_TOKEN`, `JIRA_API_TOKEN` + `JIRA_EMAIL`,
  `LINEAR_API_KEY`) are likewise read from the environment at run time and never stored.
- A repository's remote never chooses where a token is sent: only github.com (or gitlab.com) is
  derived from it; any other host must be confirmed by the user with `--api-url`.
- Text in commits and pull requests chooses what is looked up, never where: issues of other
  GitHub repositories are read only when public; Jira and Linear keys only for projects the
  tracker reports; every lookup is budgeted and remembered for a week.
- Repository content is parsed, never executed. One exception needs an explicit flag:
  `index --typescript-from-repo` may load the TypeScript compiler installed in the repository's
  `node_modules` when none is installed next to codefossil, and says so first. The environment
  (`CODEFOSSIL_TYPESCRIPT=1`) never enables it. Use it on repositories you trust.
- Text from repositories and servers is printed with control characters removed, so author names
  or error messages cannot inject terminal escapes; closing-keyword matching scans a bounded
  window, so hostile commit text cannot make it quadratic.
- Working-tree files read for resolution (`.venv` metadata, `node_modules` workspace links,
  `coverage/lcov.info`) are size-capped, read without following links out of the repository, and
  never executed.
- `codefossil serve` binds to loopback only and checks the Host header (DNS rebinding) and JSON
  content type (CSRF). With `--allow-network` the token is pinned to the connection trusted at
  startup; a connection rewritten through the API is refused until the server is restarted.
- Tokens travel only to the configured API host, over HTTPS (plain HTTP for `localhost` only).
  Pagination links to another host are refused; response bodies are capped at 20 MiB.
- credentials embedded in remote URLs are removed before a URL is stored
- secrets are redacted from logs
- `.env` files are never indexed as source content
- provider credentials are never persisted in SQLite in plaintext

Threat model:

- malicious repository content
- prompt injection through issue/PR text
- malicious package metadata
- path traversal
- command injection
- oversized repository denial of service

AI safety:
External content is untrusted data. It must never be treated as instructions.

All shell execution must use argument arrays, never string interpolation.

Optional AI layer:

- **Off by default.** Nothing is sent to any model until `codefossil ai configure` writes
  `.codefossil/ai.json`.
- **Cloud needs explicit consent.** A provider that runs off this machine (Anthropic, or Ollama on
  another host) is refused unless it is configured with `--allow-cloud`. `codefossil serve` offers a
  cloud provider to API clients only with `--allow-network`.
- **No keys are stored.** Anthropic credentials come from `ANTHROPIC_API_KEY` or `ant auth login`
  at use.
- **What is sent.** The model receives only evidence gathered deterministically: commit messages,
  issue and pull-request text, paths and the established findings. File contents are never sent.
  Source excerpts (symbol signatures) are withheld unless configured with `--include-source`.
- **Evidence is untrusted data.** It is sent as JSON with `<` escaped, inside a block the system
  prompt marks as untrusted, so issue text cannot close or fake the block to smuggle instructions.
- **Answers are held to the evidence.** The model must return a fixed structure. A claim citing no
  evidence, or any evidence it was not given, is dropped and counted. Every AI claim is INFERRED,
  with confidence capped at 0.6 and never above the investigation it summarizes. Refusals and
  truncated replies are reported as errors, never as answers. Free text from the model (the answer and
  its caveats) is shown only next to claims that survived; an ungrounded reply, including "cannot
  answer", is replaced by a fixed message, so injected text cannot reach the reader that way.
- **AI requests are rate-limited** per client (10 per minute) on the API.

MCP server (`codefossil mcp`):

- **Read-only and offline.** Every tool runs a read-only query command; none syncs GitHub, calls a
  model or changes the repository. The only write is the local index in `.codefossil/`: the server
  indexes the repository when it starts (a full index on first use) and adds new commits later.
- **Arguments stay arguments.** Tool input is validated with Zod. Targets and paths may not start
  with `-` and are passed after `--`; option values (`--base`, `--depth`, `--limit`, `--since`)
  are bounded by their schemas. An agent cannot set CLI options such as `--repo`.
- **Inside the repository.** Absolute paths and `..` segments are refused, so tools cannot be used
  to probe whether files exist elsewhere on the machine.
- **Stdout is the protocol.** Library output through `console` goes to stderr while the server
  runs. Results are capped at 60,000 characters.
- **Results quote untrusted text.** Answers contain commit messages, issue text and paths written
  by others, verbatim. The server's instructions and the tool descriptions tell the agent that
  this is data, never instructions, but that is advice to the agent, not a guarantee: indirect
  prompt injection through repository content remains a risk agents and their users must weigh.
