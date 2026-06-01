import { randomUUID } from 'node:crypto'
import { asRecord, getNumber } from '../../util/json'
import type { FinishReason, Usage } from '../types'

// Helpers for the Gemini Cloud Code wire format. The format-agnostic primitives live in ../wire and
// are re-exported so the Gemini internals keep importing everything from one place.
export { completionId, epochSeconds, parseEventData } from '../wire'

// Cloud Code wraps each streamGenerateContent payload in a `response` envelope; tolerate an
// already-unwrapped object too.
export function unwrapResponse(data: unknown): Record<string, unknown> | undefined {
  const record = asRecord(data)
  return asRecord(record?.response) ?? record
}

// Gemini function calls carry no id; synthesize an OpenAI-shaped one so tool results can correlate.
export function functionCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

const FINISH_REASONS: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
}

// A streamed function call overrides everything else, matching the other translators' precedence.
export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls'
  return (reason ? FINISH_REASONS[reason] : undefined) ?? 'stop'
}

export function usageFromMetadata(metadata: unknown): Usage | undefined {
  const usage = asRecord(metadata)
  if (!usage) return undefined
  const prompt = getNumber(usage, 'promptTokenCount') ?? 0
  const completion = getNumber(usage, 'candidatesTokenCount') ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: getNumber(usage, 'totalTokenCount') ?? prompt + completion,
  }
}
