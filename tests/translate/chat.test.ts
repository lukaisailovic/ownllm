import { describe, expect, it } from 'vitest'
import { buildChatRequest } from '../../src/translate/chat/request'
import { chatToCompletion } from '../../src/translate/chat/response'
import { chatToChunks } from '../../src/translate/chat/stream'
import type { ChatCompletionChunk, ChatCompletionRequest } from '../../src/translate/types'
import { ctx, eventStream } from '../support/responses'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

describe('buildChatRequest', () => {
  it('swaps the upstream model, forces streaming, and asks for usage', () => {
    const body = buildChatRequest(request(), ctx({ upstreamModel: 'gpt-4.1-2025' }))
    expect(body.model).toBe('gpt-4.1-2025')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('folds the developer role down to system', () => {
    const body = buildChatRequest(
      request({
        messages: [
          { role: 'developer', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      }),
      ctx(),
    )
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('prefers max_completion_tokens over max_tokens and carries supported params', () => {
    const body = buildChatRequest(
      request({ max_tokens: 100, max_completion_tokens: 200, temperature: 0.5, top_p: 0.9 }),
      ctx(),
    )
    expect(body.max_tokens).toBe(200)
    expect(body.temperature).toBe(0.5)
    expect(body.top_p).toBe(0.9)
  })

  it('takes reasoning_effort from the request, else the route default', () => {
    expect(buildChatRequest(request({ reasoning_effort: 'high' }), ctx()).reasoning_effort).toBe(
      'high',
    )
    expect(buildChatRequest(request(), ctx({ reasoningEffort: 'low' })).reasoning_effort).toBe(
      'low',
    )
    expect(buildChatRequest(request(), ctx()).reasoning_effort).toBeUndefined()
  })

  it('does not forward param-policy ignored params', () => {
    const body = buildChatRequest(
      request({
        presence_penalty: 1,
        frequency_penalty: 1,
        seed: 7,
      } as Partial<ChatCompletionRequest>),
      ctx(),
    )
    expect(body.presence_penalty).toBeUndefined()
    expect(body.frequency_penalty).toBeUndefined()
    expect(body.seed).toBeUndefined()
  })

  it('passes tools and tool_choice through unchanged', () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }]
    const body = buildChatRequest(
      request({ tools, tool_choice: { type: 'function', function: { name: 'f' } } }),
      ctx(),
    )
    expect(body.tools).toBe(tools)
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'f' } })
  })
})

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('chatToChunks', () => {
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
  ]

  it('relays choice chunks re-stamped with the requested model', async () => {
    const chunks = await collect(
      chatToChunks(eventStream(events), ctx({ requestedModel: 'copilot-gpt' })),
    )
    expect(chunks.every((c) => c.model === 'copilot-gpt')).toBe(true)
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(['Hello'])
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1)
  })

  it('emits a trailing usage chunk only when include_usage is set', async () => {
    const withUsage = await collect(chatToChunks(eventStream(events), ctx({ includeUsage: true })))
    expect(withUsage.at(-1)?.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
    })
    expect(withUsage.at(-1)?.choices).toEqual([])

    const withoutUsage = await collect(
      chatToChunks(eventStream(events), ctx({ includeUsage: false })),
    )
    expect(withoutUsage.some((c) => c.usage)).toBe(false)
  })

  it('ignores the [DONE] sentinel', async () => {
    const chunks = await collect(
      chatToChunks(
        (async function* () {
          yield { data: '[DONE]' }
        })(),
        ctx(),
      ),
    )
    expect(chunks).toEqual([])
  })
})

describe('chatToCompletion', () => {
  it('concatenates content deltas and carries usage + finish_reason', async () => {
    const response = await chatToCompletion(
      eventStream([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
        { choices: [{ index: 0, delta: { content: 'lo' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]),
      ctx({ requestedModel: 'qwen3' }),
    )
    expect(response.model).toBe('qwen3')
    expect(response.choices[0]?.message.content).toBe('Hello')
    expect(response.choices[0]?.finish_reason).toBe('stop')
    expect(response.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
  })

  it('stitches streamed tool-call argument fragments by index', async () => {
    const response = await chatToCompletion(
      eventStream([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] } },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
      ctx(),
    )
    expect(response.choices[0]?.message.content).toBeNull()
    expect(response.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      },
    ])
    expect(response.choices[0]?.finish_reason).toBe('tool_calls')
  })
})
