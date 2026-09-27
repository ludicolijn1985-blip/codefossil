import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiProviderError, askWithEvidence, summarizeWhy } from '@codefossil/ai';
import { investigateWhy } from '@codefossil/query';
import { repositoryOr404, targetOr4xx, TEXT, type ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

/** Model calls are slow and may cost money; each client gets few of them. */
const AI_REQUESTS_PER_MINUTE = 10;

const askBody = z.object({ question: TEXT }).strict();
const summarizeBody = z.object({ target: TEXT }).strict();

function aiOr409(context: ApiContext): NonNullable<ApiContext['ai']> {
  if (!context.ai) {
    throw new ApiError(
      409,
      'ai_disabled',
      'The AI layer is off for this server. Configure it with `fossil ai configure` and restart ' +
        '`fossil serve` (a cloud provider also needs --allow-network).',
    );
  }
  return context.ai;
}

async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AiProviderError)
      throw new ApiError(502, 'ai_provider_error', error.message);
    throw error;
  }
}

/** The optional AI layer: answers held to evidence gathered deterministically. */
export function aiRoutes(app: FastifyInstance, context: ApiContext): void {
  const db = context.fossil.db;
  const limited = {
    config: { rateLimit: { max: AI_REQUESTS_PER_MINUTE, timeWindow: '1 minute' } },
  };

  app.get('/api/ai', () => ({
    data: context.ai
      ? {
          enabled: true,
          provider: context.ai.config.provider,
          model: context.ai.config.model,
          cloud: context.ai.provider.cloud,
          includeSource: context.ai.config.includeSource,
        }
      : { enabled: false },
  }));

  app.post('/api/repositories/:id/ask', limited, async (request) => {
    const repository = repositoryOr404(context, request.params);
    const { question } = askBody.parse(request.body);
    const ai = aiOr409(context);
    const answer = await run(() =>
      askWithEvidence(ai.provider, db, repository.id, question, {
        includeSource: ai.config.includeSource,
      }),
    );
    if (!answer) {
      throw new ApiError(
        404,
        'no_related_evidence',
        'Nothing in the index relates to this question, so the model was not asked.',
      );
    }
    return { data: answer };
  });

  app.post('/api/repositories/:id/summarize', limited, async (request) => {
    const repository = repositoryOr404(context, request.params);
    const { target } = summarizeBody.parse(request.body);
    const ai = aiOr409(context);
    const match = targetOr4xx(context, repository.id, target);
    const why = investigateWhy(db, repository.id, match.ref);
    const summary = await run(() =>
      summarizeWhy(ai.provider, why, { includeSource: ai.config.includeSource }),
    );
    return { data: { why, summary } };
  });
}
