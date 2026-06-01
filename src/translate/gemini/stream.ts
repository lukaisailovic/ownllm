import { asRecord, getString } from '../../util/json'
import type { ChatCompletionChunk, SSEvent, TranslateContext, Usage } from '../types'
import {
  completionId,
  epochSeconds,
  functionCallId,
  mapFinishReason,
  parseEventData,
  unwrapResponse,
  usageFromMetadata,
} from './wire'

// Gemini streamGenerateContent SSE -> CC streaming chunks. Each functionCall part arrives whole (not
// fragmented), so it emits one tool_call header carrying its full arguments; thought parts drop.
export async function* geminiToChunks(
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

  let nextToolIndex = 0
  let finishReason: string | undefined
  let usage: Usage | undefined

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
        yield chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: nextToolIndex++,
                  id: functionCallId(),
                  type: 'function',
                  function: {
                    name: getString(functionCall, 'name') ?? '',
                    arguments: JSON.stringify(functionCall.args ?? {}),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ])
        continue
      }

      const text = getString(record, 'text')
      if (text) yield chunk([{ index: 0, delta: { content: text }, finish_reason: null }])
    }
  }

  yield chunk([
    { index: 0, delta: {}, finish_reason: mapFinishReason(finishReason, nextToolIndex > 0) },
  ])
  if (ctx.includeUsage && usage) yield chunk([], usage)
}
