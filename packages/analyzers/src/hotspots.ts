import {
  analysisChanges,
  analysisCommits,
  analysisFiles,
  commitDiscussions,
  commitEvidenceIds,
  fileImportEdges,
  type FossilDb,
} from '@codefossil/db';
import { isTestPath } from '@codefossil/query';
import { detectLanguage, type EvidenceLevel } from '@codefossil/shared';
import { classifyDefects } from './defects.js';
import { fileActivity } from './file-history.js';
import { importReach, REACH_DEPTH } from './reach.js';

export interface DefectCommit {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly reason: string;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

export interface Hotspot {
  readonly file: { readonly key: string; readonly id: number; readonly path: string };
  readonly isTest: boolean;
  readonly commits: number;
  readonly churn: number;
  readonly binaryChanges: number;
  readonly lastChangedAt: string | null;
  /** Defect-related commits among `commits`. */
  readonly defectCount: number;
  /** The most recent of them, with why each counts. */
  readonly defects: readonly DefectCommit[];
  /** normalized(commits) × normalized(churn) × normalized(defects + 1). */
  readonly score: number;
  readonly components: {
    readonly changeFrequency: number;
    readonly churn: number;
    readonly defects: number;
  };
  readonly risk: {
    /** changeFrequency × dependencyCentrality × bugDensity × testReachInverse. */
    readonly score: number;
    readonly components: {
      readonly changeFrequency: number;
      readonly dependencyCentrality: number;
      readonly bugDensity: number;
      readonly testReachInverse: number;
    };
    /** Files importing this one within the reach depth. */
    readonly dependents: number;
    /** Test files among them. */
    readonly testsReaching: number;
  };
  /** DERIVED when the score rests on counts alone; the weakest defect reading otherwise. */
  readonly classification: EvidenceLevel;
  readonly evidenceIds: readonly number[];
}

export type HotspotOrder = 'hotspot' | 'risk';

export interface HotspotOptions {
  /** Only count changes committed on or after this ISO date. */
  readonly since?: string;
  readonly limit?: number;
  readonly includeTests?: boolean;
  /** Include lockfiles, build output and other generated files. */
  readonly includeGenerated?: boolean;
  /** Include documentation and configuration (Markdown, JSON, YAML, TOML) and unknown file types. */
  readonly includeNonCode?: boolean;
  readonly orderBy?: HotspotOrder;
}

export interface HotspotReport {
  readonly since: string | null;
  readonly orderBy: HotspotOrder;
  /** Files at HEAD that were ranked. */
  readonly filesConsidered: number;
  readonly hotspots: readonly Hotspot[];
  /** How to read the numbers, and what they leave out. */
  readonly notes: readonly string[];
}

export const DEFAULT_HOTSPOT_LIMIT = 25;

/**
 * Files whose changes are produced by tools, not written: lockfiles, build
 * output, vendored code, minified bundles and generated snapshots. Their churn
 * says nothing about the code people maintain.
 */
const GENERATED_PATH = new RegExp(
  [
    String.raw`(^|/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock)$`,
    String.raw`(^|/)(dist|build|out|coverage|vendor|node_modules|__snapshots__)/`,
    String.raw`\.min\.(js|css)$`,
    String.raw`\.(snap|map)$`,
    String.raw`_snapshot\.json$`,
  ].join('|'),
);

export const isGeneratedPath = (path: string): boolean => GENERATED_PATH.test(path);

/** Languages that are documentation or configuration rather than code people maintain. */
const NON_CODE_LANGUAGES: ReadonlySet<string> = new Set(['markdown', 'json', 'yaml', 'toml']);

/** Examples, docs, fixtures and benchmarks illustrate code; they are not the product itself. */
const ILLUSTRATIVE_PATH =
  /(^|\/)(examples?|samples?|demos?|docs?|fixtures?|benchmarks?|__mocks__)\//i;

export const isIllustrativePath = (path: string): boolean => ILLUSTRATIVE_PATH.test(path);

/** TypeScript declaration files describe code elsewhere; they hold no behaviour of their own. */
export const isDeclarationPath = (path: string): boolean => /\.d\.[cm]?ts$/.test(path);

/** Whether a path is source code in a recognized language. */
export function isCodePath(path: string): boolean {
  const language = detectLanguage(path);
  return language !== null && !NON_CODE_LANGUAGES.has(language);
}
/** Defect commits listed per file; the count is always complete. */
const DEFECTS_SHOWN = 10;

const normalized = (value: number, max: number) => (max > 0 ? value / max : 0);
const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Rank the files at HEAD by historical change activity. Every number is
 * computed from the index; the components are reported next to each score so
 * a reader can see why a file ranks where it does.
 */
export function analyzeHotspots(
  db: FossilDb,
  repositoryId: number,
  options: HotspotOptions = {},
): HotspotReport {
  const orderBy = options.orderBy ?? 'hotspot';
  const commits = analysisCommits(db, repositoryId);
  const commitById = new Map(commits.map((c) => [c.id, c]));
  const discussions = commitDiscussions(db, repositoryId);
  const defects = classifyDefects(commits, discussions, commitEvidenceIds(db, repositoryId));

  const files = analysisFiles(db, repositoryId);
  const pathById = new Map(files.map((f) => [f.id, f.path]));
  const activity = fileActivity(files, analysisChanges(db, repositoryId), options.since).filter(
    (file) =>
      file.commitIds.size > 0 &&
      (options.includeTests || !isTestPath(file.path)) &&
      (options.includeGenerated || !isGeneratedPath(file.path)) &&
      (options.includeNonCode || isCodePath(file.path)),
  );

  const reach = importReach(
    activity.map((file) => file.fileId),
    fileImportEdges(db, repositoryId),
    (id) => isTestPath(pathById.get(id) ?? ''),
  );

  const defectCounts = activity.map(
    (file) => [...file.commitIds].filter((id) => defects.has(id)).length,
  );
  const maxCommits = Math.max(0, ...activity.map((file) => file.commitIds.size));
  const maxChurn = Math.max(0, ...activity.map((file) => file.churn));
  const maxDefects = Math.max(0, ...defectCounts);
  const maxDependents = Math.max(0, ...[...reach.values()].map((r) => r.dependents));

  const hotspots = activity.map((file, index): Hotspot => {
    const defectCommits = [...file.commitIds]
      .flatMap((id) => {
        const signal = defects.get(id);
        const commit = commitById.get(id);
        return signal && commit
          ? [
              {
                sha: commit.sha,
                subject: commit.subject,
                committedAt: commit.committedAt,
                ...signal,
              },
            ]
          : [];
      })
      .sort((a, b) => b.committedAt.localeCompare(a.committedAt));
    const defectCount = defectCounts[index] ?? 0;
    const fileReach = reach.get(file.fileId) ?? { dependents: 0, tests: 0 };
    const changeFrequency = normalized(file.commitIds.size, maxCommits);
    const components = {
      changeFrequency,
      churn: normalized(file.churn, maxChurn),
      defects: normalized(defectCount + 1, maxDefects + 1),
    };
    const risk = {
      changeFrequency,
      dependencyCentrality: normalized(fileReach.dependents, maxDependents),
      bugDensity: defectCount / file.commitIds.size,
      testReachInverse: 1 / (1 + fileReach.tests),
    };
    const levels = defectCommits.map((d) => d.level);
    return {
      file: { key: `file:${file.fileId}`, id: file.fileId, path: file.path },
      isTest: isTestPath(file.path),
      commits: file.commitIds.size,
      churn: file.churn,
      binaryChanges: file.binaryChanges,
      lastChangedAt: file.lastChangedAt,
      defectCount,
      defects: defectCommits.slice(0, DEFECTS_SHOWN),
      score: round(components.changeFrequency * components.churn * components.defects),
      components: {
        changeFrequency: round(components.changeFrequency),
        churn: round(components.churn),
        defects: round(components.defects),
      },
      risk: {
        score: round(
          risk.changeFrequency *
            risk.dependencyCentrality *
            risk.bugDensity *
            risk.testReachInverse,
        ),
        components: {
          changeFrequency: round(risk.changeFrequency),
          dependencyCentrality: round(risk.dependencyCentrality),
          bugDensity: round(risk.bugDensity),
          testReachInverse: round(risk.testReachInverse),
        },
        dependents: fileReach.dependents,
        testsReaching: fileReach.tests,
      },
      classification: levels.includes('INFERRED') ? 'INFERRED' : 'DERIVED',
      evidenceIds: [
        ...new Set(defectCommits.slice(0, DEFECTS_SHOWN).flatMap((d) => d.evidenceIds)),
      ],
    };
  });

  const key = (h: Hotspot) => (orderBy === 'risk' ? h.risk.score : h.score);
  hotspots.sort(
    (a, b) => key(b) - key(a) || b.commits - a.commits || a.file.path.localeCompare(b.file.path),
  );

  return {
    since: options.since ?? null,
    orderBy,
    filesConsidered: activity.length,
    hotspots: hotspots.slice(0, options.limit ?? DEFAULT_HOTSPOT_LIMIT),
    notes: [
      ...reportNotes(discussions.length > 0, options),
      ...(activity.length > 0 && maxDefects === 0
        ? [
            'No defect-related commit touches these files, so every risk score is 0; ordering by risk falls back to commit count.',
          ]
        : []),
    ],
  };
}

function reportNotes(hasDiscussions: boolean, options: HotspotOptions): string[] {
  return [
    'Each component is scaled to 0–1 against the highest value among the files ranked.',
    hasDiscussions
      ? 'Defect commits: resolved issues labelled as bugs (DERIVED), reverts and fix wording in commit subjects (INFERRED).'
      : 'Defect commits come from reverts and fix wording in commit subjects only (INFERRED); connect GitHub to count issues labelled as bugs.',
    `Test reach counts test files that import the file within ${REACH_DEPTH} hops; it is not line coverage.`,
    'A risk component of 0 makes the risk score 0; read the components, not only the score.',
    ...(options.includeTests
      ? []
      : ['Test files are left out; include them with the tests option.']),
    ...(options.includeNonCode
      ? []
      : [
          'Only source code is ranked; include documentation, configuration and other files with the all-files option.',
        ]),
    ...(options.includeGenerated
      ? []
      : [
          'Lockfiles, build output and generated files are left out; include them with the generated option.',
        ]),
  ];
}
