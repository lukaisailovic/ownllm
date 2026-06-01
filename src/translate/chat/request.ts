import type { ChatCompletionRequest, ChatMessage, TranslateContext } from '../types'

// CC -> Chat Completions upstream body. Incoming and upstream both speak Chat Completions, so this
// is a faithful forward: swap in the upstream model id, force streaming (ownllm always streams
// upstream and aggregates at the edge), and request usage so the aggregate path has it. Only the
// params ownllm supports are forwarded; the param policy's ignored params are left behind.
export function buildChatRequest(
  request: ChatCompletionRequest,
  ctx: TranslateContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ctx.upstreamModel,
    messages: request.messages.map(foldDeveloperRole),
    stream: true,
    stream_options: { include_usage: true },
  }

  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.top_p !== undefined) body.top_p = request.top_p
  if (request.response_format !== undefined) body.response_format = request.response_format

  const effort = request.reasoning_effort ?? ctx.reasoningEffort
  if (effort) body.reasoning_effort = effort

  if (request.tools && request.tools.length > 0) body.tools = request.tools
  if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice

  return body
}

// `developer` is OpenAI's newer system alias; most OpenAI-compatible upstreams still expect
// `system`. Fold it down so every Chat Completions provider sees a role it understands.
function foldDeveloperRole(message: ChatMessage): ChatMessage {
  if (message.role !== 'developer') return message
  return { ...message, role: 'system' }
}
