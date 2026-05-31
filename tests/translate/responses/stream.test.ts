import { describe, expect, it } from 'vitest'
import { responsesTranslator } from '../../../src/translate/responses'
import type { ChatCompletionChunk } from '../../../src/translate/types'
import { INTERLEAVED_EVENTS, ctx, eventStream } from '../../support/responses'

async function collect(chunks: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

interface AccumulatedTool {
  index: number
  id?: string
  name?: string
  arguments: string
}

function reconstructTools(chunks: ChatCompletionChunk[]): AccumulatedTool[] {
  const byIndex = new Map<number, AccumulatedTool>()
  for (const chunk of chunks) {
    for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
      const tool = byIndex.get(call.index) ?? { index: call.index, arguments: '' }
      if (call.id) tool.id = call.id
      if (call.function?.name) tool.name = call.function.name
      tool.arguments += call.function?.arguments ?? ''
      byIndex.set(call.index, tool)
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

describe('streamToChunks', () => {
  it('opens with an assistant role chunk', async () => {
    const chunks = await collect(
      responsesTranslator.streamToChunks(eventStream(INTERLEAVED_EVENTS), ctx()),
    )
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: '' })
  })

  it('streams the interleaved case with order-based tool indices', async () => {
    const chunks = await collect(
      responsesTranslator.streamToChunks(eventStream(INTERLEAVED_EVENTS), ctx()),
    )

    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')
    expect(text).toBe('Let me check.')

    // Tool indices follow function_call order (0, 1) — NOT Responses output_index (2, 3).
    expect(reconstructTools(chunks)).toEqual([
      { index: 0, id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      { index: 1, id: 'call_2', name: 'get_time', arguments: '{"tz":"PT"}' },
    ])
  })

  it('ends with a tool_calls finish chunk and no usage chunk by default', async () => {
    const chunks = await collect(
      responsesTranslator.streamToChunks(eventStream(INTERLEAVED_EVENTS), ctx()),
    )
    const finish = chunks.find((c) => c.choices[0]?.finish_reason)
    expect(finish?.choices[0]?.finish_reason).toBe('tool_calls')
    expect(finish?.choices[0]?.delta).toEqual({})
    expect(chunks.some((c) => c.usage != null)).toBe(false)
  })

  it('appends a usage chunk only when include_usage is set', async () => {
    const chunks = await collect(
      responsesTranslator.streamToChunks(
        eventStream(INTERLEAVED_EVENTS),
        ctx({ includeUsage: true }),
      ),
    )
    const last = chunks.at(-1)
    expect(last?.choices).toEqual([])
    expect(last?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
  })
})
