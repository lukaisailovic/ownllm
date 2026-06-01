import { asRecord, getNumber, getString } from '../../util/json'
import type { ChatCompletionResponse, ResponseToolCall, SSEvent, TranslateContext } from '../types'
import { anthropicUsage, completionId, epochSeconds, mapStopReason, parseEventData } from './wire'

interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

// Aggregates the streamed Anthropic response into a single chat.completion: concatenating text
// deltas and stitching tool_use input_json_delta fragments, keyed by content-block index.
export async function anthropicToCompletion(
  events: AsyncIterable<SSEvent>,
  ctx: TranslateContext,
): Promise<ChatCompletionResponse> {
  let text = ''
  let stopReason: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  const toolBlocks = new Map<number, PartialToolCall>()

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
      toolBlocks.set(getNumber(data, 'index') ?? -1, {
        id: getString(block, 'id') ?? '',
        name: getString(block, 'name') ?? '',
        arguments: '',
      })
      continue
    }

    if (type === 'content_block_delta') {
      const delta = asRecord(asRecord(data)?.delta)
      const deltaType = getString(delta, 'type')
      if (deltaType === 'text_delta') {
        text += getString(delta, 'text') ?? ''
        continue
      }
      if (deltaType === 'input_json_delta') {
        const block = toolBlocks.get(getNumber(data, 'index') ?? -1)
        if (block) block.arguments += getString(delta, 'partial_json') ?? ''
      }
      continue
    }

    if (type === 'message_delta') {
      stopReason = getString(asRecord(asRecord(data)?.delta), 'stop_reason') ?? stopReason
      outputTokens = getNumber(asRecord(data)?.usage, 'output_tokens') ?? outputTokens
    }
  }

  const toolCalls = [...toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, call]): ResponseToolCall => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }),
    )

  return {
    id: completionId(),
    object: 'chat.completion',
    created: epochSeconds(),
    model: ctx.requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text !== '' ? text : toolCalls.length > 0 ? null : '',
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(stopReason, toolCalls.length > 0),
      },
    ],
    usage: anthropicUsage(inputTokens, outputTokens),
  }
}
