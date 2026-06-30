import { randomUUID } from 'node:crypto'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChunkToolCall,
  TranslateContext,
  Usage,
} from '../types'

// One Responses-API SSE frame: a typed `event:` line plus its JSON `data:` line.
export interface ResponseSSEFrame {
  event: string
  data: string
}

type ResponseStatus = 'in_progress' | 'completed' | 'incomplete'

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function responseUsage(usage?: Usage): Record<string, unknown> | null {
  if (!usage) return null
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function outputText(output: Record<string, unknown>[]): string {
  let text = ''
  for (const item of output) {
    if (item.type !== 'message') continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
    }
  }
  return text
}

function buildResponse(opts: {
  id: string
  created: number
  status: ResponseStatus
  model: string
  output: Record<string, unknown>[]
  usage: Record<string, unknown> | null
}): Record<string, unknown> {
  return {
    id: opts.id,
    object: 'response',
    created_at: opts.created,
    status: opts.status,
    model: opts.model,
    output: opts.output,
    ...(opts.status !== 'in_progress' ? { output_text: outputText(opts.output) } : {}),
    usage: opts.usage,
    error: null,
    incomplete_details: opts.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
  }
}

// CC aggregated completion -> a Responses API `response` object (non-streaming). The inverse of
// ./response.ts.
export function completionToResponse(
  completion: ChatCompletionResponse,
  ctx: TranslateContext,
): Record<string, unknown> {
  const choice = completion.choices[0]
  const message = choice?.message
  const output: Record<string, unknown>[] = []

  if (message?.content) {
    output.push({
      type: 'message',
      id: prefixedId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    })
  }

  for (const call of message?.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      id: prefixedId('fc'),
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    })
  }

  const status: ResponseStatus = choice?.finish_reason === 'length' ? 'incomplete' : 'completed'

  return buildResponse({
    id: prefixedId('resp'),
    created: completion.created,
    status,
    model: ctx.requestedModel,
    output,
    usage: responseUsage(completion.usage),
  })
}

interface MessageState {
  id: string
  text: string
  index: number
  done: boolean
}

interface ToolState {
  id: string
  callId: string
  name: string
  args: string
  index: number
}

// CC streaming chunks -> the Responses API typed SSE event sequence. The inverse of ./stream.ts.
export async function* streamCompletionToResponses(
  chunks: AsyncIterable<ChatCompletionChunk>,
  ctx: TranslateContext,
): AsyncGenerator<ResponseSSEFrame> {
  const responseId = prefixedId('resp')
  const created = Math.floor(Date.now() / 1000)
  let sequence = 0

  const frame = (event: string, payload: Record<string, unknown>): ResponseSSEFrame => ({
    event,
    data: JSON.stringify({ type: event, sequence_number: sequence++, ...payload }),
  })

  let outputIndex = 0
  let message: MessageState | undefined
  const tools = new Map<number, ToolState>()
  const toolOrder: number[] = []
  let finishReason: ChatCompletionChunk['choices'][number]['finish_reason'] = 'stop'
  let usage: Usage | undefined

  function* openMessage(): Generator<ResponseSSEFrame> {
    if (message) return
    message = { id: prefixedId('msg'), text: '', index: outputIndex++, done: false }
    const item = {
      type: 'message',
      id: message.id,
      status: 'in_progress',
      role: 'assistant',
      content: [],
    }
    yield frame('response.output_item.added', { output_index: message.index, item })
    yield frame('response.content_part.added', {
      item_id: message.id,
      output_index: message.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
  }

  function* finishMessage(): Generator<ResponseSSEFrame> {
    if (!message || message.done) return
    message.done = true
    yield frame('response.output_text.done', {
      item_id: message.id,
      output_index: message.index,
      content_index: 0,
      text: message.text,
    })
    yield frame('response.content_part.done', {
      item_id: message.id,
      output_index: message.index,
      content_index: 0,
      part: { type: 'output_text', text: message.text, annotations: [] },
    })
    yield frame('response.output_item.done', {
      output_index: message.index,
      item: {
        type: 'message',
        id: message.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: message.text, annotations: [] }],
      },
    })
  }

  function* openTool(ccIndex: number, header: ChunkToolCall): Generator<ResponseSSEFrame> {
    const tool: ToolState = {
      id: prefixedId('fc'),
      callId: header.id ?? '',
      name: header.function?.name ?? '',
      args: '',
      index: outputIndex++,
    }
    tools.set(ccIndex, tool)
    toolOrder.push(ccIndex)
    yield frame('response.output_item.added', {
      output_index: tool.index,
      item: {
        type: 'function_call',
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: '',
        status: 'in_progress',
      },
    })
  }

  function* finishTool(tool: ToolState): Generator<ResponseSSEFrame> {
    yield frame('response.function_call_arguments.done', {
      item_id: tool.id,
      output_index: tool.index,
      arguments: tool.args,
    })
    yield frame('response.output_item.done', {
      output_index: tool.index,
      item: {
        type: 'function_call',
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.args,
        status: 'completed',
      },
    })
  }

  const inProgress = buildResponse({
    id: responseId,
    created,
    status: 'in_progress',
    model: ctx.requestedModel,
    output: [],
    usage: null,
  })
  yield frame('response.created', { response: inProgress })
  yield frame('response.in_progress', { response: inProgress })

  try {
    for await (const chunk of chunks) {
      const choice = chunk.choices[0]
      if (chunk.usage) usage = chunk.usage
      if (!choice) continue

      const delta = choice.delta
      if (delta.content) {
        yield* openMessage()
        if (message) {
          message.text += delta.content
          yield frame('response.output_text.delta', {
            item_id: message.id,
            output_index: message.index,
            content_index: 0,
            delta: delta.content,
          })
        }
      }

      for (const call of delta.tool_calls ?? []) {
        if (!tools.has(call.index)) {
          yield* finishMessage()
          yield* openTool(call.index, call)
        }
        const tool = tools.get(call.index)
        if (!tool) continue
        if (call.id) tool.callId = call.id
        if (call.function?.name) tool.name = call.function.name
        const args = call.function?.arguments
        if (args) {
          tool.args += args
          yield frame('response.function_call_arguments.delta', {
            item_id: tool.id,
            output_index: tool.index,
            delta: args,
          })
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  } finally {
    // PLAN §10: the terminal sequence runs on normal completion AND on a mid-stream upstream
    // failure — close any open items and emit response.completed (no error object post-first-byte,
    // no [DONE] sentinel). On failure the original error still propagates afterward, so the route
    // logs it just as the chat route does.
    yield* finishMessage()
    for (const ccIndex of toolOrder) {
      const tool = tools.get(ccIndex)
      if (tool) yield* finishTool(tool)
    }

    const status: ResponseStatus = finishReason === 'length' ? 'incomplete' : 'completed'
    const output: Record<string, unknown>[] = []
    if (message) {
      output.push({
        type: 'message',
        id: message.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: message.text, annotations: [] }],
      })
    }
    for (const ccIndex of toolOrder) {
      const tool = tools.get(ccIndex)
      if (!tool) continue
      output.push({
        type: 'function_call',
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.args,
        status: 'completed',
      })
    }

    yield frame('response.completed', {
      response: buildResponse({
        id: responseId,
        created,
        status,
        model: ctx.requestedModel,
        output,
        usage: responseUsage(usage),
      }),
    })
  }
}
