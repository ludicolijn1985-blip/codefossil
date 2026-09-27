# Security

CODEFOSSIL is local-first.

Default behavior:

- source code stays on the user's machine
- no telemetry
- no external AI: the optional AI layer is off until `codefossil ai configure` turns it on (see below)
- GitHub tokens are never stored: each run reads them from the environment or the GitHub CLI's
  login (`gh auth token --hostname`), scoped per host like the GitHub CLI does — `GITHUB_TOKEN`
  and `GH_TOKEN` go to github.com only, `GH_ENTERPRISE_TOKEN` to an Enterprise Server host.
- A repository's remote never chooses where a token is sent: only github.com is derived from it;
  any other host must be confirmed by the user with `--api-url`.
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
