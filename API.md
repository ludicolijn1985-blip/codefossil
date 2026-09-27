# API

`fossil serve` starts the JSON API for a repository's `.codefossil` database on this machine
(`127.0.0.1:4000` by default). The implementation is `apps/api` (Fastify).

## Conventions

- Every response is an envelope: on success `{ "data": … }`; on failure
  `{ "error": { "code", "message", "details"? } }`. Internal errors are logged and reported as
  `internal_error` without details.
- Every path parameter, query parameter and body is validated with a Zod schema; invalid input is
  a `400 validation_error` listing each problem (`details: [{ path, message }]`). Bodies are
  strict: unknown fields are rejected.
- Error codes: `validation_error` (400), `invalid_api_url` (400), `network_disabled` (403),
  `forbidden_host` (403), `not_found` / `target_not_found` / `file_not_found` / `symbol_not_found`
  (404), `ambiguous_target` (409, with `details.candidates`), `index_running` (409),
  `graph_too_large` (413), `unsupported_media_type` (415), `not_a_repository` /
  `unsupported_question` / `not_a_file` (422), `rate_limited` (429), `internal_error` (500).

## Security

The API has no authentication, so it is built to be reachable only from this machine:

- it listens on a loopback address; `fossil serve` refuses any other `--host`;
- the `Host` header must name this machine (`localhost`, `127.0.0.1`, `[::1]`), which defeats DNS
  rebinding;
- requests that change state must be `application/json`; browsers cannot send that cross-origin
  without a CORS preflight, which this server never grants, so other web pages cannot forge them;
- requests are rate limited (300 per minute per client by default) and bodies capped at 64 KiB;
- indexing through the API is offline: a GitHub sync (`"github": true`) is refused unless the
  server was started with `--allow-network`. The token is then resolved once, for the GitHub
  connection that existed at startup, and pinned to that API URL: if an API client rewrites the
  connection (`…/providers/github/connect` stores owner, name and an HTTPS API URL and contacts
  nothing), a sync is refused with `connection_changed` until the server is restarted to trust it;
- registering a repository (`POST /api/repositories`) accepts any absolute path inside a Git
  repository: anything able to call this local API can read what CODEFOSSIL indexes there. That
  is the trust model of an unauthenticated loopback service — do not expose it.

## Endpoints

```text
GET  /health

GET  /api/repositories
POST /api/repositories                             { path }            absolute path in a Git repo
GET  /api/repositories/:id                                             repository, status, GitHub
GET  /api/repositories/:id/status
POST /api/repositories/:id/index                   { since?, github? }  one index run at a time

GET  /api/repositories/:id/timeline?path=
GET  /api/repositories/:id/files/:fileId                               symbols, imports, importers
GET  /api/repositories/:id/symbols/:symbolId                           symbol and its why-answer
GET  /api/repositories/:id/graph?root=&depth=                          codefossil.graph/v1 document
GET  /api/repositories/:id/impact?target=&depth=

POST /api/repositories/:id/investigate             { question } | { target, kind: why|impact }
POST /api/repositories/:id/query                   { question }
GET  /api/repositories/:id/investigations?limit=
POST /api/repositories/:id/providers/github/connect  { owner, name, apiUrl? }
```

`investigate` and `query` accept `save: false` to skip recording the investigation. Targets are
resolved like the CLI: a symbol, a path, `path:Symbol`, a commit sha prefix, `#123` or
`npm:package`; an ambiguous target is a `409` listing the candidates, never a guess.

Risk analysis, computed from the index on each request:

```text
GET  /api/repositories/:id/hotspots?since=&limit=25&tests=false&generated=false&order=hotspot|risk
GET  /api/repositories/:id/dead-intent?limit=50&staleDays=365
```

- **`hotspots`** returns `{ since, orderBy, filesConsidered, hotspots, notes }`. Each hotspot
  carries:
  - `commits`, `churn` and `defectCount`, plus the most recent `defects`, each with its reason,
    level, confidence and evidence IDs;
  - `score` and its `components` (`changeFrequency`, `churn`, `defects`);
  - `risk.score` and its components (`changeFrequency`, `dependencyCentrality`, `bugDensity`,
    `testReachInverse`), with `dependents` and `testsReaching`;
  - `classification` and `evidenceIds`.
- **`dead-intent`** returns `{ candidates, runtimes, notes }`. Each candidate has:
  - a `target` (a symbol or file),
  - the `commits` whose wording flagged it,
  - `signals`, each with a kind, text, level and evidence IDs,
  - `classification: "INFERRED"`, `confidence` and `evidenceIds`.

Unknown query keys are rejected with `400`. ARCHITECTURE.md defines every number.

## Investigation response

`POST …/investigate` returns `{ kind, result, investigationId }`. For `why`, `result` contains:

```json
{
  "answer": "...",
  "confidence": 0.9,
  "classification": "DERIVED",
  "statements": [
    { "text": "...", "role": "...", "level": "FACT", "confidence": 1, "evidenceIds": [12] }
  ],
  "evidence": [
    {
      "id": 12,
      "type": "commit",
      "locator": "abc123…",
      "excerpt": "...",
      "reason": "introducing commit"
    }
  ],
  "related": [],
  "caveats": []
}
```

The answer's confidence is that of its weakest statement and its classification the weakest
evidence level. Never return an unsupported assertion as FACT.
