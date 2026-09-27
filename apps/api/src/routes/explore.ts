import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  allRelations,
  fileImports,
  findFileById,
  findFileByPath,
  importedBy,
  listDependencies,
  listFileSymbols,
  loadEntityRecords,
  recentCommits,
  searchFiles,
} from '@codefossil/db';
import { analyzeImpact, buildTimeline, exportGraph, investigateWhy } from '@codefossil/query';
import { repositoryOr404, targetOr4xx, TEXT, type ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

/** Beyond this many relations the whole graph is too large to send; ask for a root. */
const WHOLE_GRAPH_LIMIT = 20_000;

const timelineQuery = z.object({ path: z.string().trim().min(1).max(4096) });
const graphQuery = z.object({
  root: TEXT.optional(),
  depth: z.coerce.number().int().min(1).max(5).default(2),
});
const impactQuery = z.object({
  target: TEXT,
  depth: z.coerce.number().int().min(1).max(10).default(5),
});
const fileParams = z.object({ fileId: z.coerce.number().int().positive() });
const symbolParams = z.object({ symbolId: z.coerce.number().int().positive() });
const filesQuery = z.object({
  query: z.string().max(512).default(''),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const commitsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) });

export function exploreRoutes(app: FastifyInstance, context: ApiContext): void {
  const db = context.fossil.db;

  app.get('/api/repositories/:id/files', (request) => {
    const repository = repositoryOr404(context, request.params);
    const query = filesQuery.parse(request.query);
    return { data: searchFiles(db, repository.id, query.query.trim(), query.limit) };
  });

  app.get('/api/repositories/:id/commits', (request) => {
    const repository = repositoryOr404(context, request.params);
    const { limit } = commitsQuery.parse(request.query);
    return { data: recentCommits(db, repository.id, limit) };
  });

  app.get('/api/repositories/:id/dependencies', (request) => {
    const repository = repositoryOr404(context, request.params);
    return { data: listDependencies(db, repository.id) };
  });

  app.get('/api/repositories/:id/timeline', (request) => {
    const repository = repositoryOr404(context, request.params);
    const { path } = timelineQuery.parse(request.query);
    const file = findFileByPath(db, repository.id, path.replaceAll('\\', '/'));
    if (!file) throw new ApiError(404, 'file_not_found', `No indexed history for ${path}.`);
    return { data: buildTimeline(db, repository.id, file.id) };
  });

  app.get('/api/repositories/:id/files/:fileId', (request) => {
    const repository = repositoryOr404(context, request.params);
    const { fileId } = fileParams.parse(request.params);
    const file = findFileById(db, fileId);
    if (file?.repositoryId !== repository.id) {
      throw new ApiError(
        404,
        'file_not_found',
        `No file ${fileId} in repository ${repository.id}.`,
      );
    }
    return {
      data: {
        file,
        symbols: listFileSymbols(db, file.id),
        imports: fileImports(db, file.id),
        importedBy: importedBy(db, repository.id, file.id),
      },
    };
  });

  app.get('/api/repositories/:id/symbols/:symbolId', (request) => {
    const repository = repositoryOr404(context, request.params);
    const { symbolId } = symbolParams.parse(request.params);
    const record = loadEntityRecords(db, [{ type: 'symbol', id: symbolId }]).get(
      `symbol:${symbolId}`,
    );
    const file =
      record?.type === 'symbol' ? findFileByPath(db, repository.id, record.path) : undefined;
    if (!record || !file) {
      throw new ApiError(
        404,
        'symbol_not_found',
        `No symbol ${symbolId} in repository ${repository.id}.`,
      );
    }
    return {
      data: {
        symbol: record,
        why: investigateWhy(db, repository.id, { type: 'symbol', id: symbolId }),
      },
    };
  });

  app.get('/api/repositories/:id/graph', (request) => {
    const repository = repositoryOr404(context, request.params);
    const query = graphQuery.parse(request.query);
    const root = query.root ? targetOr4xx(context, repository.id, query.root).ref : undefined;
    if (!root && allRelations(db, repository.id).length > WHOLE_GRAPH_LIMIT) {
      throw new ApiError(
        413,
        'graph_too_large',
        'The whole graph is too large to send; pass a root.',
      );
    }
    return {
      data: exportGraph(db, repository.id, {
        repository: { name: repository.name, path: repository.path },
        ...(root ? { root, depth: query.depth } : {}),
        ...(context.now ? { now: context.now } : {}),
      }),
    };
  });

  app.get('/api/repositories/:id/impact', (request) => {
    const repository = repositoryOr404(context, request.params);
    const query = impactQuery.parse(request.query);
    const target = targetOr4xx(context, repository.id, query.target);
    return { data: analyzeImpact(db, repository.id, target.ref, { depth: query.depth }) };
  });
}
