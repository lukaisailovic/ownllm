import type { FinishReason, Usage } from '../types'

// Helpers for the Anthropic Messages wire format. The format-agnostic primitives live in ../wire and
// are re-exported so the Anthropic internals keep importing everything from one place.
export { completionId, epochSeconds, parseEventData } from '../wire'

// Anthropic stop_reason -> OpenAI finish_reason. A streamed tool call overrides everything else, the
// same precedence the Responses translator uses.
export function mapStopReason(stopReason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_calls'
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'refusal') return 'content_filter'
  return 'stop'
}

export function anthropicUsage(inputTokens: number, outputTokens: number): Usage {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}
