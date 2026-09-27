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
