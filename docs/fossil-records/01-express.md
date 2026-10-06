# Fossil Records #1: Express — a three-line function nobody has touched since 2011

_Every number below comes from running [CODEFOSSIL](https://github.com/ludicolijn1985-blip/codefossil)
on the Express repository at commit `7ef9844` (2026-09-28): 6,173 commits by 394 authors, going back
to 2009-06-26. Each section ends with the command that reproduces it, and each claim says how sure
it is: FACT (observed), DERIVED (computed from facts) or INFERRED (a heuristic reading)._

Express is one of the most widely used packages in the JavaScript world, and a 17-year-old
codebase. What does that history look like from the inside?

## 1. Fifteen years without a single change

<!-- prettier-ignore -->
```js
res.get = function(field){
  return this.getHeader(field);
};
```

`res.get` was added on **2011-08-10** in `c8c6aa2` _"Added `res.get(field)` as an alternative to
`res.header(field)`"_ by TJ Holowaychuk. Since then, across the 3,163 commits that followed, nobody has changed
a character of it (DERIVED; `git log -L` agrees).

Express has other quiet corners. These functions have not changed since they were written either:

| Function               | Introduced                                                                      |           |
| ---------------------- | ------------------------------------------------------------------------------- | --------- |
| `req.acceptsEncodings` | 2014-01-03, `cec0c06` "refactor req.is and req.accepts\*"                       | unchanged |
| `defineGetter`         | 2014-06-22, `746044b` "Replace \_\_defineGetter\_\_ with Object.defineProperty" | unchanged |
| `tryStat`              | 2014-10-23, `6614352` "Add support for app.set('views', array)"                 | unchanged |

```bash
npx codefossil fossils --order untouched
```

## 2. The function that keeps breaking

Ranked by the commits that fixed them, one function stands far ahead:

| Function                   | Fix commits | All changes |
| -------------------------- | ----------: | ----------: |
| `res.send`                 |          17 |          79 |
| `res.redirect`             |           9 |          60 |
| `app.defaultConfiguration` |           6 |          53 |

`res.send` has been changed 79 times since it took its current form in 2011, and 17 of those
commits read as fixes: the most recent on 2026-09-15 (`9a34acf`, _"fix(res.send): preserve ETag
generation with Transfer-Encoding (#7459)"_), the one before that on 2026-06-16. After fifteen
years, the function every Express app calls is still being repaired. It has 64 statically resolved
callers in the repository, 37 of them in tests.

These counts are INFERRED: without GitHub data, a fix commit is recognised from its wording
(`fix:`, "Fix …") and from reverts. Connecting GitHub (`codefossil connect github`) adds issues
labelled as bugs, which makes them DERIVED.

```bash
npx codefossil hotspots --symbols
npx codefossil impact res.send
```

## 3. Code that moved house

`app.init` lives in `lib/application.js`. CODEFOSSIL notices that it arrived there, with identical
content, from `lib/http.js` on 2011-10-07 (`667ed6f`, _"using connect.proto.use"_), and that the
code itself was written on 2011-04-26 (`a3678cd`, _"refactored http.js"_). It has changed 20 times
since the move. `git blame` would have stopped at the move. (The copy is DERIVED at confidence
0.9: identical content is observed; that it was copied rather than rewritten identically is
inferred.)

```bash
npx codefossil why app.init
```

## 4. Workarounds whose reason may be gone

CODEFOSSIL looks for code changed by commits that speak of deprecation, compatibility or
workarounds, and that has been silent since. Two candidates in Express:

- `res.jsonp`: shaped by four deprecation commits between 2014 and 2021, unchanged since
  2021-11-17.
- `res.vary`: changed "with backwards compatibility" and given a deprecation message in 2014,
  unchanged since 2017.

Both are INFERRED at confidence 0.40: a hint for a maintainer to look at, not a verdict. Express
may well keep them on purpose.

```bash
npx codefossil dead-intent
```

## How sure is any of this?

- **Dates and commits** are FACT: they are read from git.
- **"Introduced in" and "changed N times"** are DERIVED: a symbol's versions are compared with the
  same file in each commit's parent. A symbol is identified by its name within a file, so
  `res.send` is dated from **2011-02-04**, when today's `res.send = function` definition first
  appeared; the behaviour existed earlier under a different shape, which CODEFOSSIL does not claim
  to track.
- **Fixes and dead intent** are INFERRED, as stated above.

## Try it on your own repository

```bash
cd your-repository
npx codefossil fossils
```

The first command indexes the history into `.codefossil/` (Express takes about 16 seconds). No
account, no upload, no AI.
