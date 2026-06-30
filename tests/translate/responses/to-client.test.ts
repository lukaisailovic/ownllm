import { describe, expect, it } from 'vitest'
import { responsesToChunks } from '../../../src/translate/responses/stream'
import {
  completionToResponse,
  streamCompletionToResponses,
} from '../../../src/translate/responses/to-client'
import type { ResponseSSEFrame } from '../../../src/translate/responses/to-client'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ResponseToolCall,
} from '../../../src/translate/types'
import { INTERLEAVED_EVENTS, ctx, eventStream } from '../../support/responses'

async function collect(frames: AsyncIterable<ResponseSSEFrame>): Promise<ResponseSSEFrame[]> {
  const out: ResponseSSEFrame[] = []
  for await (const frame of frames) out.push(frame)
  return out
}

function dataOf(frames: ResponseSSEFrame[], event: string): Record<string, unknown>[] {
  return frames.filter((f) => f.event === event).map((f) => JSON.parse(f.data))
}

async function* chunkStream(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk
}

function chunk(choices: ChatCompletionChunk['choices'], usage?: ChatCompletionChunk['usage']) {
  return {
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk' as const,
    created: 0,
    model: 'gpt-5',
    choices,
    ...(usage !== undefined ? { usage } : {}),
  }
}

describe('streamCompletionToResponses', () => {
  it('renders the interleaved upstream->CC stream into Responses SSE frames', async () => {
    const cc = responsesToChunks(eventStream(INTERLEAVED_EVENTS), ctx({ includeUsage: true }))
    const frames = await collect(streamCompletionToResponses(cc, ctx({ includeUsage: true })))

    expect(frames[0]?.event).toBe('response.created')
    expect(frames[1]?.event).toBe('response.in_progress')
    expect(frames.at(-1)?.event).toBe('response.completed')

    const text = dataOf(frames, 'response.output_text.delta')
      .map((d) => d.delta)
      .join('')
    expect(text).toBe('Let me check.')

    const added = dataOf(frames, 'response.output_item.added')
    const functionCalls = added
      .map((d) => d.item as Record<string, unknown>)
      .filter((item) => item.type === 'function_call')
    expect(functionCalls.map((item) => item.name)).toEqual(['get_weather', 'get_time'])

    const argsByIndex = new Map<number, string>()
    for (const d of dataOf(frames, 'response.function_call_arguments.delta')) {
      const index = d.output_index as number
      argsByIndex.set(index, (argsByIndex.get(index) ?? '') + (d.delta as string))
    }
    expect([...argsByIndex.values()]).toEqual(['{"city":"SF"}', '{"tz":"PT"}'])

    const completed = dataOf(frames, 'response.completed')[0]
    const response = completed?.response as Record<string, unknown>
    const output = response.output as Record<string, unknown>[]
    expect(output[0]?.type).toBe('message')
    const tools = output.filter((item) => item.type === 'function_call')
    expect(tools).toEqual([
      {
        type: 'function_call',
        id: expect.any(String),
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"SF"}',
        status: 'completed',
      },
      {
        type: 'function_call',
        id: expect.any(String),
        call_id: 'call_2',
        name: 'get_time',
        arguments: '{"tz":"PT"}',
        status: 'completed',
      },
    ])

    const usage = response.usage as Record<string, unknown>
    expect(usage.input_tokens).toBe(10)
    expect(usage.output_tokens).toBe(20)
    expect(response.status).toBe('completed')
  })

  it('emits valid JSON typed frames with strictly increasing sequence numbers from 0', async () => {
    const cc = responsesToChunks(eventStream(INTERLEAVED_EVENTS), ctx({ includeUsage: true }))
    const frames = await collect(streamCompletionToResponses(cc, ctx({ includeUsage: true })))

    let expected = 0
    for (const f of frames) {
      const parsed = JSON.parse(f.data) as Record<string, unknown>
      expect(parsed.type).toBe(f.event)
      expect(parsed.sequence_number).toBe(expected)
      expected += 1
    }
  })

  it('streams text-only completions without function_call items', async () => {
    const chunks: ChatCompletionChunk[] = [
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: ' world' }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]
    const frames = await collect(streamCompletionToResponses(chunkStream(chunks), ctx()))

    expect(frames[0]?.event).toBe('response.created')
    expect(frames[1]?.event).toBe('response.in_progress')

    const text = dataOf(frames, 'response.output_text.delta')
      .map((d) => d.delta)
      .join('')
    expect(text).toBe('Hello world')

    const completed = dataOf(frames, 'response.completed')[0]
    const response = completed?.response as Record<string, unknown>
    const output = response.output as Record<string, unknown>[]
    expect(output).toHaveLength(1)
    expect(output[0]?.type).toBe('message')
    expect(response.status).toBe('completed')
    expect(response.output_text).toBe('Hello world')
  })

  it('does not open a message item for the empty opener content delta', async () => {
    const chunks: ChatCompletionChunk[] = [
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]
    const frames = await collect(streamCompletionToResponses(chunkStream(chunks), ctx()))

    expect(dataOf(frames, 'response.output_item.added')).toHaveLength(0)
    const completed = dataOf(frames, 'response.completed')[0]
    const response = completed?.response as Record<string, unknown>
    expect(response.output).toEqual([])
  })

  it('emits the terminal response.completed, then propagates a mid-stream failure', async () => {
    async function* failing(): AsyncGenerator<ChatCompletionChunk> {
      yield chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])
      yield chunk([{ index: 0, delta: { content: 'partial' }, finish_reason: null }])
      throw new Error('upstream exploded')
    }
    const frames: ResponseSSEFrame[] = []
    let thrown: unknown
    try {
      for await (const frame of streamCompletionToResponses(failing(), ctx())) frames.push(frame)
    } catch (error) {
      thrown = error
    }

    // The client still gets a clean, complete terminal sequence...
    expect(dataOf(frames, 'response.output_item.done')).toHaveLength(1)
    expect(frames.at(-1)?.event).toBe('response.completed')
    const response = dataOf(frames, 'response.completed')[0]?.response as Record<string, unknown>
    expect(response.error).toBeNull()
    // ...and the failure still surfaces so the route logs it (parity with the chat route).
    expect(thrown).toBeInstanceOf(Error)
  })
})

describe('completionToResponse', () => {
  it('maps a text completion to a message output item with mapped usage', () => {
    const completion: ChatCompletionResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1234,
      model: 'gpt-5',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }
    const response = completionToResponse(completion, ctx())

    expect(response.object).toBe('response')
    expect(response.status).toBe('completed')
    expect(response.created_at).toBe(1234)
    expect(response.model).toBe('gpt-5')
    expect(response.output).toEqual([
      {
        type: 'message',
        id: expect.any(String),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi there', annotations: [] }],
      },
    ])
    expect(response.output_text).toBe('hi there')
    expect(response.usage).toEqual({
      input_tokens: 5,
      output_tokens: 7,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
    expect(response.incomplete_details).toBeNull()
  })

  it('maps tool_calls with finish_reason length to incomplete function_call items', () => {
    const toolCalls: ResponseToolCall[] = [
      { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
    ]
    const completion: ChatCompletionResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 99,
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: toolCalls },
          finish_reason: 'length',
        },
      ],
    }
    const response = completionToResponse(completion, ctx())

    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
    expect(response.usage).toBeNull()
    expect(response.output).toEqual([
      {
        type: 'function_call',
        id: expect.any(String),
        call_id: 'call_a',
        name: 'lookup',
        arguments: '{"q":"x"}',
        status: 'completed',
      },
    ])
  })
})
