import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { parseSSE } from '../../http/sse'
import { logger } from '../../logger'
import { resolveModel } from '../../router/resolve'
import {
  OwnllmError,
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

  let credential = await withMappedAuthErrors(() => deps.ensureCredential(route.providerId))

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

  const send = (cred: Credential) =>
    provider.transport.client().fetch(provider.transport.endpoint(ctx), {
      method: 'POST',
      headers: provider.transport.headers(cred, ctx),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

  let upstream: Response
  try {
    upstream = await send(credential)
    // Reactive retry-once on a refresh-worthy 401, strictly pre-first-byte (PLAN §5/§7). The
    // refresh is single-flight with a 10s min-interval guard, so it cannot spin or burn rotations.
    if (upstream.status === 401) {
      credential = await withMappedAuthErrors(() => deps.refreshAfterUnauthorized(route.providerId))
      upstream = await send(credential)
    }
  } catch (error) {
    clearTimeout(timeout)
    if (error instanceof OwnllmError) throw error
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

// Translates auth-layer failures into the HTTP error contract (PLAN §11).
async function withMappedAuthErrors(load: () => Promise<Credential>): Promise<Credential> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof AuthError) throw mapAuthError(error)
    throw error
  }
}

function mapAuthError(error: AuthError): OwnllmError {
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
