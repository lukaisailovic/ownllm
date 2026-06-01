import { asRecord, getNumber } from '../../util/json'
import type { Usage } from '../types'

// Helpers for the Chat Completions wire format. The format-agnostic primitives live in ../wire and
// are re-exported so the Chat internals keep importing everything from one place.
export { completionId, epochSeconds, parseEventData } from '../wire'

// Reads a Chat Completions usage object ({prompt_tokens, completion_tokens, total_tokens}); returns
// undefined when the chunk carries no usage (every chunk but the final include_usage one).
export function chunkUsage(value: unknown): Usage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const prompt = getNumber(usage, 'prompt_tokens') ?? 0
  const completion = getNumber(usage, 'completion_tokens') ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: getNumber(usage, 'total_tokens') ?? prompt + completion,
  }
}
