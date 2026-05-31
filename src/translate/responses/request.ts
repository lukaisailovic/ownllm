import { logger } from '../../logger'
import { asRecord, getString } from '../../util/json'
import type {
  ChatCompletionRequest,
  ChatContentPart,
  ChatMessage,
  TranslateContext,
} from '../types'

type InputItem = Record<string, unknown>

// CC -> Responses request (PLAN §10, base/provider-agnostic). Provider sanitizeBody runs after this
// and owns provider quirks only; this layer owns multimodal, instructions, tool flattening,
// max_tokens precedence, response_format and reasoning_effort mapping.
export function buildResponsesRequest(
  request: ChatCompletionRequest,
  ctx: TranslateContext,
): Record<string, unknown> {
  const { instructions, input } = convertMessages(request.messages)

  const body: Record<string, unknown> = { model: ctx.upstreamModel, input, stream: true }
  if (instructions) body.instructions = instructions

  const maxOutput = request.max_completion_tokens ?? request.max_tokens
  if (maxOutput !== undefined) body.max_output_tokens = maxOutput
  if (request.response_format !== undefined) body.text = { format: request.response_format }

  const effort = request.reasoning_effort ?? ctx.reasoningEffort
  if (effort) body.reasoning = { effort }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.top_p !== undefined) body.top_p = request.top_p

  const tools = convertTools(request.tools)
  if (tools) body.tools = tools
  const toolChoice = convertToolChoice(request.tool_choice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice

  return body
}

function convertMessages(messages: ChatMessage[]): { instructions?: string; input: InputItem[] } {
  const instructionParts: string[] = []
  const input: InputItem[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = contentToText(message.content)
      if (text) instructionParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: contentToText(message.content) ?? '',
      })
      continue
    }
    if (message.role === 'user') {
      input.push({ type: 'message', role: 'user', content: userContentParts(message.content) })
      continue
    }
    // assistant: text item first, then one function_call per tool_call preserving order.
    const text = contentToText(message.content)
    if (text) {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
    }
  }

  return {
    instructions: instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined,
    input,
  }
}

export function contentToText(content: ChatMessage['content']): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((part) => getString(part, 'type') === 'text')
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}

function userContentParts(content: ChatMessage['content']): InputItem[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  if (!Array.isArray(content)) return []

  const parts: InputItem[] = []
  for (const part of content) {
    const item = convertContentPart(part)
    if (item) parts.push(item)
  }
  return parts
}

function convertContentPart(part: ChatContentPart): InputItem | undefined {
  const type = getString(part, 'type')
  if (type === 'text') return { type: 'input_text', text: getString(part, 'text') ?? '' }
  if (type === 'image_url') {
    const url = getString(asRecord(part)?.image_url, 'url')
    if (url) return { type: 'input_image', image_url: url }
  }
  logger.debug({ type }, 'dropping unsupported content part')
  return undefined
}

function convertTools(tools: ChatCompletionRequest['tools']): InputItem[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => {
    const fn = asRecord(asRecord(tool)?.function)
    return {
      type: 'function',
      name: getString(fn, 'name') ?? '',
      description: getString(fn, 'description'),
      parameters: fn?.parameters ?? { type: 'object', properties: {} },
    }
  })
}

// CC names a chosen tool as {type:function, function:{name}}; Responses flattens it to
// {type:function, name}. Strings (auto/none/required) pass through.
function convertToolChoice(toolChoice: ChatCompletionRequest['tool_choice']): unknown {
  if (toolChoice === undefined || typeof toolChoice === 'string') return toolChoice
  const name = getString(asRecord(toolChoice)?.function, 'name')
  return name ? { type: 'function', name } : toolChoice
}
