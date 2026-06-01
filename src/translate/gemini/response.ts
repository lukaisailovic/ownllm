import { asRecord, getString } from '../../util/json'
import type {
  ChatCompletionResponse,
  ResponseToolCall,
  SSEvent,
  TranslateContext,
  Usage,
} from '../types'
import {
  completionId,
  epochSeconds,
  functionCallId,
  mapFinishReason,
  parseEventData,
  unwrapResponse,
  usageFromMetadata,
} from './wire'

// Aggregates the streamed Gemini response into a single chat.completion: concatenating text parts
// and collecting whole functionCall parts as tool calls.
export async function geminiToCompletion(
  events: AsyncIterable<SSEvent>,
  ctx: TranslateContext,
): Promise<ChatCompletionResponse> {
  let text = ''
  let finishReason: string | undefined
  let usage: Usage | undefined
  const toolCalls: ResponseToolCall[] = []

  for await (const event of events) {
    const inner = unwrapResponse(parseEventData(event.data))
    if (!inner) continue

    const captured = usageFromMetadata(inner.usageMetadata)
    if (captured) usage = captured

    const candidate = asRecord(Array.isArray(inner.candidates) ? inner.candidates[0] : undefined)
    if (!candidate) continue
    finishReason = getString(candidate, 'finishReason') ?? finishReason

    const parts = asRecord(candidate.content)?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const record = asRecord(part)
      if (!record || record.thought === true) continue
      const functionCall = asRecord(record.functionCall)
      if (functionCall) {
        toolCalls.push({
          id: functionCallId(),
          type: 'function',
          function: {
            name: getString(functionCall, 'name') ?? '',
            arguments: JSON.stringify(functionCall.args ?? {}),
          },
        })
        continue
      }
      text += getString(record, 'text') ?? ''
    }
  }

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
        finish_reason: mapFinishReason(finishReason, toolCalls.length > 0),
      },
    ],
    usage,
  }
}
