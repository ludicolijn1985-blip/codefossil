import { issueReference, type StoryEvent, type SymbolStory } from '@codefossil/analyzers';

/** Repository text is untrusted: everything that reaches the page is escaped. */
const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

const day = (iso: string) => iso.slice(0, 10);
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const WIDTH = 960;
const HEIGHT = 120;
const PAD = 28;

/** A dot per event on a time axis, fixes raised and coloured, with year ticks. */
function timeline(events: readonly StoryEvent[], until: Date): string {
  const first = events[0];
  if (!first) return '';
  const start = new Date(first.committedAt).getTime();
  const end = Math.max(until.getTime(), start + 1);
  const x = (iso: string) =>
    PAD + ((new Date(iso).getTime() - start) / (end - start)) * (WIDTH - 2 * PAD);
  const ticks: string[] = [];
  for (let year = new Date(start).getUTCFullYear() + 1; ; year++) {
    const at = Date.UTC(year, 0, 1);
    if (at > end) break;
    const px = PAD + ((at - start) / (end - start)) * (WIDTH - 2 * PAD);
    ticks.push(
      `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="78" y2="84" class="tick"/>` +
        `<text x="${px.toFixed(1)}" y="100" class="year">${String(year)}</text>`,
    );
  }
  // Changes first, so the birth and the move are drawn on top of the dots near them.
  const order = { changed: 0, copied: 1, introduced: 2 } as const;
  const dots = [...events]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((e) => {
      const cls = e.kind === 'changed' ? (e.fix ? 'fix' : 'change') : e.kind;
      const y = e.fix ? 34 : 60;
      const r = e.kind === 'changed' ? 5 : 8;
      const label = `${day(e.committedAt)} ${e.sha.slice(0, 7)} ${e.subject}`;
      return `<circle cx="${x(e.committedAt).toFixed(1)}" cy="${String(y)}" r="${String(r)}" class="${cls}"><title>${escape(label)}</title></circle>`;
    });
  return (
    `<svg viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="Timeline of every change">` +
    `<line x1="${String(PAD)}" x2="${String(WIDTH - PAD)}" y1="81" y2="81" class="axis"/>` +
    ticks.join('') +
    dots.join('') +
    '</svg>'
  );
}

const KIND_LABEL: Readonly<Record<StoryEvent['kind'], string>> = {
  introduced: 'Born',
  copied: 'Moved here',
  changed: 'Changed',
};

function eventItem(e: StoryEvent): string {
  const fix = e.fix
    ? `<span class="badge fix-badge" title="${escape(e.fix.reason)}">fix · ${e.fix.level}</span>`
    : '';
  const refs = e.discussions
    .map(
      (d) =>
        `<span class="badge ref" title="${escape(d.title)}">${d.type === 'issue' ? 'issue' : 'PR'} ${escape(issueReference(d))}</span>`,
    )
    .join('');
  return (
    `<li class="event ${e.kind}${e.fix ? ' is-fix' : ''}">` +
    `<time datetime="${escape(e.committedAt)}">${day(e.committedAt)}</time>` +
    `<div><p class="what"><strong>${KIND_LABEL[e.kind]}</strong> ${escape(e.subject)}</p>` +
    `<p class="who"><code>${escape(e.sha.slice(0, 7))}</code> · ${escape(e.authorName)} ${fix}${refs}</p></div>` +
    '</li>'
  );
}

