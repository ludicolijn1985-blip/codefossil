import { PAGE_CSS } from './story-html.js';

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** One row of a list on the overview page; `href` links to the symbol's own page. */
export interface SiteRow {
  readonly title: string;
  readonly detail: string;
  readonly meta: string;
  readonly href: string | null;
  /** Marks the row as a fix-heavy or inferred finding. */
  readonly tone?: 'fix' | 'inferred';
}

export interface SiteSection {
  readonly id: string;
  readonly heading: string;
  readonly intro: string;
  readonly rows: readonly SiteRow[];
  readonly command: string;
}

export interface SiteOverview {
  readonly repository: string;
  readonly headSha: string | null;
  readonly stats: readonly (readonly [value: string, label: string])[];
  readonly sections: readonly SiteSection[];
}

const SITE_CSS = `
.back a,a.row{color:inherit}
.row .title{color:var(--ink)}
section.block{margin:40px 0}
section.block h2{font:700 24px/1.2 ui-sans-serif,system-ui,sans-serif;margin:0 0 6px}
section.block .intro{color:var(--muted);margin:0 0 14px}
.rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}
.rows li+li{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:12px 16px;text-decoration:none}
a.row:hover{background:var(--bg)}
.row .title{font:600 15px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.row .meta{color:var(--muted);font:13px ui-monospace,monospace;text-align:right;white-space:nowrap}
.row .detail{grid-column:1/-1;color:var(--muted);font-size:14px}
.row.fix .meta{color:var(--fix)}
.cmd{margin:8px 0 0;color:var(--muted);font-size:13px}
@media (max-width:560px){.row{grid-template-columns:1fr}.row .meta{text-align:left}}
`;

function row(r: SiteRow): string {
  const tone = r.tone ? ` ${r.tone}` : '';
  const inner =
    `<span class="title">${escape(r.title)}</span><span class="meta">${escape(r.meta)}</span>` +
    `<span class="detail">${escape(r.detail)}</span>`;
  return r.href
    ? `<li><a class="row${tone}" href="${escape(r.href)}">${inner}</a></li>`
    : `<li><div class="row${tone}">${inner}</div></li>`;
}

/** The overview page of a fossil site: every list links to the pages of the code it names. */
export function siteHtml(site: SiteOverview, generatedAt: Date): string {
  const stats = site.stats
    .map(
      ([value, label]) =>
        `<div class="stat"><b>${escape(value)}</b><span>${escape(label)}</span></div>`,
    )
    .join('');
  const sections = site.sections
    .filter((section) => section.rows.length > 0)
    .map(
      (section) =>
        `<section class="block" id="${escape(section.id)}"><h2>${escape(section.heading)}</h2>` +
        `<p class="intro">${escape(section.intro)}</p><ul class="rows">${section.rows.map(row).join('')}</ul>` +
        `<p class="cmd"><code>${escape(section.command)}</code></p></section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(site.repository)} · CODEFOSSIL</title>
<style>
${PAGE_CSS}${SITE_CSS}</style>
</head>
<body>
<main>
<p class="kicker">CODEFOSSIL · fossil record</p>
<h1>${escape(site.repository)}</h1>
<p class="where">What this repository's own history says about its code${site.headSha ? `, at <code>${escape(site.headSha.slice(0, 7))}</code>` : ''}.</p>
<section class="stats" aria-label="At a glance">${stats}</section>
${sections}
<footer>
Built by <a href="https://github.com/ludicolijn1985-blip/codefossil">CODEFOSSIL</a> on ${generatedAt.toISOString().slice(0, 10)}.
Dates and commits are facts read from git; "changed" compares each version with its parent commit (DERIVED);
fixes and dead intent are recognised from issue labels, reverts and commit wording, so most are inferences.
</footer>
</main>
</body>
</html>
`;
}
