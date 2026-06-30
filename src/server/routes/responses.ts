import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { logger } from '../../logger'
import type { CircuitBreaker } from '../../router/breaker'
import { enforceParamPolicy } from '../../translate/param-policy'
import { responsesRequestToCompletion } from '../../translate/responses/from-client'
import {
  completionToResponse,
  streamCompletionToResponses,
} from '../../translate/responses/to-client'
import type { AppDeps } from '../app'
import type { AppEnv } from '../types'
import { errorMessage, serveUpstream } from './serve-upstream'

export function registerResponsesRoutes(
  app: { post: (path: string, handler: (c: Context<AppEnv>) => Promise<Response>) => unknown },
  deps: AppDeps,
  breaker: CircuitBreaker,
): void {
  app.post('/v1/responses', (c) => handleResponses(c, deps, breaker))
}

async function handleResponses(
  c: Context<AppEnv>,
  deps: AppDeps,
  breaker: CircuitBreaker,
): Promise<Response> {
  const requestId = c.get('requestId')

  const raw = await c.req.json().catch(() => null)
  const request = responsesRequestToCompletion(raw)

  const { ignored } = enforceParamPolicy(request, deps.config.server.strict_params)
  if (ignored.length > 0) logger.debug({ requestId, ignored }, 'ignoring unsupported params')

  const { events, ctx, translator, cleanup } = await serveUpstream(c, deps, breaker, request)

  if (request.stream) {
    return streamSSE(c, async (sse) => {
      try {
        const chunks = translator.streamToChunks(events, ctx)
        for await (const frame of streamCompletionToResponses(chunks, ctx)) {
          await sse.writeSSE(frame)
        }
      } catch (error) {
        // streamCompletionToResponses already emits a terminal response.completed even on a
        // mid-stream upstream failure; this guard only logs anything that escapes it (PLAN §10).
        logger.error({ requestId, err: errorMessage(error) }, 'mid-stream upstream failure')
      } finally {
        cleanup()
      }
    })
  }

  try {
    const completion = await translator.fromUpstream(events, ctx)
    return c.json(completionToResponse(completion, ctx))
  } finally {
    cleanup()
  }
}
