import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { parseSSE } from '../../http/sse'
import { logger } from '../../logger'
import type { ProviderModule } from '../../providers/types'
import type { CircuitBreaker } from '../../router/breaker'
import { type ResolvedRoute, resolveChain } from '../../router/resolve'
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
  type ChatCompletionRequest,
  ChatCompletionRequestSchema,
  type TranslateContext,
} from '../../translate/types'
import { errorMessage } from '../../util/errors'
import type { AppDeps } from '../app'
import type { AppEnv } from '../types'

interface Candidate {
  model: string
  route: ResolvedRoute
  provider: ProviderModule
}

interface ServedUpstream {
  stream: ReadableStream<Uint8Array>
  ctx: TranslateContext
  candidate: Candidate
}

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

  const candidates = orderedCandidates(deps, breaker, request.model)
  if (candidates.length === 0) throw modelNotFound(request.model)

  const conversationId = deriveConversationId(request)
  const includeUsage = request.stream_options?.include_usage ?? false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.config.server.request_timeout_ms)
  // Client disconnect aborts the upstream fetch -> stops quota burn and socket leaks (PLAN §12).
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

  // Try candidates in order until one yields a streamable upstream. Fallback is strictly
  // pre-first-byte: once we relay the stream we are committed (PLAN §10). A client disconnect or
  // timeout aborts the shared signal and ends the loop without penalizing a model's health.
  let served: ServedUpstream | undefined
  let lastError: OwnllmError | undefined
  for (const candidate of candidates) {
    if (controller.signal.aborted) break
    try {
      const result = await attemptCandidate(
        candidate,
        request,
        conversationId,
        includeUsage,
        controller,
        deps,
      )
      breaker.recordSuccess(candidate.model)
      served = { ...result, candidate }
      break
    } catch (error) {
      if (!(error instanceof OwnllmError)) {
        clearTimeout(timeout)
        throw error
      }
      lastError = error
      if (controller.signal.aborted) break
      breaker.recordFailure(candidate.model)
      logger.warn(
        { requestId, model: candidate.model, status: error.status, code: error.code },
        'candidate failed; trying next',
      )
    }
  }

  if (!served) {
    clearTimeout(timeout)
    throw lastError ?? upstreamError()
  }

  const { stream, ctx, candidate } = served
  if (candidate.model !== request.model) {
    logger.info(
      { requestId, requested: request.model, served: candidate.model },
      'served via fallback',
    )
  }
  c.header('x-ownllm-served-by', candidate.model)

  const events = parseSSE(stream)

  if (request.stream) {
    return streamSSE(c, async (sse) => {
      try {
        for await (const chunk of candidate.provider.translator.streamToChunks(events, ctx)) {
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
    return c.json(await candidate.provider.translator.fromUpstream(events, ctx))
  } finally {
    clearTimeout(timeout)
  }
}

// The ordered candidates for a request: the requested model and its direct fallbacks that resolve
// to a registered provider. Healthy models come first in declaration order; circuit-open models
// are kept as a last resort so a request still makes one real attempt under a full outage.
function orderedCandidates(deps: AppDeps, breaker: CircuitBreaker, model: string): Candidate[] {
  const healthy: Candidate[] = []
  const cooling: Candidate[] = []
  for (const { model: name, route } of resolveChain(deps.config, model)) {
    const provider = deps.getProvider(route.providerId)
    if (!provider) continue
    const bucket = breaker.shouldSkip(name) ? cooling : healthy
    bucket.push({ model: name, route, provider })
  }
  return [...healthy, ...cooling]
}

// One pre-first-byte attempt against a single candidate: translate, send (with the reactive
// 401 refresh-and-retry-once), and validate the response. Returns the SSE byte stream + context on
// success, or throws a OwnllmError that the caller treats as a fallback trigger.
async function attemptCandidate(
  candidate: Candidate,
  request: ChatCompletionRequest,
  conversationId: string,
  includeUsage: boolean,
  controller: AbortController,
  deps: AppDeps,
): Promise<{ stream: ReadableStream<Uint8Array>; ctx: TranslateContext }> {
  const { provider, route } = candidate
  let credential = await withMappedAuthErrors(() => deps.ensureCredential(route.providerId))

  const ctx: TranslateContext = {
    requestedModel: request.model,
    upstreamModel: route.upstreamModel,
    conversationId,
    includeUsage,
    reasoningEffort: route.reasoningEffort,
  }

  const translated = provider.translator.toUpstream(request, ctx)
  const body = provider.transport.sanitizeBody?.(translated, ctx, credential) ?? translated

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
    if (error instanceof OwnllmError) throw error
    throw upstreamError(`upstream request failed: ${errorMessage(error)}`)
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    throw provider.transport.classifyError(upstream.status, upstream.headers, text)
  }

  return { stream: upstream.body, ctx }
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
