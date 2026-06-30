import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { logger } from '../../logger'
import type { CircuitBreaker } from '../../router/breaker'
import { invalidRequestBody } from '../../translate/errors'
import { enforceParamPolicy } from '../../translate/param-policy'
import {
  type ChatCompletionChunk,
  ChatCompletionRequestSchema,
  type TranslateContext,
} from '../../translate/types'
import type { AppDeps } from '../app'
import type { AppEnv } from '../types'
import { errorMessage, serveUpstream } from './serve-upstream'

export function registerChatRoutes(
  app: { post: (path: string, handler: (c: Context<AppEnv>) => Promise<Response>) => unknown },
  deps: AppDeps,
  breaker: CircuitBreaker,
): void {
  app.post('/v1/chat/completions', (c) => handleChatCompletion(c, deps, breaker))
}

async function handleChatCompletion(
  c: Context<AppEnv>,
  deps: AppDeps,
  breaker: CircuitBreaker,
): Promise<Response> {
  const requestId = c.get('requestId')

  const raw = await c.req.json().catch(() => null)
  const parsed = ChatCompletionRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequestBody(issue?.message ?? 'invalid request body', issue?.path.join('.'))
  }
  const request = parsed.data

  const { ignored } = enforceParamPolicy(request, deps.config.server.strict_params)
  if (ignored.length > 0) logger.debug({ requestId, ignored }, 'ignoring unsupported params')

  const { events, ctx, translator, cleanup } = await serveUpstream(c, deps, breaker, request)

  if (request.stream) {
    return streamSSE(c, async (sse) => {
      try {
        for await (const chunk of translator.streamToChunks(events, ctx)) {
          await sse.writeSSE({ data: JSON.stringify(chunk) })
        }
      } catch (error) {
        // Past the first byte we cannot emit an OpenAI error object, so close cleanly: a finish
        // chunk + exactly one [DONE], no retry. (PLAN §10.)
        logger.error({ requestId, err: errorMessage(error) }, 'mid-stream upstream failure')
        await sse.writeSSE({ data: JSON.stringify(finishChunk(ctx)) })
      } finally {
        await sse.writeSSE({ data: '[DONE]' })
        cleanup()
      }
    })
  }

  try {
    return c.json(await translator.fromUpstream(events, ctx))
  } finally {
    cleanup()
  }
}

function finishChunk(ctx: TranslateContext): ChatCompletionChunk {
  return {
    id: `chatcmpl-${ctx.conversationId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: ctx.requestedModel,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
}
