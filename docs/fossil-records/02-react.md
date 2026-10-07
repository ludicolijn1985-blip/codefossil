# Fossil Records #2: React — code from the first public commit still ships in 2026

_Every number below comes from running [CODEFOSSIL](https://github.com/ludicolijn1985-blip/codefossil)
on the React repository at commit `17eca7b` (2026-10-06): 21,712 commits by 1,961 authors, going
back to the initial public release on 2013-05-29. Each section ends with the command that
reproduces it, and each claim says how sure it is: FACT (observed), DERIVED (computed from facts)
or INFERRED (a heuristic reading)._

## 1. A survivor from day one

React was open-sourced on 2013-05-29 with one commit, `75897c2` _"Initial public release"_. One
function from that commit is still in the codebase, 13 years and 21,000 commits later:
`isEventSupported`, today in `packages/react-dom-bindings/src/events/isEventSupported.js`.

It started life as `src/domUtils/isEventSupported.js`, moved with every reorganisation since
(`domUtils` → `dom` within a week, then into `packages/`), and has been changed 13 times, most
recently on 2026-06-05 for a Flow upgrade (DERIVED). Its doc comment still carries the licence
line of where the idea came from: _Modernizr 3.0.0pre_.

A handful of other functions from that first commit survive too, but not where they started: on
2020-07-01, _"Fork legacy-events folder into react-dom and react-native (#19228)"_ copied the old
event system into React Native's renderer, where `executeDispatchesInOrder`,
`executeDirectDispatch` and friends still live. CODEFOSSIL follows them back through the copy to
2013 (DERIVED at confidence 0.9 for the copy: the content is identical, the copying is inferred).

```bash
npx codefossil fossils
npx codefossil why isEventSupported
```

## 2. The functions that keep getting fixed

Ranked by the commits that fixed them:

| Function                  | File                                             | Fix commits | All changes |
| ------------------------- | ------------------------------------------------ | ----------: | ----------: |
| `completeWork`            | `react-reconciler/src/ReactFiberCompleteWork.js` |          14 |         245 |
| `Tree`                    | `react-devtools-shared/…/Components/Tree.js`     |          14 |          95 |
| `updateSuspenseComponent` | `react-reconciler/src/ReactFiberBeginWork.js`    |           7 |          64 |
| `throwException`          | `react-reconciler/src/ReactFiberThrow.js`        |           7 |          63 |

`completeWork`, where the reconciler finishes each fiber, has been changed 245 times, and 14 of
those commits read as fixes. The fix counts are INFERRED from commit wording and reverts; with
GitHub connected, issues labelled as bugs make them DERIVED.

```bash
npx codefossil hotspots --symbols
npx codefossil why completeWork --html completeWork.html
```

## 3. Untouched since the fiber rewrite

Of 7,792 dated functions, classes and methods, 3,849 have never changed since they were written.
Among the longest-untouched code that still does something:

- `LinearGradient`, `RadialGradient` and `Pattern` in `react-art`, imported on 2016-12-07 with
  _"Imported new ReactART fiber renderer"_ and unchanged since.
- `ComponentDummy` in `react/src/ReactBaseClasses.js`, unchanged since 2017-02-02.

```bash
npx codefossil fossils --order untouched
```

## 4. A polyfill whose reason may be gone

<!-- prettier-ignore -->
```js
function is(x: any, y: any) {
  return (
    (x === y && (x !== 0 || 1 / x === 1 / y)) || (x !== x && y !== y) // eslint-disable-line no-self-compare
  );
}
```

`packages/shared/objectIs.js` carries React's own `Object.is` polyfill, separated out on
2019-01-08 (`a9b035b`, _"Separate Object.is polyfill (#14334)"_) and unchanged since. CODEFOSSIL
flags it as a dead-intent candidate: code introduced as a polyfill and silent for seven years.
Whether React still needs it depends on the environments React supports, which the history
alone cannot tell; that is why it stays a candidate (INFERRED, 0.40), not a verdict.

```bash
npx codefossil dead-intent
```

## How sure is any of this?

- **Dates and commits** are FACT: they are read from git.
- **"Introduced in" and "changed N times"** are DERIVED: a symbol's versions are compared with the
  same file in each commit's parent, and code copied to another file with identical content is
  followed back. A symbol is identified by its name within a file, so a function that was renamed
  or rewritten while it moved is dated from its current form.
- **Fixes and dead intent** are INFERRED, as stated above.

## Try it on your own repository

```bash
cd your-repository
npx codefossil fossils
```

React's full history (21,712 commits, 88,000 file versions) indexes in about 14 minutes on a
laptop; most repositories take seconds. No account, no upload, no AI.
