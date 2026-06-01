import { asRecord, getNumber, getString } from '../../util/json'
import type {
  ChatCompletionResponse,
  FinishReason,
  ResponseToolCall,
  SSEvent,
  TranslateContext,
  Usage,
} from '../types'
import { chunkUsage, completionId, epochSeconds, parseEventData } from './wire'

interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

// Aggregates the streamed Chat Completions response (the upstream is always streamed) into a single
// chat.completion: concatenating content deltas and stitching tool_call argument deltas by index.
export async function chatToCompletion(
  events: AsyncIterable<SSEvent>,
  ctx: TranslateContext,
): Promise<ChatCompletionResponse> {
  let content = ''
  let finishReason: FinishReason | null = null
  let usage: Usage | undefined
  const toolCalls = new Map<number, PartialToolCall>()

  for await (const event of events) {
    if (event.data === '[DONE]') continue
    const data = asRecord(parseEventData(event.data))
    if (!data) continue

    const captured = chunkUsage(data.usage)
    if (captured) usage = captured

    if (!Array.isArray(data.choices)) continue
    for (const choice of data.choices) {
      const record = asRecord(choice)
      const delta = asRecord(record?.delta)
      content += getString(delta, 'content') ?? ''
      accumulateToolCalls(toolCalls, delta?.tool_calls)
      const reason = getString(record, 'finish_reason')
      if (reason) finishReason = reason as FinishReason
    }
  }

  const tools = [...toolCalls.entries()]
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
          content: content !== '' ? content : tools.length > 0 ? null : '',
          ...(tools.length > 0 ? { tool_calls: tools } : {}),
        },
        finish_reason: finishReason ?? 'stop',
      },
    ],
    usage,
  }
}

// OpenAI streams a tool call as a header delta (index + id + function.name) followed by
// function.arguments fragments under the same index; reassemble them in arrival order.
function accumulateToolCalls(acc: Map<number, PartialToolCall>, deltaToolCalls: unknown): void {
  if (!Array.isArray(deltaToolCalls)) return
  for (const entry of deltaToolCalls) {
    const record = asRecord(entry)
    if (!record) continue
    const index = getNumber(record, 'index') ?? 0
    const existing = acc.get(index) ?? { id: '', name: '', arguments: '' }
    const fn = asRecord(record.function)
    existing.id = getString(record, 'id') ?? existing.id
    existing.name = getString(fn, 'name') ?? existing.name
    existing.arguments += getString(fn, 'arguments') ?? ''
    acc.set(index, existing)
  }
}
