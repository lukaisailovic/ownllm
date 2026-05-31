import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import { afterEach, describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import type { AuthProvider, ProviderModule } from '../../src/providers/types'
import { upstreamError } from '../../src/translate/errors'
import { responsesTranslator } from '../../src/translate/responses'
import { createTestApp } from '../support/app'
import { INTERLEAVED_EVENTS, sseText } from '../support/responses'

const stubAuth: AuthProvider = {
  id: 'openai-codex',
  login: async () => {
    throw new Error('unused')
  },
  refresh: async () => {
    throw new Error('unused')
  },
  isExpired: () => false,
}

// Real translator + fake transport returning canned Responses SSE: exercises the full route and the
// translation pipeline end-to-end through the official SDK, with a controllable upstream.
function fakeModule(sse: string): ProviderModule {
  return {
    id: 'openai-codex',
    auth: stubAuth,
    translator: responsesTranslator,
    transport: {
      hosts: ['test.local'],
      endpoint: () => 'https://test.local/responses',
      headers: () => ({}),
      client: () => ({
        fetch: async () =>
          new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      }),
      classifyError: (status) => upstreamError(`status ${status}`),
    },
    capabilities: { stream: true, tools: true, vision: true, reasoning: true },
    listModels: async () => [],
  }
}

const credential = new Credential({
  type: 'oauth',
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
})

async function startServer(sse: string): Promise<{ baseURL: string; close: () => void }> {
  const app = createTestApp({
    getProvider: () => fakeModule(sse),
    ensureCredential: async () => credential,
  })
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ baseURL: `http://127.0.0.1:${info.port}/v1`, close: () => server.close() })
    })
  })
}

const TEXT_SSE = sseText([
  { type: 'response.output_text.delta', delta: 'Hello ' },
  { type: 'response.output_text.delta', delta: 'world' },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  },
])

let close: (() => void) | undefined
afterEach(() => close?.())

function client(baseURL: string): OpenAI {
  return new OpenAI({ apiKey: 'test-key', baseURL, maxRetries: 0 })
}

describe('chat completions via the OpenAI SDK', () => {
  it('returns a non-stream completion with usage', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    const completion = await client(server.baseURL).chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(completion.choices[0]?.message.content).toBe('Hello world')
    expect(completion.usage?.prompt_tokens).toBe(5)
  })

  it('streams chunks the SDK can consume', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    const stream = await client(server.baseURL).chat.completions.create({
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    let content = ''
    for await (const chunk of stream) content += chunk.choices[0]?.delta?.content ?? ''
    expect(content).toBe('Hello world')
  })

  it('surfaces parallel tool calls', async () => {
    const server = await startServer(sseText(INTERLEAVED_EVENTS))
    close = server.close
    const completion = await client(server.baseURL).chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'weather and time?' }],
    })
    const toolCalls = completion.choices[0]?.message.tool_calls ?? []
    expect(toolCalls.map((call) => call.function.name)).toEqual(['get_weather', 'get_time'])
  })

  it('returns 404 for an unknown model', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    await expect(
      client(server.baseURL).chat.completions.create({
        model: 'nope',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
