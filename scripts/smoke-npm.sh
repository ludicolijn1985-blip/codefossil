#!/usr/bin/env bash
# Install the built npm package the way a user would (npm, not pnpm, in an
# empty directory) and ask it a question about this repository.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$root/packaging/npm" && npm pack --silent --pack-destination "$work" > /dev/null)
mkdir "$work/user"
(cd "$work/user" && npm init -y > /dev/null && npm install --no-audit --no-fund "$work"/codefossil-*.tgz > /dev/null)

codefossil="$work/user/node_modules/.bin/codefossil"
"$codefossil" --version
(cd "$root" && "$codefossil" doctor)
(cd "$root" && "$codefossil" why runIndex --no-save | head -n 5)

# The MCP server answers the handshake and lists its tools, then exits when stdin closes
# (held open briefly so the answers are written before the client goes away).
mcp_out="$(cd "$root" && {
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 5
} | "$codefossil" mcp 2> /dev/null)"
for expected in '"name":"codefossil"' '"name":"why"' '"name":"change_report"'; do
  if [[ "$mcp_out" != *"$expected"* ]]; then
    echo "MCP smoke test: missing $expected in: $mcp_out" >&2
    exit 1
  fi
done
echo "MCP server: handshake and tools/list OK"
