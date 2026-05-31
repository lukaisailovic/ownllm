import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { AuthError } from '../../src/auth/errors'
import type { UpstreamClient } from '../../src/http/upstream-client'
import type { AppDeps } from '../../src/server/app'
import type { AppEnv } from '../../src/server/types'
import { createTestApp } from '../support/app'
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

function appWith(fetch: UpstreamClient['fetch'], overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  return createTestApp({
    getProvider: () => fakeModule(fetch),
    ensureCredential: async () => testCredential,
    refreshAfterUnauthorized: async () => testCredential,
    ...overrides,
  })
}

async function chat(app: Hono<AppEnv>, body: unknown, init: RequestInit = {}): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

const message = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }

describe('reactive 401 retry-once', () => {
  it('refreshes and retries once on a 401, then succeeds', async () => {
    let calls = 0
    const app = appWith(async () => {
      calls += 1
      return calls === 1 ? sseResponse('', 401) : sseResponse(TEXT_SSE)
    })
    const res = await chat(app, message)
    expect(calls).toBe(2)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('Hello world')
  })

  it('gives up with credential_expired after a second 401', async () => {
    let calls = 0
    const app = appWith(async () => {
      calls += 1
      return sseResponse('', 401)
    })
    const res = await chat(app, message)
    expect(calls).toBe(2)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'credential_expired',
    )
  })

  it('does not retry when the min-interval guard blocks the refresh', async () => {
    let calls = 0
    const app = appWith(
      async () => {
        calls += 1
        return sseResponse('', 401)
      },
      {
        refreshAfterUnauthorized: async () => {
          throw new AuthError('refresh_too_soon', 'too soon')
        },
      },
    )
    const res = await chat(app, message)
    expect(calls).toBe(1)
    expect(res.status).toBe(401)
  })
})

describe('429 handling', () => {
  it('does not retry and passes Retry-After through', async () => {
    let calls = 0
    const app = appWith(async () => {
      calls += 1
      return new Response('', { status: 429, headers: { 'retry-after': '7' } })
    })
    const res = await chat(app, message)
    expect(calls).toBe(1)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'rate_limit_exceeded',
    )
  })
})

describe('mid-stream failure', () => {
  it('emits a finish chunk and exactly one [DONE], no error object', async () => {
    // Deliver one chunk, then error on the next pull (a synchronous enqueue+error would discard
    // the queued chunk).
    let pulls = 0
    const killStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          const event = { type: 'response.output_text.delta', delta: 'partial' }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        } else {
          controller.error(new Error('upstream died'))
        }
      },
    })
    const app = appWith(
      async () =>
        new Response(killStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )
    const res = await chat(app, { ...message, stream: true })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('partial')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1)
  })
})

describe('client disconnect', () => {
  it('aborts the upstream fetch', async () => {
    let upstreamAborted = false
    const app = appWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            upstreamAborted = true
            reject(new Error('aborted'))
          })
        }),
    )
    const controller = new AbortController()
    const pending = chat(app, message, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await pending.catch(() => undefined)
    expect(upstreamAborted).toBe(true)
  })
})
