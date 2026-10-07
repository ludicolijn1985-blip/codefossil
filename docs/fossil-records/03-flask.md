# Fossil Records #3: Flask — `render_template` has moved three times since the first commit

_Every number below comes from running [CODEFOSSIL](https://github.com/ludicolijn1985-blip/codefossil)
on the Flask repository at commit `d086db8` (2026-10-07): 5,562 commits by 858 authors, going back
to `33850c0` *"Initial checkin of stuff that exists so far."* on 2010-04-06. Indexing took 39
seconds. Each section ends with the command that reproduces it, and each claim says how sure it
is: FACT (observed), DERIVED (computed from facts) or INFERRED (a heuristic reading)._

## 1. A function that kept moving house

`render_template` lives in `src/flask/templating.py` today. It was not born there:

1. **2010-04-06**: it is part of the very first commit, in a single module `flask.py` (DERIVED).
2. **2010-07-02**: Justin Quick splits that module into a package with _"in with the new. i have
   the bits in places where i think they should be, now i just need to work on the import scheme
   layout"_. The function lands in `helpers.py` with identical content (DERIVED, 0.9).
3. **2010-07-04**: Armin Ronacher's _"Moved templating stuff into a separate module"_ moves it to
   `templating.py`, editing it on the way (INFERRED, 0.6: the name left `helpers.py` and arrived
   in `templating.py` in the same commit; the content changed, so this is a reading, not a fact).

It has changed 14 times since, most recently on 2025-09-20. `git blame` shows the last of these
lines; it cannot show the two moves before them.

```bash
npx codefossil why render_template
```

## 2. The 2023 split that did not erase 2010

On 2023-08-19, _"Split the App and Blueprint into Sansio and IO parts"_ (`0ec7f71`) rewrote
Flask's core into a sans-I/O `App` plus the familiar `Flask` class, touching 1,478 lines of
`app.py` alone. To most tools, `Flask.run`, `Flask.dispatch_request` and `Flask.make_response`
were born that day.

CODEFOSSIL follows them back: their content in the new `app.py` is identical to the old
definitions, so they are dated from the first commit in 2010 (DERIVED, 0.9 for the copy). The
`Flask` class itself was edited while it moved, so its link back is INFERRED (0.6).

```bash
npx codefossil fossils
```

## 3. The code that keeps getting fixed

Ranked by the commits that fixed them:

| Code                 | File                             | Fix commits | All changes |
| -------------------- | -------------------------------- | ----------: | ----------: |
| `Blueprint`          | `src/flask/sansio/blueprints.py` |          17 |          93 |
| `send_file`          | `src/flask/helpers.py`           |          10 |          68 |
| `Blueprint.register` | `src/flask/sansio/blueprints.py` |           7 |          33 |
| `FlaskClient`        | `src/flask/testing.py`           |           6 |          45 |

Nested blueprints account for many of the `Blueprint` fixes: _"Fix blueprint nested url_prefix"_
(committed 2021-05-21), _"Fix registering a blueprint twice with differing names"_ (2021-06-14),
_"Fix subdomain inheritance for nested blueprints."_ (2023-01-04). The fix counts are INFERRED from
commit wording and reverts. Fixes to type annotations and linter findings (_"fix typing"_, _"fix
pyright type errors"_) are not counted: this post is where we noticed they were, and fixed that.

```bash
npx codefossil hotspots --symbols
npx codefossil why Blueprint.register --html register.html
```

## 4. Who knows Flask today

By lines changed over each file's history, David Lord wrote a third of `src/flask/app.py`, Armin
Ronacher, Flask's creator, a fifth, and pgjones a little under a fifth. Measured back from the
latest commit, Armin Ronacher's last commit is from 2020-07-08 and pgjones's from 2024-06-07.

That gives the package a **bus factor of 1** (INFERRED): without David Lord, more than half of the
24 files with history in `src/flask` would have nobody left who wrote a substantial part of them
(the same holds for all 49 code files of the repository). No file
is "at risk" by our definition — mostly written by one person who no longer commits — because
every core file has had several large contributors.

Authorship of changes is a stand-in for knowledge, so read this as a question to ask, not an
answer.

```bash
npx codefossil owners src/flask
```

## 5. Untouched since 2012

`UnexpectedUnicodeError` in `src/flask/debughelpers.py` was added on 2012-10-30 with _"Added better
error reporting for unicode errors in sessions"_ and has not changed since (DERIVED).
`NoAppException` in `src/flask/cli.py` arrived with _"Added click support to Flask"_ on 2014-04-28
and is likewise untouched.

```bash
npx codefossil fossils --order untouched
```

## Try it on your repository

```bash
npx codefossil fossils
npx codefossil owners
npx codefossil site fossil-site   # a static website of all of the above
```

Everything runs locally; nothing leaves your machine. Corrections are welcome — open an issue with
the command and what it got wrong.
