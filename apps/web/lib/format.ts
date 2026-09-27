import type { EvidenceLevel } from './types';

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** `2026-09-26T12:00:00.000Z` → `2026-09-26 12:00`, in UTC so output is stable. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '—');

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : pluralNoun}`;
}

/** Evidence levels are told apart by colour *and* by line style, never colour alone. */
export const LEVEL_STYLE: Readonly<
  Record<EvidenceLevel, { readonly text: string; readonly border: string; readonly dash: string }>
> = {
  FACT: { text: 'text-fact', border: 'border-fact', dash: 'none' },
  DERIVED: { text: 'text-derived', border: 'border-derived', dash: '6 4' },
  INFERRED: { text: 'text-inferred', border: 'border-inferred', dash: '2 4' },
};

export const LEVEL_EXPLANATION: Readonly<Record<EvidenceLevel, string>> = {
  FACT: 'Directly observed in a source',
  DERIVED: 'Computed deterministically from facts',
  INFERRED: 'Concluded by a heuristic; never certain',
};
