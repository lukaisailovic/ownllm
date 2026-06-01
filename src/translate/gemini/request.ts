import { randomUUID } from 'node:crypto'
import { logger } from '../../logger'
import { asRecord, getString } from '../../util/json'
import type { ChatCompletionRequest, ChatMessage, TranslateContext } from '../types'

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

// Code Assist rejects function calls that didn't originate in its own chain unless they carry this
// sentinel thought signature (see Hermes' gemini_cloudcode_adapter).
const THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

// Gemini accepts only this JSON-schema subset on tool parameters; everything else (e.g. $schema,
// additionalProperties, $ref, oneOf) is stripped at every nesting level.
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
])

// CC -> Cloud Code Assist generateContent envelope. The per-credential `project` is folded in by the
// transport's sanitizeBody; here we build {model, user_prompt_id, request:{...}}. ownllm always
// streams (the transport hits :streamGenerateContent).
export function buildGeminiRequest(
  request: ChatCompletionRequest,
  ctx: TranslateContext,
): Record<string, unknown> {
  const { systemInstruction, contents } = convertMessages(request.messages)

  const inner: Record<string, unknown> = { contents }
  if (systemInstruction) inner.systemInstruction = systemInstruction
  const tools = convertTools(request.tools)
  if (tools) inner.tools = tools
  const toolConfig = convertToolChoice(request.tool_choice)
  if (toolConfig) inner.toolConfig = toolConfig
  const generationConfig = buildGenerationConfig(request)
  if (Object.keys(generationConfig).length > 0) inner.generationConfig = generationConfig

  return { model: ctx.upstreamModel, user_prompt_id: randomUUID(), request: inner }
}

function convertMessages(messages: ChatMessage[]): {
  systemInstruction?: { role: string; parts: Part[] }
  contents: Content[]
} {
  // A tool result names its function, but the CC tool message only carries the call id, so map
  // id -> name from the assistant turns first (Gemini matches functionResponse to functionCall by name).
  const toolNameById = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) toolNameById.set(call.id, call.function.name)
  }

  const systemParts: Part[] = []
  const raw: Content[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textFromContent(message.content)
      if (text) systemParts.push({ text })
      continue
    }
    if (message.role === 'tool') {
      const name = toolNameById.get(message.tool_call_id ?? '') ?? message.name ?? 'tool'
      raw.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: toResponseObject(message.content) } }],
      })
      continue
    }
    if (message.role === 'user') {
      raw.push({ role: 'user', parts: userParts(message.content) })
      continue
    }
    raw.push({ role: 'model', parts: assistantParts(message) })
  }

  return {
    systemInstruction: systemParts.length > 0 ? { role: 'system', parts: systemParts } : undefined,
    contents: mergeContents(raw),
  }
}

// Gemini expects alternating user/model turns and rejects empty parts, so coalesce adjacent
// same-role turns (e.g. parallel tool results) and drop any that end up empty.
function mergeContents(items: Content[]): Content[] {
  const merged: Content[] = []
  for (const item of items) {
    if (item.parts.length === 0) continue
    const last = merged.at(-1)
    if (last?.role === item.role) {
      last.parts.push(...item.parts)
      continue
    }
    merged.push({ role: item.role, parts: [...item.parts] })
  }
  return merged
}

function userParts(content: ChatMessage['content']): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []

  const parts: Part[] = []
  for (const part of content) {
    const type = getString(part, 'type')
    if (type === 'text') {
      parts.push({ text: getString(part, 'text') ?? '' })
      continue
    }
    if (type === 'image_url') {
      const inline = inlineDataPart(getString(asRecord(part)?.image_url, 'url'))
      if (inline) parts.push(inline)
      continue
    }
    logger.debug({ type }, 'dropping unsupported content part')
  }
  return parts
}

function assistantParts(message: ChatMessage): Part[] {
  const parts: Part[] = []
  const text = textFromContent(message.content)
  if (text) parts.push({ text })
  for (const call of message.tool_calls ?? []) {
    parts.push({
      functionCall: { name: call.function.name, args: safeParseArguments(call.function.arguments) },
      thoughtSignature: THOUGHT_SIGNATURE,
    })
  }
  return parts
}

// Cloud Code needs inline base64; remote image URLs aren't supported here (Hermes drops them too).
function inlineDataPart(url: string | undefined): Part | undefined {
  if (!url) return undefined
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (!dataUrl) return undefined
  return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } }
}

function convertTools(
  tools: ChatCompletionRequest['tools'],
): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const functionDeclarations = tools.map((tool) => {
    const fn = asRecord(asRecord(tool)?.function)
    const declaration: Record<string, unknown> = {
      name: getString(fn, 'name') ?? '',
      parameters: sanitizeSchema(fn?.parameters),
    }
    const description = getString(fn, 'description')
    if (description) declaration.description = description
    return declaration
  })
  return [{ functionDeclarations }]
}

function convertToolChoice(
  toolChoice: ChatCompletionRequest['tool_choice'],
): Record<string, unknown> | undefined {
  if (toolChoice === undefined) return undefined
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  const name = getString(asRecord(toolChoice)?.function, 'name')
  return name ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } } : undefined
}

function buildGenerationConfig(request: ChatCompletionRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (request.temperature !== undefined) config.temperature = request.temperature
  if (request.top_p !== undefined) config.topP = request.top_p
  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined && maxTokens > 0) config.maxOutputTokens = maxTokens
  return config
}

function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const record = asRecord(schema)
  if (!record) return { type: 'object', properties: {} }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties') {
      result.properties = sanitizeProperties(value)
      continue
    }
    if (key === 'items') {
      result.items = sanitizeSchema(value)
      continue
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      result.anyOf = value.map((entry) => sanitizeSchema(entry))
      continue
    }
    result[key] = value
  }

  // Gemini requires string enum entries; drop a non-string enum on numeric/boolean types.
  const type = result.type
  const numericOrBool = type === 'integer' || type === 'number' || type === 'boolean'
  if (
    numericOrBool &&
    Array.isArray(result.enum) &&
    result.enum.some((e) => typeof e !== 'string')
  ) {
    result.enum = undefined
  }

  return Object.keys(result).length > 0 ? result : { type: 'object', properties: {} }
}

function sanitizeProperties(value: unknown): Record<string, unknown> {
  const props = asRecord(value)
  if (!props) return {}
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(props)) out[key] = sanitizeSchema(schema)
  return out
}

function toResponseObject(content: ChatMessage['content']): Record<string, unknown> {
  const text = textFromContent(content) ?? ''
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    // not JSON — wrap the raw text below
  }
  return { output: text }
}

function textFromContent(content: ChatMessage['content']): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .filter((part) => getString(part, 'type') === 'text')
    .map((part) => getString(part, 'text') ?? '')
    .join('')
}

function safeParseArguments(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}
