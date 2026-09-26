import { basename, isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runIndex } from '@codefossil/core';
import {
  getIndexStatus,
  getProviderConnection,
  listInvestigations,
  listRepositories,
  providerCounts,
  registerRepository,
} from '@codefossil/db';
import { NotAGitRepositoryError, openGitRepository } from '@codefossil/git';
import { repositoryOr404, type ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const registerBody = z
  .object({ path: z.string().min(1).max(4096).refine(isAbsolute, 'must be an absolute path') })
  .strict();

const indexBody = z
  .object({
    since: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
    /** Also sync GitHub; only allowed when the server permits network access. */
    github: z.boolean().default(false),
  })
  .strict();

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });

/**
 * A sync may only use the connection the server was started for. API clients
 * can rewrite a connection; if they could then trigger a sync, they could send
 * the token wherever they pointed it.
 */
function assertTrustedConnection(context: ApiContext, repositoryId: number): void {
  const connection = getProviderConnection(context.fossil.db, repositoryId, 'github');
  if (!connection) {
    throw new ApiError(422, 'not_connected', 'The repository is not connected to GitHub.');
  }
  if (!context.github || connection.apiUrl !== context.github.apiUrl) {
    throw new ApiError(
      403,
      'connection_changed',
      'The GitHub connection is not the one this server was started with; restart `fossil serve --allow-network` to trust it.',
    );
  }
}

export function repositoryRoutes(app: FastifyInstance, context: ApiContext): void {
  const db = context.fossil.db;
  let indexing = false;

  app.get('/api/repositories', () => ({ data: listRepositories(db) }));

  app.post('/api/repositories', async (request, reply) => {
    const { path } = registerBody.parse(request.body);
    let git;
    try {
      git = await openGitRepository(path);
    } catch (error) {
      if (error instanceof NotAGitRepositoryError) {
        throw new ApiError(422, 'not_a_repository', 'The path is not inside a Git repository.');
      }
      throw error;
    }
    const repository = registerRepository(db, {
      path: git.root,
      name: basename(git.root),
      remoteUrl: git.remoteUrl,
      defaultBranch: git.currentBranch,
    });
    return reply.status(201).send({ data: repository });
  });

  app.get('/api/repositories/:id', (request) => {
    const repository = repositoryOr404(context, request.params);
    const connection = getProviderConnection(db, repository.id, 'github');
    return {
      data: {
        ...repository,
        status: getIndexStatus(db, repository.id),
        github: connection
          ? {
              owner: connection.owner,
              name: connection.name,
              lastSyncedAt: connection.lastSyncedAt,
              ...providerCounts(db, repository.id),
            }
          : null,
      },
    };
  });

  app.get('/api/repositories/:id/status', (request) => {
    const repository = repositoryOr404(context, request.params);
    return { data: getIndexStatus(db, repository.id) };
  });

  app.post('/api/repositories/:id/index', async (request) => {
    const repository = repositoryOr404(context, request.params);
    const body = indexBody.parse(request.body ?? {});
    if (body.github && !context.allowNetwork) {
      throw new ApiError(
        403,
        'network_disabled',
        'This server was started without network access; start it with --allow-network to sync GitHub.',
      );
    }
    if (body.github) assertTrustedConnection(context, repository.id);
    if (indexing) {
      throw new ApiError(
        409,
        'index_running',
        'An index run is in progress; try again when it finishes.',
      );
    }
    indexing = true;
    try {
      const result = await runIndex(db, repository.path, {
        ...(body.since ? { since: new Date(body.since) } : {}),
        ...(context.now ? { now: context.now } : {}),
        ...(body.github && context.github ? { github: context.github.client } : {}),
      });
      return { data: result };
    } finally {
      indexing = false;
    }
  });

  app.get('/api/repositories/:id/investigations', (request) => {
    const repository = repositoryOr404(context, request.params);
    const { limit } = listQuery.parse(request.query);
    return { data: listInvestigations(db, repository.id, limit) };
  });
}
