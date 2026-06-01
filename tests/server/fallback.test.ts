import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { UpstreamClient, UpstreamRequestInit } from '../../src/http/upstream-client'
import { createCircuitBreaker } from '../../src/router/breaker'
import type { AppDeps } from '../../src/server/app'
import type { AppEnv } from '../../src/server/types'
import { createTestApp, testConfig } from '../support/app'
import { fakeModule, sseResponse, testCredential } from '../support/fake-provider'
import { sseText } from '../support/responses'

const TEXT_SSE = sseText([
  { type: 'response.output_text.delta', delta: 'Hello world' },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
])

const FALLBACK_CONFIG = `
server:
  host: 127.0.0.1
  api_key: test-key
providers:
  openai-codex:
    enabled: true
  xai:
    enabled: true
models:
  primary:
    provider: openai-codex
    upstream: up-primary
    fallbacks: [secondary, tertiary]
  secondary:
    provider: xai
    upstream: up-secondary
  tertiary:
    provider: openai-codex
    upstream: up-tertiary
`

type Responder = (init: UpstreamRequestInit) => Promise<Response>

interface Upstream {
  calls: string[]
  set(model: string, responder: Responder): void
  fetch: UpstreamClient['fetch']
}

// A fake upstream that dispatches on the `model` the translator writes into the request body, so
// each candidate in a chain gets its own response. Records the upstream models hit, in order, so a
// test can assert which candidates were attempted (and which were skipped).
function fakeUpstream(): Upstream {
  const responders = new Map<string, Responder>()
  const calls: string[] = []
  return {
    calls,
    set(model, responder) {
      responders.set(model, responder)
    },
    fetch: (_url, init) => {
      const model = (JSON.parse(init.body ?? '{}') as { model?: string }).model ?? ''
      calls.push(model)
      const responder = responders.get(model)
      if (!responder) throw new Error(`no fake responder for upstream model '${model}'`)
      return responder(init)
    },
  }
}

function fallbackApp(up: Upstream, overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  return createTestApp({
    config: testConfig(FALLBACK_CONFIG),
    getProvider: () => fakeModule(up.fetch),
    ensureCredential: async () => testCredential,
    refreshAfterUnauthorized: async () => testCredential,
    ...overrides,
  })
}

const message = { model: 'primary', messages: [{ role: 'user', content: 'hi' }] }

async function chat(app: Hono<AppEnv>, body: unknown, init: RequestInit = {}): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

describe('fallback chain', () => {
  it('falls back to the next model and reports it via x-ownllm-served-by', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse('', 500))
    up.set('up-secondary', async () => sseResponse(TEXT_SSE))
    const res = await chat(fallbackApp(up), message)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ownllm-served-by')).toBe('secondary')
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('Hello world')
    expect(up.calls).toEqual(['up-primary', 'up-secondary'])
  })

  it('tries candidates in declaration order until one succeeds', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse('', 500))
    up.set('up-secondary', async () => sseResponse('', 503))
    up.set('up-tertiary', async () => sseResponse(TEXT_SSE))
    const res = await chat(fallbackApp(up), message)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ownllm-served-by')).toBe('tertiary')
    expect(up.calls).toEqual(['up-primary', 'up-secondary', 'up-tertiary'])
  })

  it('surfaces the last error when every candidate fails', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse('', 500))
    up.set('up-secondary', async () => sseResponse('', 500))
    up.set(
      'up-tertiary',
      async () => new Response('', { status: 429, headers: { 'retry-after': '9' } }),
    )
    const res = await chat(fallbackApp(up), message)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('9')
    expect(up.calls).toEqual(['up-primary', 'up-secondary', 'up-tertiary'])
  })

  it('reports the requested model as served-by when no fallback is needed', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse(TEXT_SSE))
    const res = await chat(fallbackApp(up), message)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ownllm-served-by')).toBe('primary')
    expect(up.calls).toEqual(['up-primary'])
  })

  it('fails over before the first byte for a streaming request', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse('', 500))
    up.set('up-secondary', async () => sseResponse(TEXT_SSE))
    const res = await chat(fallbackApp(up), { ...message, stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ownllm-served-by')).toBe('secondary')
    const text = await res.text()
    expect(text).toContain('Hello world')
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1)
  })

  it('does not try the next candidate when the client disconnects', async () => {
    const up = fakeUpstream()
    up.set(
      'up-primary',
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    up.set('up-secondary', async () => sseResponse(TEXT_SSE))
    const controller = new AbortController()
    const pending = chat(fallbackApp(up), message, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await pending.catch(() => undefined)
    expect(up.calls).toEqual(['up-primary'])
  })
})

describe('fallback circuit breaker', () => {
  it('skips a model that has tripped the breaker', async () => {
    const up = fakeUpstream()
    up.set('up-primary', async () => sseResponse('', 500))
    up.set('up-secondary', async () => sseResponse(TEXT_SSE))
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000, now: () => 0 })
    const app = fallbackApp(up, { breaker })

    const first = await chat(app, message)
    expect(first.headers.get('x-ownllm-served-by')).toBe('secondary')
    expect(up.calls).toEqual(['up-primary', 'up-secondary'])

    up.calls.length = 0
    const second = await chat(app, message)
    expect(second.status).toBe(200)
    expect(second.headers.get('x-ownllm-served-by')).toBe('secondary')
    expect(up.calls).toEqual(['up-secondary'])
  })

  it('retries a model once its cooldown elapses and closes it on success', async () => {
    const up = fakeUpstream()
    let primaryStatus = 500
    up.set('up-primary', async () =>
      sseResponse(primaryStatus === 200 ? TEXT_SSE : '', primaryStatus),
    )
    up.set('up-secondary', async () => sseResponse(TEXT_SSE))
    let now = 0
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
    const app = fallbackApp(up, { breaker })

    await chat(app, message)

    up.calls.length = 0
    now = 500
    await chat(app, message)
    expect(up.calls).toEqual(['up-secondary'])

    up.calls.length = 0
    now = 1000
    primaryStatus = 200
    const trial = await chat(app, message)
    expect(trial.headers.get('x-ownllm-served-by')).toBe('primary')
    expect(up.calls).toEqual(['up-primary'])
  })
})
