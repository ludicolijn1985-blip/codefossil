import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  analyzeDeadIntent,
  analyzeHotspots,
  DEFAULT_DEAD_INTENT_LIMIT,
  DEFAULT_HOTSPOT_LIMIT,
  DEFAULT_STALE_DAYS,
} from '@codefossil/analyzers';
import { repositoryOr404, type ApiContext } from '../context.js';

const MAX_LIMIT = 200;
const MAX_STALE_DAYS = 3650;
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const hotspotsQuery = z
  .object({
    since: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_HOTSPOT_LIMIT),
    tests: flag.default(false),
    generated: flag.default(false),
    all: flag.default(false),
    order: z.enum(['hotspot', 'risk']).default('hotspot'),
  })
  .strict();

const deadIntentQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_DEAD_INTENT_LIMIT),
    staleDays: z.coerce.number().int().min(1).max(MAX_STALE_DAYS).default(DEFAULT_STALE_DAYS),
  })
  .strict();

/** Historical hotspots, risk components and dead-intent candidates, computed from the index. */
export function analyzeRoutes(app: FastifyInstance, context: ApiContext): void {
  const db = context.fossil.db;

  app.get('/api/repositories/:id/hotspots', (request) => {
    const repository = repositoryOr404(context, request.params);
    const query = hotspotsQuery.parse(request.query);
    return {
      data: analyzeHotspots(db, repository.id, {
        ...(query.since ? { since: new Date(query.since).toISOString() } : {}),
        limit: query.limit,
        includeTests: query.tests,
        includeGenerated: query.generated,
        includeNonCode: query.all,
        orderBy: query.order,
      }),
    };
  });

  app.get('/api/repositories/:id/dead-intent', (request) => {
    const repository = repositoryOr404(context, request.params);
    const query = deadIntentQuery.parse(request.query);
    return {
      data: analyzeDeadIntent(db, repository.id, {
        limit: query.limit,
        staleDays: query.staleDays,
        ...(context.now ? { now: context.now() } : {}),
      }),
    };
  });
}
