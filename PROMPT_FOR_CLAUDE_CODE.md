# Master build prompt

You are the lead engineer for CODEFOSSIL.

Read CLAUDE.md, ARCHITECTURE.md, SCHEMA.md, API.md, CLI.md, UI.md and ROADMAP.md before writing code.

Build the repository in small vertical slices.

For each slice:

1. implement production code
2. add unit tests
3. add fixtures
4. run lint
5. run typecheck
6. run tests
7. fix failures
8. update documentation

Start with the monorepo foundation.

Then implement a working vertical slice:

`fossil init`
-> open repository
-> scan commits
-> scan files
-> parse TypeScript
-> store symbols
-> store imports
-> create relations
-> `fossil status`
-> local API
-> web dashboard.

Do not create placeholder buttons for functionality that does not exist.

The first demo must allow a developer to point CODEFOSSIL at its own repository and inspect:

- a file's history
- the symbol tree
- dependencies
- related commits
- an evidence-backed "why" investigation.

Use fixtures rather than mocking away the core logic.

When an algorithm is uncertain, expose the uncertainty rather than hiding it.

Do not add external AI until the deterministic evidence pipeline is working.

At the end of every phase, leave the project runnable with documented commands.