/** Styles shared by every CODEFOSSIL page: light and dark, readable on a phone. */
export const PAGE_CSS = `:root{--bg:#f6f4ef;--ink:#1d1b16;--muted:#6b665a;--line:#d9d3c4;--card:#fffdf8;--born:#2f7d5b;--copied:#3d6fb6;--change:#9a9282;--fix:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#14130f;--ink:#efeadf;--muted:#a39d8d;--line:#3a362c;--card:#1c1a15;--born:#4fbf8c;--copied:#7aa6e8;--change:#8c8576;--fix:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:48px 20px 64px}
.kicker{font:600 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font:700 clamp(32px,6vw,56px)/1.05 ui-monospace,SFMono-Regular,Consolas,monospace;margin:14px 0 8px;overflow-wrap:anywhere}
.where{color:var(--muted);margin:0 0 28px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:28px}
.stat{background:var(--card);padding:18px 20px}.stat b{display:block;font-size:34px;line-height:1.1}.stat span{color:var(--muted);font-size:14px}
.note{background:var(--card);border-left:3px solid var(--copied);padding:10px 14px;border-radius:6px}
figure{margin:0 0 32px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 12px 6px}
figcaption{color:var(--muted);font-size:13px;padding:0 10px 6px}
svg{width:100%;height:auto;display:block}.axis{stroke:var(--line);stroke-width:2}.tick{stroke:var(--muted)}.year{fill:var(--muted);font:11px ui-monospace,monospace;text-anchor:middle}
circle.introduced{fill:var(--born)}circle.copied{fill:var(--copied)}circle.change{fill:var(--change);opacity:.75}circle.fix{fill:var(--fix)}
ol{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
.event{display:grid;grid-template-columns:110px 1fr;gap:16px;padding:10px 0 10px 18px;position:relative}
.event::before{content:"";position:absolute;left:-7px;top:17px;width:12px;height:12px;border-radius:50%;background:var(--change)}
.event.introduced::before{background:var(--born)}.event.copied::before{background:var(--copied)}.event.is-fix::before{background:var(--fix)}
time{font:13px ui-monospace,monospace;color:var(--muted);padding-top:3px}.what{margin:0}.who{margin:2px 0 0;color:var(--muted);font-size:14px}
code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace}
.badge{display:inline-block;font:600 11px/1 ui-monospace,monospace;padding:4px 7px;border-radius:999px;border:1px solid var(--line);margin-left:6px}
.fix-badge{color:var(--fix);border-color:currentColor}.ref{color:var(--copied);border-color:currentColor}
footer{margin-top:40px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
@media (max-width:560px){.event{grid-template-columns:1fr;gap:2px}.stats{grid-template-columns:1fr 1fr}.stat:last-child:nth-child(odd){grid-column:1/-1}}
`;

/**
 * One self-contained HTML page with a symbol's history: no scripts, no
 * external resources, every piece of repository text escaped.
 */
export function storyHtml(
  story: SymbolStory,
  generatedAt: Date,
  /** A link back to an overview page, for pages that are part of a site. */
  back?: { readonly href: string; readonly label: string },
): string {
  const { symbol, events } = story;
  const born = events.find((e) => e.kind === 'introduced');
  const last = events.at(-1);
  const age = born
    ? Math.floor((generatedAt.getTime() - new Date(born.committedAt).getTime()) / YEAR_MS)
    : null;
  const changes = events.filter((e) => e.kind === 'changed').length;
  const stats = [
    born
      ? [age === 0 ? '<1' : String(age), `year${age === 1 ? '' : 's'} old`]
      : ['?', 'origin not in the history'],
    [String(changes), `change${changes === 1 ? '' : 's'}`],
    [String(story.fixes), `fix${story.fixes === 1 ? '' : 'es'}`],
    [String(story.authors), `author${story.authors === 1 ? '' : 's'}`],
    [String(story.callers), `caller${story.callers === 1 ? '' : 's'}`],
  ]
    .map(
      ([value = '', label = '']) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`,
    )
    .join('');
  const copied =
    story.copiedFrom.length > 0
      ? `<p class="note">Moved here from ${story.copiedFrom
          .map((c) => `<code>${escape(c.path)}</code>`)
          .join(', then from ')}; its history is followed back to where it was born.</p>`
      : '';
  const origin = story.introduction
    ? `Born ${born ? day(born.committedAt) : ''} (${story.introduction.level}, confidence ${story.introduction.confidence.toFixed(2)})`
    : 'Its origin lies before the indexed history';
  const title = `${symbol.qualifiedName} · ${story.repository.name}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
${PAGE_CSS}</style>
</head>
<body>
<main>
${back ? `<p class="back"><a href="${escape(back.href)}">← ${escape(back.label)}</a></p>` : ''}
<p class="kicker">CODEFOSSIL · ${escape(story.repository.name)}</p>
<h1>${escape(symbol.qualifiedName)}</h1>
<p class="where">${escape(symbol.kind)} in <code>${escape(symbol.path)}:${String(symbol.startLine)}</code>${symbol.current ? '' : ' (no longer at HEAD)'} · ${escape(origin)}</p>
<section class="stats" aria-label="At a glance">${stats}</section>
${copied}
<figure>${timeline(events, generatedAt)}<figcaption>Every commit that changed it${last ? `, ${day(events[0]?.committedAt ?? '')} – ${day(last.committedAt)}` : ''}. Raised orange dots are fixes.</figcaption></figure>
<ol>${[...events].reverse().map(eventItem).join('')}</ol>
<footer>
Built by <a href="https://github.com/ludicolijn1985-blip/codefossil">CODEFOSSIL</a> from this repository's own history${story.repository.headSha ? ` at <code>${escape(story.repository.headSha.slice(0, 7))}</code>` : ''} on ${day(generatedAt.toISOString())}.
Dates and commits are facts read from git; "changed" compares each version with its parent commit (DERIVED);
fixes are recognised from issue labels, reverts and commit wording, so most are inferences.
</footer>
</main>
</body>
</html>
`;
}
