import { asRecord, getNumber, getString } from '../../util/json'
import type { FinishReason, Usage } from '../types'

// Helpers for translating the OpenAI Responses wire format (used by both the streaming and the
// aggregate paths). The format-agnostic primitives live in ../wire and are re-exported so the
// Responses internals keep importing everything from one place.
export { completionId, epochSeconds, parseEventData } from '../wire'

export function eventType(data: unknown): string | undefined {
  return getString(data, 'type')
}

// Extracts token usage from a Responses `response` object (input/output -> prompt/completion).
export function responseUsage(response: Record<string, unknown> | undefined): Usage | undefined {
  const usage = asRecord(response?.usage)
  if (!usage) return undefined
  const input = getNumber(usage, 'input_tokens') ?? 0
  const output = getNumber(usage, 'output_tokens') ?? 0
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
}

// PLAN §10 finish_reason map. Tool calls override everything else.
export function computeFinishReason(opts: {
  status?: string
  incompleteReason?: string
  hasToolCalls: boolean
}): FinishReason {
  if (opts.hasToolCalls) return 'tool_calls'
  if (opts.incompleteReason === 'max_output_tokens') return 'length'
  if (opts.incompleteReason === 'content_filter' || opts.status === 'content_filter') {
    return 'content_filter'
  }
  return 'stop'
}
