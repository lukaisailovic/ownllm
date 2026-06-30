import { z } from 'zod'
import { logger } from '../../logger'
import { asRecord, getNumber, getString } from '../../util/json'
import { invalidRequestBody, unsupportedParameter } from '../errors'
import type { ChatCompletionRequest, ChatContentPart, ChatMessage, ChatToolCall } from '../types'

const ResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]),
  })
  .passthrough()

type PendingAssistant = { content: string; tool_calls: ChatToolCall[] }

// Inbound OpenAI Responses API request -> CC (Chat Completions) currency. The inverse of
// ./request.ts (which emits Responses from CC). Implemented by the responses endpoint.
export function responsesRequestToCompletion(raw: unknown): ChatCompletionRequest {
  const parsed = ResponsesRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw invalidRequestBody(issue?.message ?? 'invalid request body', issue?.path.join('.'))
  }

  const body = parsed.data
  if (body.previous_response_id != null) throw unsupportedParameter('previous_response_id')
  if (body.background === true) throw unsupportedParameter('background')

  const messages = buildMessages(body.instructions, body.input)
  if (messages.length === 0) {
    throw invalidRequestBody('input must contain at least one message', 'input')
  }

  const request: ChatCompletionRequest = {
    model: body.model,
    messages,
    stream_options: { include_usage: true },
  }

  const maxOutput = getNumber(body, 'max_output_tokens')
  if (maxOutput !== undefined) request.max_tokens = maxOutput
  const temperature = getNumber(body, 'temperature')
  if (temperature !== undefined) request.temperature = temperature
  const topP = getNumber(body, 'top_p')
  if (topP !== undefined) request.top_p = topP

  const effort = getString(body.reasoning, 'effort')
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') {
    request.reasoning_effort = effort
  }

  const responseFormat = asRecord(body.text)?.format
  if (responseFormat !== undefined) request.response_format = responseFormat

  const tools = convertTools(body.tools)
  if (tools) request.tools = tools
  const toolChoice = convertToolChoice(body.tool_choice)
  if (toolChoice !== undefined) request.tool_choice = toolChoice

  if (typeof body.stream === 'boolean') request.stream = body.stream
  if (typeof body.parallel_tool_calls === 'boolean') {
    request.parallel_tool_calls = body.parallel_tool_calls
  }

  return request
}

function buildMessages(instructions: unknown, input: string | unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (typeof instructions === 'string' && instructions !== '') {
    messages.push({ role: 'system', content: instructions })
  }

  const items =
    typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input

  let pendingAssistant: PendingAssistant | undefined
  const flush = () => {
    if (!pendingAssistant) return
    const { content, tool_calls } = pendingAssistant
    pendingAssistant = undefined
    if (content === '' && tool_calls.length === 0) return
    messages.push({
      role: 'assistant',
      content: content !== '' ? content : tool_calls.length ? null : '',
      ...(tool_calls.length ? { tool_calls } : {}),
    })
  }

  for (const item of items) {
    const record = asRecord(item)
    if (!record) {
      logger.debug({ item }, 'dropping non-object input item')
      continue
    }
    const type = getString(record, 'type')

    if (type === 'function_call') {
      if (!pendingAssistant) pendingAssistant = { content: '', tool_calls: [] }
      pendingAssistant.tool_calls.push({
        id: getString(record, 'call_id') ?? getString(record, 'id') ?? '',
        type: 'function',
        function: {
          name: getString(record, 'name') ?? '',
          arguments: getString(record, 'arguments') ?? '',
        },
      })
      continue
    }

    if (type === 'function_call_output') {
      flush()
      messages.push({
        role: 'tool',
        tool_call_id: getString(record, 'call_id') ?? '',
        content: outputToText(record.output),
      })
      continue
    }

    if (type === 'message' || (type === undefined && typeof record.role === 'string')) {
      const role = getString(record, 'role')
      if (role === 'assistant') {
        flush()
        pendingAssistant = { content: assistantText(record.content), tool_calls: [] }
        continue
      }
      if (role === 'user' || role === 'system' || role === 'developer') {
        flush()
        messages.push({ role, content: messageContent(record.content, role) })
        continue
      }
      logger.debug({ role }, 'dropping message with unsupported role')
      continue
    }

    logger.debug({ type }, 'dropping unsupported input item')
  }

  flush()
  return messages
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  return JSON.stringify(output)
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => {
      const type = getString(part, 'type')
      return type === 'output_text' || type === 'text'
    })
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}

function messageContent(
  content: unknown,
  role: 'user' | 'system' | 'developer',
): ChatMessage['content'] {
  if (role === 'user') return userContent(content)
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => {
      const type = getString(part, 'type')
      return type === 'input_text' || type === 'text'
    })
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}

function userContent(content: unknown): ChatMessage['content'] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: ChatContentPart[] = []
  for (const part of content) {
    const converted = convertUserPart(part)
    if (converted) parts.push(converted)
  }
  return parts
}

function convertUserPart(part: unknown): ChatContentPart | undefined {
  const type = getString(part, 'type')
  if (type === 'input_text' || type === 'text' || type === 'output_text') {
    return { type: 'text', text: getString(part, 'text') ?? '' }
  }
  if (type === 'input_image') {
    const imageUrl = asRecord(part)?.image_url
    const url = typeof imageUrl === 'string' ? imageUrl : getString(imageUrl, 'url')
    if (url) return { type: 'image_url', image_url: { url } }
  }
  logger.debug({ type }, 'dropping unsupported content part')
  return undefined
}

// Responses function tools are flat {type:function, name, parameters}; CC nests them under
// {function:{...}}. Built-in/hosted tools (type !== 'function') have no CC equivalent: dropped.
function convertTools(tools: unknown): ChatCompletionRequest['tools'] | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted: NonNullable<ChatCompletionRequest['tools']> = []
  for (const tool of tools) {
    const record = asRecord(tool)
    if (getString(record, 'type') !== 'function') {
      logger.debug({ type: getString(record, 'type') }, 'dropping unsupported tool')
      continue
    }
    const description = getString(record, 'description')
    converted.push({
      type: 'function',
      function: {
        name: getString(record, 'name') ?? '',
        ...(description ? { description } : {}),
        parameters: record?.parameters ?? { type: 'object', properties: {} },
      },
    })
  }
  return converted.length > 0 ? converted : undefined
}

// Responses names a chosen tool as {type:function, name}; CC nests it under function:{name}.
// Strings (auto/none/required) and already-nested choices pass through; hosted choices are dropped.
function convertToolChoice(toolChoice: unknown): ChatCompletionRequest['tool_choice'] | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return toolChoice
    }
    return undefined
  }
  const record = asRecord(toolChoice)
  if (getString(record, 'type') !== 'function') return undefined
  const name = getString(record?.function, 'name') ?? getString(record, 'name')
  if (!name) return undefined
  return { type: 'function', function: { name } }
}
