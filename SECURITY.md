# Security

CODEFOSSIL is local-first.

Default behavior:

- source code stays on the user's machine
- no telemetry
- no external AI
- GitHub tokens stored using OS/keychain facilities where available
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
