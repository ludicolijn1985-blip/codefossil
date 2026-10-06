import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  analyzeDeadIntent,
  analyzeFixedSymbols,
  analyzeFossils,
  analyzeHotspots,
  buildSymbolStory,
  StoryContext,
  type Fossil,
} from '@codefossil/analyzers';
import { analysisCommits, getIndexStatus } from '@codefossil/db';
import { openIndexedWorkspace } from './auto-index.js';
import { CliError, type CliIO } from './io.js';
import { parsePositiveInteger } from './options.js';
import { siteHtml, type SiteRow, type SiteSection } from './site-html.js';
import { storyHtml } from './story-html.js';
import { withWorkspace, type Workspace } from './workspace.js';

const DEFAULT_SITE_LIMIT = 10;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const plural = (n: number, noun: string, many = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : many}`;

/** A file name for a symbol's page: readable, safe on every file system, unique by id. */
function pageName(path: string, name: string, id: number): string {
  const slug = `${path}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug}-${String(id)}.html`;
}

interface Pages {
  /** The page for a symbol, created on first use; null when the symbol has no story. */
  link(id: number, path: string, name: string): string | null;
  readonly files: Map<string, string>;
}

function pages(ws: Workspace, generatedAt: Date, repository: string): Pages {
  const context = new StoryContext(ws.fossil.db, ws.repositoryId);
  const files = new Map<string, string>();
  const byId = new Map<number, string | null>();
  return {
    files,
    link(id, path, name) {
      const known = byId.get(id);
      if (known !== undefined) return known;
      const story = buildSymbolStory(ws.fossil.db, ws.repositoryId, id, context);
      const file = story ? `stories/${pageName(path, name, id)}` : null;
      if (story && file) {
        files.set(
          file,
          storyHtml(story, generatedAt, { href: '../index.html', label: repository }),
        );
      }
      byId.set(id, file);
      return file;
    },
  };
}

const fossilRow = (fossil: Fossil, href: string | null, untouched: boolean): SiteRow => ({
  title: fossil.symbol.qualifiedName,
  detail: `${fossil.symbol.path}:${String(fossil.symbol.startLine)} — ${fossil.introduced.subject}`,
  meta: untouched
    ? fossil.lastChange
      ? `last changed ${fossil.lastChange.committedAt.slice(0, 10)}`
      : `unchanged since ${(fossil.copied?.commit ?? fossil.introduced).committedAt.slice(0, 10)}`
    : `born ${fossil.introduced.committedAt.slice(0, 10)}`,
  href,
});

function buildSections(ws: Workspace, limit: number, now: Date, links: Pages): SiteSection[] {
  const { db } = ws.fossil;
  const oldest = analyzeFossils(db, ws.repositoryId, { limit });
  const untouched = analyzeFossils(db, ws.repositoryId, { limit, order: 'untouched' });
  const fixed = analyzeFixedSymbols(db, ws.repositoryId, { limit });
  const hotspots = analyzeHotspots(db, ws.repositoryId, { limit });
  const deadIntent = analyzeDeadIntent(db, ws.repositoryId, { limit, now });
  const link = (id: number, path: string, name: string) => links.link(id, path, name);

  return [
    {
      id: 'oldest',
      heading: 'The oldest code still here',
      intro: `When each definition first appeared under its current name, followed back through moves. ${plural(oldest.withOrigin, 'definition')} have a dated origin.`,
      rows: oldest.fossils.map((f) =>
        fossilRow(f, link(f.symbol.id, f.symbol.path, f.symbol.qualifiedName), false),
      ),
      command: 'codefossil fossils',
    },
    {
      id: 'untouched',
      heading: 'Untouched the longest',
      intro: `${plural(untouched.unchanged, 'definition has', 'definitions have')} never changed since they were written.`,
      rows: untouched.fossils.map((f) =>
        fossilRow(f, link(f.symbol.id, f.symbol.path, f.symbol.qualifiedName), true),
      ),
      command: 'codefossil fossils --order untouched',
    },
    {
      id: 'fixed',
      heading: 'Fixed most often',
      intro:
        'Functions ranked by the commits that fixed them. Fixes are recognised from wording, reverts and bug labels, so most are inferences.',
      rows: fixed.symbols.map((s) => ({
        title: s.symbol.qualifiedName,
        detail: `${s.symbol.path}:${String(s.symbol.startLine)} — latest: ${s.fixes[0]?.subject ?? ''}`,
        meta: `${plural(s.fixes.length, 'fix', 'fixes')} · ${plural(s.priorChanges, 'change')}`,
        href: link(s.symbol.id, s.symbol.path, s.symbol.qualifiedName),
        tone: 'fix' as const,
      })),
      command: 'codefossil hotspots --symbols',
    },
    {
      id: 'hotspots',
      heading: 'Where history concentrates',
      intro: 'Files ranked by change frequency × churn × fix commits.',
      rows: hotspots.hotspots.map((h) => ({
        title: h.file.path,
        detail: `${plural(h.commits, 'commit')}, ${String(h.churn)} lines changed, ${plural(h.defectCount, 'fix commit')}`,
        meta: `hotspot ${h.score.toFixed(2)}`,
        href: null,
      })),
      command: 'codefossil hotspots',
    },
    {
      id: 'dead-intent',
      heading: 'Workarounds whose reason may be gone',
      intro:
        'Code changed by commits about compatibility, deprecation or workarounds, and silent since. Candidates to look at, never verdicts (INFERRED).',
      rows: deadIntent.candidates.map((c) => {
        const id = c.target.kind === 'symbol' ? Number(c.target.key.split(':')[1]) : NaN;
        return {
          title: c.target.label,
          detail: c.signals[0]?.text ?? '',
          meta: `confidence ${c.confidence.toFixed(2)}`,
          href: Number.isSafeInteger(id) ? link(id, c.target.path, c.target.label) : null,
          tone: 'inferred' as const,
        };
      }),
      command: 'codefossil dead-intent',
    },
  ];
}

function repositoryStats(ws: Workspace, now: Date): (readonly [string, string])[] {
  const commits = analysisCommits(ws.fossil.db, ws.repositoryId);
  const first = commits.reduce<string | null>(
    (oldest, c) => (oldest === null || c.committedAt < oldest ? c.committedAt : oldest),
    null,
  );
  const years = first ? Math.floor((now.getTime() - new Date(first).getTime()) / YEAR_MS) : 0;
  const status = getIndexStatus(ws.fossil.db, ws.repositoryId);
  return [
    [commits.length.toLocaleString('en-US'), 'commits'],
    [new Set(commits.map((c) => c.authorName)).size.toLocaleString('en-US'), 'authors'],
    [
      first ? String(years) : '?',
      `years of history${first ? ` (since ${first.slice(0, 4)})` : ''}`,
    ],
    [(status?.counts.currentSymbols ?? 0).toLocaleString('en-US'), 'definitions today'],
  ];
}

export function registerSiteCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('site')
    .description(
      "Write a static website about the repository's history: the oldest code, code untouched " +
        'the longest, what is fixed most often, hotspots and dead intent, with a page per function.',
    )
    .argument('<dir>', 'directory to write the site into (created if missing)')
    .option('--limit <n>', 'entries per list', String(DEFAULT_SITE_LIMIT))
    .option('--name <name>', 'name shown for the repository (default: its directory name)')
    .action(async (dir: string, options: { readonly limit: string; readonly name?: string }) => {
      const limit = parsePositiveInteger(options.limit, '--limit');
      await withWorkspace(openIndexedWorkspace(repoPath(), io), async (ws) => {
        const now = io.now?.() ?? new Date();
        const status = getIndexStatus(ws.fossil.db, ws.repositoryId);
        if (!status) throw new CliError('The repository is not indexed.');
        const repository = options.name ?? status.repository.name;
        const links = pages(ws, now, repository);
        const sections = buildSections(ws, limit, now, links);
        const out = resolve(io.cwd, dir);
        await mkdir(join(out, 'stories'), { recursive: true });
        await writeFile(
          join(out, 'index.html'),
          siteHtml(
            {
              repository,
              headSha: status.latestCommit?.sha ?? null,
              stats: repositoryStats(ws, now),
              sections,
            },
            now,
          ),
          'utf8',
        );
        for (const [file, html] of links.files) await writeFile(join(out, file), html, 'utf8');
        io.stderr(`Wrote ${join(out, 'index.html')} and ${plural(links.files.size, 'page')}.\n`);
      });
    });
}
