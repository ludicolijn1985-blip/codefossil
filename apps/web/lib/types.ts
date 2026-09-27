/**
 * Response types of the CODEFOSSIL API, taken from the packages that produce
 * them so the UI can never drift from the server's shapes. Type-only: nothing
 * from these packages runs in the browser.
 */
import type {
  EntityRecord,
  FileRow,
  FileSymbol,
  ImportingFile,
  ImportRow,
  IndexStatus,
  RepositoryRow,
} from '@codefossil/db';
import type { WhyInvestigation } from '@codefossil/query';

export type {
  DependencyUsage,
  EntityRecord,
  FileRow,
  FileSymbol,
  ImportingFile,
  ImportRow,
  IndexStatus,
  InvestigationRow,
  RepositoryRow,
} from '@codefossil/db';
export type {
  GraphDocument,
  ImpactReport,
  Statement,
  Timeline,
  TimelineEntry,
  WhyInvestigation,
} from '@codefossil/query';
export type {
  DeadIntentCandidate,
  DeadIntentReport,
  DeadIntentSignal,
  Hotspot,
  HotspotReport,
} from '@codefossil/analyzers';
export type { EvidenceLevel } from '@codefossil/shared';

export interface ApiEnvelope<T> {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
}

export interface FileListItem {
  readonly id: number;
  readonly path: string;
  readonly language: string | null;
  readonly deletedAt: string | null;
}

export interface CommitListItem {
  readonly id: number;
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly committedAt: string;
}

export interface RepositoryDetail extends RepositoryRow {
  readonly status: IndexStatus;
  readonly github: {
    readonly owner: string;
    readonly name: string;
    readonly lastSyncedAt: string | null;
    readonly issues: number;
    readonly pullRequests: number;
  } | null;
}

export interface FileDetail {
  readonly file: FileRow;
  readonly symbols: readonly FileSymbol[];
  readonly imports: readonly ImportRow[];
  readonly importedBy: readonly ImportingFile[];
}

export interface SymbolDetail {
  readonly symbol: Extract<EntityRecord, { type: 'symbol' }>;
  readonly why: WhyInvestigation;
}

export type { AiAnswer } from '@codefossil/ai';

export type AiStatus =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly provider: string;
      readonly model: string;
      readonly cloud: boolean;
      readonly includeSource: boolean;
    };
