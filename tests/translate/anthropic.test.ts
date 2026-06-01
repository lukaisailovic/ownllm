import { describe, expect, it } from 'vitest'
import { buildAnthropicRequest } from '../../src/translate/anthropic/request'
import { anthropicToCompletion } from '../../src/translate/anthropic/response'
import { anthropicToChunks } from '../../src/translate/anthropic/stream'
import type { ChatCompletionChunk, ChatCompletionRequest } from '../../src/translate/types'
import { ctx, eventStream } from '../support/responses'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'minimax',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

describe('buildAnthropicRequest', () => {
  it('lifts system messages out, defaults max_tokens, and forces streaming', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      }),
      ctx({ upstreamModel: 'MiniMax-M2' }),
    )
    expect(body.model).toBe('MiniMax-M2')
    expect(body.system).toBe('sys')
    expect(body.max_tokens).toBe(8192)
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('prefers max_completion_tokens over max_tokens', () => {
    expect(
      buildAnthropicRequest(request({ max_tokens: 100, max_completion_tokens: 200 }), ctx())
        .max_tokens,
    ).toBe(200)
  })

  it('maps an assistant tool call to a tool_use block and a tool result to a tool_result block', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: '72F' },
        ],
      }),
      ctx(),
    )
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc_1', name: 'get_weather', input: { city: 'SF' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '72F' }] },
    ])
  })

  it('merges adjacent same-role turns (parallel tool results become one user turn)', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          { role: 'tool', tool_call_id: 'a', content: 'ra' },
          { role: 'tool', tool_call_id: 'b', content: 'rb' },
        ],
      }),
      ctx(),
    )
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        ],
      },
    ])
  })

  it('encodes a data-URL image as a base64 source block', () => {
    const body = buildAnthropicRequest(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
          },
        ],
      }),
      ctx(),
    )
    expect((body.messages as { content: unknown[] }[])[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])
  })

  it('converts tools and tool_choice to the Anthropic shape', () => {
    const auto = buildAnthropicRequest(
      request({
        tools: [
          {
            type: 'function',
            function: { name: 'f', description: 'd', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'required',
      }),
      ctx(),
    )
    expect(auto.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }])
    expect(auto.tool_choice).toEqual({ type: 'any' })

    const named = buildAnthropicRequest(
      request({ tool_choice: { type: 'function', function: { name: 'f' } } }),
      ctx(),
    )
    expect(named.tool_choice).toEqual({ type: 'tool', name: 'f' })
  })
})

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('anthropicToChunks', () => {
  it('streams text deltas and a final stop with usage when requested', async () => {
    const chunks = await collect(
      anthropicToChunks(
        eventStream([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          },
        ]),
        ctx({ includeUsage: true }),
      ),
    )
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(['Hello'])
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe('stop')
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
  })

  it('maps tool_use blocks to tool_call deltas and a tool_calls finish', async () => {
    const chunks = await collect(
      anthropicToChunks(
        eventStream([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' },
          },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
        ctx(),
      ),
    )
    const header = chunks.find((c) => c.choices[0]?.delta.tool_calls?.[0]?.id)
    expect(header?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'toolu_1',
      function: { name: 'get_weather' },
    })
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
      'tool_calls',
    )
  })
})

describe('anthropicToCompletion', () => {
  it('aggregates text and tool calls with usage and finish_reason', async () => {
    const response = await anthropicToCompletion(
      eventStream([
        { type: 'message_start', message: { usage: { input_tokens: 4 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"x"}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      ]),
      ctx({ requestedModel: 'minimax' }),
    )
    expect(response.choices[0]?.message.content).toBeNull()
    expect(response.choices[0]?.message.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
    ])
    expect(response.choices[0]?.finish_reason).toBe('tool_calls')
    expect(response.usage).toEqual({ prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 })
  })
})
