import { asRecord, getString } from '../../util/json'
import type { ChatCompletionResponse, ResponseToolCall, TranslateContext } from '../types'
import type { AssembledResponse } from './assemble'
import { completionId, computeFinishReason, epochSeconds } from './wire'

// Walks the assembled output items into a single chat.completion. output_text -> content,
// function_call -> tool_calls, reasoning -> dropped. (PLAN §10.)
export function responsesToCompletion(
  assembled: AssembledResponse,
  ctx: TranslateContext,
): ChatCompletionResponse {
  let text = ''
  const toolCalls: ResponseToolCall[] = []

  for (const item of assembled.items) {
    const type = getString(item, 'type')
    if (type === 'message') {
      text += messageText(item)
    } else if (type === 'function_call') {
      toolCalls.push({
        id: getString(item, 'call_id') ?? getString(item, 'id') ?? '',
        type: 'function',
        function: {
          name: getString(item, 'name') ?? '',
          arguments: getString(item, 'arguments') ?? '',
        },
      })
    }
  }

  const finishReason = computeFinishReason({
    status: assembled.status,
    incompleteReason: assembled.incompleteReason,
    hasToolCalls: toolCalls.length > 0,
  })

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
        finish_reason: finishReason,
      },
    ],
    usage: assembled.usage,
  }
}

function messageText(item: unknown): string {
  const content = asRecord(item)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => getString(part, 'type') === 'output_text')
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}
