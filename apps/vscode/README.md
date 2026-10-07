# CODEFOSSIL for VS Code

See why code exists, right where you read it. Above every function, class and method:

```text
born 2011 · 78 changes · 17 fixes · 64 callers
```

Hover for the commit it was born in, the issue behind it, where it moved from and its latest
change. Click the line for the full, evidence-backed history.

Everything comes from your repository's own Git history, indexed on your machine by
[CODEFOSSIL](https://github.com/ludicolijn1985-blip/codefossil). Nothing is uploaded, no account
is needed, and no AI is involved.

## How it works

The extension starts one `codefossil mcp` process per workspace folder (through `npx`, so Node.js
22.12 or later must be installed) and asks it for the history of each file you open. The first
time, CODEFOSSIL indexes the repository's history into `.codefossil/`, which ignores itself in
Git; later, only new commits are added.

## How sure is it?

- Dates and commits are facts read from Git.
- "Born" and "changes" compare each version of a function with the same file in the commit's
  parent, and follow code that was moved to another file.
- "Fixes" are recognised from commit wording, reverts and (with GitHub connected) issues labelled
  as bugs, so most are inferences.
- Callers are calls resolved statically; calls through variables or callbacks are not counted.

## Settings

| Setting               | Default |                                                                                                                                                                  |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codefossil.codeLens` | `true`  | Show the history line above definitions.                                                                                                                         |
| `codefossil.command`  | `[]`    | The program and arguments that start `codefossil mcp`, run without a shell, e.g. `["node", "/path/to/codefossil.js", "mcp"]`. Empty: `npx --yes codefossil mcp`. |

## Commands

- **CODEFOSSIL: Show the history of this function** (also on a click on the history line).
- **CODEFOSSIL: Restart**.
