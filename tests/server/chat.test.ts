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
