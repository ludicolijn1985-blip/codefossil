import { z } from 'zod';
import type { AiConfig, AiProvider } from '@codefossil/ai';
import {
  entityKey,
  findRepositoryById,
  type FossilDatabase,
  type ProviderConnectionRow,
  type RepositoryRow,
} from '@codefossil/db';
import type { GitHubClient } from '@codefossil/providers';
import { resolveTarget, type TargetMatch } from '@codefossil/query';
import { ApiError } from './errors.js';

export interface ApiContext {
  readonly fossil: FossilDatabase;
  /**
   * Whether requests may make CODEFOSSIL contact the network (GitHub sync).
   * Off unless the server was started with it explicitly.
   */
  readonly allowNetwork: boolean;
  /**
   * GitHub access granted when the server started: the API URL the token was
   * resolved for, and a client factory that serves only that URL. Only used
   * when network access is allowed.
   */
  readonly github?: {
    readonly apiUrl: string;
    readonly client: (connection: ProviderConnectionRow) => GitHubClient | null;
  };
  /**
   * The optional AI layer as configured when the server started. Absent when
   * it is off — or when it is a cloud provider and network access was not
   * allowed.
   */
  readonly ai?: {
    readonly config: AiConfig;
    readonly provider: AiProvider;
  };
  readonly now?: () => Date;
}

/** `:id` in repository routes. */
export const repositoryParams = z.object({ id: z.coerce.number().int().positive() });

/** The size limit for free-text inputs (targets, questions). */
export const TEXT = z.string().trim().min(1).max(1000);

export function repositoryOr404(context: ApiContext, params: unknown): RepositoryRow {
  const { id } = repositoryParams.parse(params);
  const repository = findRepositoryById(context.fossil.db, id);
  if (!repository) throw new ApiError(404, 'not_found', `No repository ${id}.`);
  return repository;
}

/** Resolve a target to exactly one entity, or explain why not. */
export function targetOr4xx(context: ApiContext, repositoryId: number, input: string): TargetMatch {
  const matches = resolveTarget(context.fossil.db, repositoryId, input);
  const [only] = matches;
  if (!only)
    throw new ApiError(404, 'target_not_found', `Nothing in the index matches "${input}".`);
  if (matches.length > 1) {
    throw new ApiError(409, 'ambiguous_target', `"${input}" matches ${matches.length} entities.`, {
      candidates: matches.map((m) => ({ key: entityKey(m.ref), label: m.label, how: m.how })),
    });
  }
  return only;
}
