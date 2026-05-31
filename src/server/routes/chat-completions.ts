import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { AuthError } from '../../auth/errors'
import { parseSSE } from '../../http/sse'
import { logger } from '../../logger'
import { resolveModel } from '../../router/resolve'
import {
  type LlmgateError,
  credentialExpired,
  invalidRequestBody,
  modelNotFound,
  rateLimited,
  upstreamError,
  xaiTierDenied,
} from '../../translate/errors'
import { enforceParamPolicy } from '../../translate/param-policy'
import { deriveConversationId } from '../../translate/responses'
import {
  type ChatCompletionChunk,
  ChatCompletionRequestSchema,
  type TranslateContext,
} from '../../translate/types'
import type { AppDeps } from '../app'
import type { AppEnv } from '../types'

export function registerChatRoutes(
  app: { post: (path: string, handler: (c: Context<AppEnv>) => Promise<Response>) => unknown },
  deps: AppDeps,
): void {
  app.post('/v1/chat/completions', (c) => handleChatCompletion(c, deps))
}

async function handleChatCompletion(c: Context<AppEnv>, deps: AppDeps): Promise<Response> {
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

  const route = resolveModel(deps.config, request.model)
  const provider = route && deps.getProvider(route.providerId)
  if (!route || !provider) throw modelNotFound(request.model)

  const credential = await ensureCredential(deps, route.providerId)

  const ctx: TranslateContext = {
    requestedModel: request.model,
    upstreamModel: route.upstreamModel,
    conversationId: deriveConversationId(request),
    includeUsage: request.stream_options?.include_usage ?? false,
    reasoningEffort: route.reasoningEffort,
  }

  const translated = provider.translator.toUpstream(request, ctx)
  const body = provider.transport.sanitizeBody?.(translated, ctx) ?? translated

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.config.server.request_timeout_ms)
  // Client disconnect aborts the upstream fetch -> stops quota burn and socket leaks (PLAN §12).
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

  let upstream: Response
  try {
    upstream = await provider.transport.client().fetch(provider.transport.endpoint(ctx), {
      method: 'POST',
      headers: provider.transport.headers(credential, ctx),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    throw upstreamError(`upstream request failed: ${errorMessage(error)}`)
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeout)
    const text = await upstream.text().catch(() => '')
    throw provider.transport.classifyError(upstream.status, upstream.headers, text)
  }

  const events = parseSSE(upstream.body)

  if (request.stream) {
    return streamSSE(c, async (sse) => {
      try {
        for await (const chunk of provider.translator.streamToChunks(events, ctx)) {
          await sse.writeSSE({ data: JSON.stringify(chunk) })
        }
      } catch (error) {
        // Past the first byte we cannot emit an OpenAI error object, so close cleanly: a finish
        // chunk + exactly one [DONE], no retry. (PLAN §10.)
        logger.error({ requestId, err: errorMessage(error) }, 'mid-stream upstream failure')
        await sse.writeSSE({ data: JSON.stringify(finishChunk(ctx)) })
      } finally {
        await sse.writeSSE({ data: '[DONE]' })
        clearTimeout(timeout)
      }
    })
  }

  try {
    return c.json(await provider.translator.fromUpstream(events, ctx))
  } finally {
    clearTimeout(timeout)
  }
}

async function ensureCredential(deps: AppDeps, providerId: string) {
  try {
    return await deps.ensureCredential(providerId)
  } catch (error) {
    if (error instanceof AuthError) throw mapAuthError(error)
    throw error
  }
}

function mapAuthError(error: AuthError): LlmgateError {
  if (error.code === 'tier_denied') return xaiTierDenied()
  if (error.code === 'rate_limited') return rateLimited()
  return credentialExpired()
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
