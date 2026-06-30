import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../support/app'
import { fakeModule, sseResponse, testCredential } from '../support/fake-provider'
import { INTERLEAVED_EVENTS, sseText } from '../support/responses'

async function startServer(sse: string): Promise<{ baseURL: string; close: () => void }> {
  const app = createTestApp({
    getProvider: () => fakeModule(async () => sseResponse(sse)),
    ensureCredential: async () => testCredential,
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
  // Use the platform-native fetch (undici). The SDK's bundled node-fetch@2 raises a false-positive
  // "Premature close" on a well-formed chunked SSE stream under Node >=22.23; undici (what real
  // Node 18+ clients use) does not.
  return new OpenAI({ apiKey: 'test-key', baseURL, maxRetries: 0, fetch: globalThis.fetch })
}

describe('responses via the OpenAI SDK', () => {
  it('returns a non-stream response with usage', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    const response = await client(server.baseURL).responses.create({
      model: 'gpt-5',
      input: 'hi',
    })
    expect(response.output_text).toBe('Hello world')
    expect(response.usage?.input_tokens).toBe(5)
    expect(response.status).toBe('completed')
  })

  it('streams typed events the SDK can consume', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    const stream = await client(server.baseURL).responses.create({
      model: 'gpt-5',
      input: 'hi',
      stream: true,
    })
    let text = ''
    let completed = false
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta
      if (event.type === 'response.completed') completed = true
    }
    expect(text).toBe('Hello world')
    expect(completed).toBe(true)
  })

  it('surfaces parallel function calls in output', async () => {
    const server = await startServer(sseText(INTERLEAVED_EVENTS))
    close = server.close
    const response = await client(server.baseURL).responses.create({
      model: 'gpt-5',
      input: 'weather and time?',
    })
    const calls = response.output.filter((item) => item.type === 'function_call')
    expect(calls.map((call) => call.name)).toEqual(['get_weather', 'get_time'])
  })

  it('accepts structured input items and instructions', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    const response = await client(server.baseURL).responses.create({
      model: 'gpt-5',
      instructions: 'be terse',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    })
    expect(response.output_text).toBe('Hello world')
  })

  it('returns 404 for an unknown model', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    await expect(
      client(server.baseURL).responses.create({ model: 'nope', input: 'hi' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('rejects stateful previous_response_id (stateless gateway)', async () => {
    const server = await startServer(TEXT_SSE)
    close = server.close
    await expect(
      client(server.baseURL).responses.create({
        model: 'gpt-5',
        input: 'hi',
        previous_response_id: 'resp_123',
      }),
    ).rejects.toMatchObject({ status: 400 })
  })
})
