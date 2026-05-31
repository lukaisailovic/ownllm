import type { TranslateContext } from '../../translate/types'
import { asRecord, getString, omit } from '../../util/json'

// xAI quirks ONLY (PLAN §9b). The base translator already handled multimodal, response_format,
// reasoning_effort, tool flattening and max_tokens — none of that is repeated here.
const DROPPED_PARAMS = [
  'prompt_cache_retention',
  'previous_response_id',
  'safety_identifier',
  'stream_options',
]
const DROPPED_TOOL_TYPES = new Set(['apply_patch', 'tool_search', 'image_generation'])

export function sanitizeXaiResponsesBody(body: unknown, ctx: TranslateContext): unknown {
  const result: Record<string, unknown> = {
    ...omit(body as Record<string, unknown>, DROPPED_PARAMS),
    store: false,
    prompt_cache_key: ctx.conversationId,
  }

  const { input, instructions } = sanitizeInput(result.input)
  result.input = input
  if (instructions) {
    result.instructions = [result.instructions, instructions].filter(Boolean).join('\n\n')
  }

  // undefined here is dropped on JSON serialization, the same as removing the key.
  result.reasoning = sanitizeReasoning(result.reasoning, ctx.upstreamModel)

  if (Array.isArray(result.include)) {
    result.include = result.include.filter((entry) => entry !== 'reasoning.encrypted_content')
  }
  if (Array.isArray(result.tools)) result.tools = sanitizeTools(result.tools)

  return result
}

// Strips item ids (xAI rejects them) and defensively folds any system/developer message items back
// into top-level instructions.
function sanitizeInput(input: unknown): { input: unknown[]; instructions?: string } {
  if (!Array.isArray(input)) return { input: [] }

  const items: unknown[] = []
  const systemTexts: string[] = []
  for (const item of input) {
    const record = asRecord(item)
    if (!record) {
      items.push(item)
      continue
    }
    if (record.type === 'message' && (record.role === 'system' || record.role === 'developer')) {
      const text = messageItemText(record.content)
      if (text) systemTexts.push(text)
      continue
    }
    items.push(omit(record, ['id']))
  }

  return {
    input: items,
    instructions: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined,
  }
}

function messageItemText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part) => getString(part, 'text') ?? '').join('')
}

function sanitizeReasoning(
  reasoning: unknown,
  upstreamModel: string,
): Record<string, unknown> | undefined {
  if (!modelSupportsReasoning(upstreamModel)) return undefined
  const record = asRecord(reasoning)
  if (!record) return undefined

  const result = omit(record, ['summary'])
  if (result.effort === 'minimal') result.effort = 'low'
  return result
}

function modelSupportsReasoning(model: string): boolean {
  return (
    model.startsWith('grok-3-mini') ||
    model.startsWith('grok-4.20-multi-agent') ||
    model.startsWith('grok-4.3')
  )
}

function sanitizeTools(tools: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const tool of tools) {
    const record = asRecord(tool)
    if (!record) continue
    const type = record.type === 'custom' ? 'function' : record.type
    if (typeof type === 'string' && DROPPED_TOOL_TYPES.has(type)) continue

    const copy: Record<string, unknown> = { ...record, type }
    if (type === 'function' && copy.parameters === undefined) {
      copy.parameters = { type: 'object', properties: {} }
    }
    result.push(copy)
  }
  return result
}
