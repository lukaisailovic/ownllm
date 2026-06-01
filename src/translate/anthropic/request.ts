import { logger } from '../../logger'
import { asRecord, getString } from '../../util/json'
import type { ChatCompletionRequest, ChatMessage, TranslateContext } from '../types'

// Anthropic requires max_tokens; pick a generous default when the client doesn't set one.
const DEFAULT_MAX_TOKENS = 8192

type Block = Record<string, unknown>
interface Turn {
  role: 'user' | 'assistant'
  content: Block[]
}

// CC -> Anthropic Messages request. System/developer messages lift into top-level `system`; tool
// results fold into user turns; assistant tool_calls become tool_use blocks. ownllm always streams.
export function buildAnthropicRequest(
  request: ChatCompletionRequest,
  ctx: TranslateContext,
): Record<string, unknown> {
  const { system, messages } = convertMessages(request.messages)

  const body: Record<string, unknown> = {
    model: ctx.upstreamModel,
    messages,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (system) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.top_p !== undefined) body.top_p = request.top_p

  const tools = convertTools(request.tools)
  if (tools) body.tools = tools
  const toolChoice = convertToolChoice(request.tool_choice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice

  return body
}

function convertMessages(messages: ChatMessage[]): { system?: string; messages: Turn[] } {
  const systemParts: string[] = []
  const turns: Turn[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textFromContent(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === 'tool') {
      turns.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: textFromContent(message.content) ?? '',
          },
        ],
      })
      continue
    }
    if (message.role === 'user') {
      turns.push({ role: 'user', content: userBlocks(message.content) })
      continue
    }
    turns.push({ role: 'assistant', content: assistantBlocks(message) })
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: mergeTurns(turns),
  }
}

// Anthropic alternates user/assistant and rejects empty content, so coalesce adjacent same-role
// turns (e.g. a fanned-out set of tool results) and drop any turn that ends up empty.
function mergeTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = []
  for (const turn of turns) {
    if (turn.content.length === 0) continue
    const last = merged.at(-1)
    if (last?.role === turn.role) {
      last.content.push(...turn.content)
      continue
    }
    merged.push({ role: turn.role, content: [...turn.content] })
  }
  return merged
}

function userBlocks(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []

  const blocks: Block[] = []
  for (const part of content) {
    const type = getString(part, 'type')
    if (type === 'text') {
      blocks.push({ type: 'text', text: getString(part, 'text') ?? '' })
      continue
    }
    if (type === 'image_url') {
      const block = imageBlock(getString(asRecord(part)?.image_url, 'url'))
      if (block) blocks.push(block)
      continue
    }
    logger.debug({ type }, 'dropping unsupported content part')
  }
  return blocks
}

function assistantBlocks(message: ChatMessage): Block[] {
  const blocks: Block[] = []
  const text = textFromContent(message.content)
  if (text) blocks.push({ type: 'text', text })
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: safeParseArguments(call.function.arguments),
    })
  }
  return blocks
}

function imageBlock(url: string | undefined): Block | undefined {
  if (!url) return undefined
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return undefined
}

function convertTools(tools: ChatCompletionRequest['tools']): Block[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => {
    const fn = asRecord(asRecord(tool)?.function)
    return {
      name: getString(fn, 'name') ?? '',
      description: getString(fn, 'description'),
      input_schema: fn?.parameters ?? { type: 'object', properties: {} },
    }
  })
}

function convertToolChoice(toolChoice: ChatCompletionRequest['tool_choice']): unknown {
  if (toolChoice === undefined) return undefined
  if (toolChoice === 'auto') return { type: 'auto' }
  if (toolChoice === 'required') return { type: 'any' }
  if (toolChoice === 'none') return { type: 'none' }
  const name = getString(asRecord(toolChoice)?.function, 'name')
  return name ? { type: 'tool', name } : undefined
}

function textFromContent(content: ChatMessage['content']): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((part) => getString(part, 'type') === 'text')
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}

// Anthropic wants tool_use.input as an object; OpenAI ships arguments as a JSON string.
function safeParseArguments(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}
