import { asRecord, getNumber, getString } from '../../util/json'
import type { ChatCompletionChunk, SSEvent, TranslateContext, Usage } from '../types'
import { anthropicUsage, completionId, epochSeconds, mapStopReason, parseEventData } from './wire'

// Anthropic Messages SSE -> CC streaming chunks. Tool-call indices follow the ORDER of tool_use
// content blocks (Anthropic's block index also spans text/thinking blocks); thinking is dropped.
export async function* anthropicToChunks(
  events: AsyncIterable<SSEvent>,
  ctx: TranslateContext,
): AsyncGenerator<ChatCompletionChunk> {
  const id = completionId()
  const created = epochSeconds()
  const chunk = (choices: ChatCompletionChunk['choices'], usage?: Usage): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: ctx.requestedModel,
    choices,
    ...(usage ? { usage } : {}),
  })

  yield chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])

  const toolIndexByBlock = new Map<number, number>()
  let nextToolIndex = 0
  let stopReason: string | undefined
  let inputTokens = 0
  let outputTokens = 0

  for await (const event of events) {
    const data = parseEventData(event.data)
    const type = getString(data, 'type')

    if (type === 'message_start') {
      inputTokens = getNumber(asRecord(asRecord(data)?.message)?.usage, 'input_tokens') ?? 0
      continue
    }

    if (type === 'content_block_start') {
      const block = asRecord(asRecord(data)?.content_block)
      if (getString(block, 'type') !== 'tool_use') continue
      const toolIndex = nextToolIndex++
      toolIndexByBlock.set(getNumber(data, 'index') ?? -1, toolIndex)
      yield chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: getString(block, 'id'),
                type: 'function',
                function: { name: getString(block, 'name') ?? '', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ])
      continue
    }

    if (type === 'content_block_delta') {
      const delta = asRecord(asRecord(data)?.delta)
      const deltaType = getString(delta, 'type')
      if (deltaType === 'text_delta') {
        const text = getString(delta, 'text')
        if (text) yield chunk([{ index: 0, delta: { content: text }, finish_reason: null }])
        continue
      }
      if (deltaType === 'input_json_delta') {
        const toolIndex = toolIndexByBlock.get(getNumber(data, 'index') ?? -1)
        const partial = getString(delta, 'partial_json')
        if (toolIndex !== undefined && partial) {
          yield chunk([
            {
              index: 0,
              delta: { tool_calls: [{ index: toolIndex, function: { arguments: partial } }] },
              finish_reason: null,
            },
          ])
        }
      }
      continue
    }

    if (type === 'message_delta') {
      stopReason = getString(asRecord(asRecord(data)?.delta), 'stop_reason') ?? stopReason
      outputTokens = getNumber(asRecord(data)?.usage, 'output_tokens') ?? outputTokens
    }
  }

  yield chunk([
    { index: 0, delta: {}, finish_reason: mapStopReason(stopReason, nextToolIndex > 0) },
  ])
  if (ctx.includeUsage) yield chunk([], anthropicUsage(inputTokens, outputTokens))
}
