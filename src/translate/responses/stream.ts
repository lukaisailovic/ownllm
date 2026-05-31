import { asRecord, getString } from '../../util/json'
import type { ChatCompletionChunk, ChunkToolCall, SSEvent, TranslateContext, Usage } from '../types'
import {
  completionId,
  computeFinishReason,
  epochSeconds,
  eventType,
  parseEventData,
  responseUsage,
} from './wire'

// Responses SSE -> CC streaming chunks (PLAN §10). Tool indices are assigned by the ORDER of
// function_call items (NOT Responses output_index, which also spans reasoning/message items); text
// deltas never bump the tool index.
export async function* responsesToChunks(
  events: AsyncIterable<SSEvent>,
  ctx: TranslateContext,
): AsyncGenerator<ChatCompletionChunk> {
  const id = completionId()
  const created = epochSeconds()
  const chunk = (
    choices: ChatCompletionChunk['choices'],
    usage?: Usage | null,
  ): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: ctx.requestedModel,
    choices,
    ...(usage !== undefined ? { usage } : {}),
  })

  yield chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])

  // item.id routes argument deltas; call_id dedups a tool across added/done (item.id may be absent
  // on the done item, but call_id is stable).
  const toolIndexByItemId = new Map<string, number>()
  const emittedCallIds = new Set<string>()
  let nextToolIndex = 0
  let response: Record<string, unknown> | undefined

  for await (const event of events) {
    const data = parseEventData(event.data)
    const type = eventType(data)

    if (type === 'response.output_text.delta') {
      const delta = getString(data, 'delta')
      if (delta) yield chunk([{ index: 0, delta: { content: delta }, finish_reason: null }])
      continue
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = asRecord(data)?.item
      if (getString(item, 'type') !== 'function_call') continue
      const callId = getString(item, 'call_id') ?? getString(item, 'id')
      if (!callId || emittedCallIds.has(callId)) continue

      const toolIndex = nextToolIndex++
      emittedCallIds.add(callId)
      const itemId = getString(item, 'id')
      if (itemId) toolIndexByItemId.set(itemId, toolIndex)
      // A function_call seen only at done (no added/deltas) carries its arguments inline.
      yield chunk([
        {
          index: 0,
          delta: {
            tool_calls: [toolHeader(item, toolIndex, type === 'response.output_item.done')],
          },
          finish_reason: null,
        },
      ])
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const toolIndex = toolIndexByItemId.get(getString(data, 'item_id') ?? '')
      const delta = getString(data, 'delta')
      if (toolIndex !== undefined && delta) {
        yield chunk([
          {
            index: 0,
            delta: { tool_calls: [{ index: toolIndex, function: { arguments: delta } }] },
            finish_reason: null,
          },
        ])
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      response = asRecord(asRecord(data)?.response)
    }
  }

  const finishReason = computeFinishReason({
    status: getString(response, 'status'),
    incompleteReason: getString(asRecord(response?.incomplete_details), 'reason'),
    hasToolCalls: emittedCallIds.size > 0,
  })
  yield chunk([{ index: 0, delta: {}, finish_reason: finishReason }])

  if (ctx.includeUsage) yield chunk([], responseUsage(response) ?? null)
}

function toolHeader(item: unknown, index: number, includeArguments = false): ChunkToolCall {
  return {
    index,
    id: getString(item, 'call_id') ?? getString(item, 'id'),
    type: 'function',
    function: {
      name: getString(item, 'name') ?? '',
      arguments: includeArguments ? (getString(item, 'arguments') ?? '') : '',
    },
  }
}
