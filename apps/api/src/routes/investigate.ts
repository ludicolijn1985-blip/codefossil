import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectProvider } from '@codefossil/db';
import { GitHubApiError, validateApiUrl, defaultApiUrl } from '@codefossil/providers';
import {
  analyzeImpact,
  buildTimeline,
  investigateWhy,
  recordInvestigation,
  resolveQuestion,
  SUPPORTED_QUESTIONS,
  type QuestionKind,
  type TargetMatch,
} from '@codefossil/query';
import { repositoryOr404, targetOr4xx, TEXT, type ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const investigateBody = z.union([
  z.object({ question: TEXT, save: z.boolean().default(true) }).strict(),
  z
    .object({ target: TEXT, kind: z.enum(['why', 'impact']), save: z.boolean().default(true) })
    .strict(),
]);

const queryBody = z.object({ question: TEXT, save: z.boolean().default(true) }).strict();

const SLUG = /^[A-Za-z0-9_.-]+$/;
const connectBody = z
  .object({
    owner: z.string().regex(SLUG).max(100),
    name: z.string().regex(SLUG).max(100),
    apiUrl: z.url().optional(),
  })
  .strict();

export function investigateRoutes(app: FastifyInstance, context: ApiContext): void {
  const db = context.fossil.db;

  const run = (
    repositoryId: number,
    kind: QuestionKind,
    match: TargetMatch,
    save: boolean,
    question?: string,
  ) => {
    if (kind === 'timeline') {
      if (match.ref.type !== 'file') {
        throw new ApiError(
          422,
          'not_a_file',
          `A timeline is built for a file; "${match.label}" is a ${match.ref.type}.`,
        );
      }
      return { kind, result: buildTimeline(db, repositoryId, match.ref.id), investigationId: null };
    }
    const result =
      kind === 'why'
        ? investigateWhy(db, repositoryId, match.ref, question)
        : analyzeImpact(db, repositoryId, match.ref, question ? { question } : {});
    const investigationId = save ? recordInvestigation(db, repositoryId, result) : null;
    return { kind, result, investigationId };
  };

  const ask = (repositoryId: number, question: string, save: boolean) => {
    const resolution = resolveQuestion(db, repositoryId, question);
    switch (resolution.status) {
      case 'unsupported':
        throw new ApiError(422, 'unsupported_question', SUPPORTED_QUESTIONS);
      case 'ambiguous':
        throw new ApiError(
          409,
          'ambiguous_target',
          `"${resolution.word}" matches ${resolution.matches.length} entities.`,
          {
            candidates: resolution.matches.map((m) => ({ label: m.label, how: m.how })),
          },
        );
      case 'not_found':
        throw new ApiError(
          404,
          'target_not_found',
          'The question names nothing found in the index.',
          {
            tried: resolution.tried,
          },
        );
      case 'ok':
        return run(repositoryId, resolution.kind, resolution.match, save, question);
    }
  };

  app.post('/api/repositories/:id/investigate', (request) => {
    const repository = repositoryOr404(context, request.params);
    const body = investigateBody.parse(request.body);
    if ('question' in body) return { data: ask(repository.id, body.question, body.save) };
    const match = targetOr4xx(context, repository.id, body.target);
    return { data: run(repository.id, body.kind, match, body.save) };
  });

  app.post('/api/repositories/:id/query', (request) => {
    const repository = repositoryOr404(context, request.params);
    const body = queryBody.parse(request.body);
    return { data: ask(repository.id, body.question, body.save) };
  });

  /**
   * Store where to sync GitHub from. No token is involved or stored, and
   * nothing is contacted: access is checked on the next sync.
   */
  app.post('/api/repositories/:id/providers/github/connect', (request, reply) => {
    const repository = repositoryOr404(context, request.params);
    const body = connectBody.parse(request.body);
    const apiUrl = body.apiUrl ?? defaultApiUrl('github.com');
    try {
      validateApiUrl(apiUrl);
    } catch (error) {
      if (error instanceof GitHubApiError)
        throw new ApiError(400, 'invalid_api_url', error.message);
      throw error;
    }
    const connection = connectProvider(db, {
      repositoryId: repository.id,
      provider: 'github',
      owner: body.owner,
      name: body.name,
      apiUrl,
    });
    return reply.status(201).send({
      data: {
        owner: connection.owner,
        name: connection.name,
        apiUrl: connection.apiUrl,
        verified: false,
      },
    });
  });
}
