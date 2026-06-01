import { asRecord } from '../../util/json'
import type { ChatCompletionChunk, SSEvent, TranslateContext, Usage } from '../types'
import { chunkUsage, completionId, epochSeconds, parseEventData } from './wire'

// Chat Completions SSE -> CC chunks. Same wire format in and out, so this relays the upstream
// chunks, re-stamping id/model to ownllm's values and gating the trailing usage chunk on the
// client's include_usage (ownllm always asks the upstream for usage via stream_options).
export async function* chatToChunks(
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

  let usage: Usage | undefined
  for await (const event of events) {
    if (event.data === '[DONE]') continue
    const data = asRecord(parseEventData(event.data))
    if (!data) continue

    const captured = chunkUsage(data.usage)
    if (captured) usage = captured

    const choices = data.choices
    if (Array.isArray(choices) && choices.length > 0) {
      yield chunk(choices as ChatCompletionChunk['choices'])
    }
  }

  if (ctx.includeUsage && usage) yield chunk([], usage)
}
