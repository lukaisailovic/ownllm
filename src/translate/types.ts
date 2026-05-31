import { z } from 'zod'
import type { ReasoningEffort } from '../config/schema'

const TextContentPart = z.object({ type: z.literal('text'), text: z.string() })

const ImageContentPart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }),
})

// Unknown part types are accepted here and handled (dropped + debug-logged) by the translator.
const ContentPart = z.union([
  TextContentPart,
  ImageContentPart,
  z.object({ type: z.string() }).passthrough(),
])

const MessageContent = z.union([z.string(), z.array(ContentPart), z.null()])

const ToolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
})

const Message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: MessageContent.optional(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
})

const Tool = z.object({ type: z.string() }).passthrough()

const ToolChoice = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
])

// Permissive on purpose: unknown params pass through (the param policy decides ignore vs 400), so a
// newer client field never hard-fails validation.
export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(Message).min(1),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
    seed: z.number().int().optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: z.number().int().optional(),
    user: z.string().optional(),
    response_format: z.unknown().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    tools: z.array(Tool).optional(),
    tool_choice: ToolChoice.optional(),
  })
  .passthrough()

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>
export type ChatMessage = z.infer<typeof Message>
export type ChatContentPart = z.infer<typeof ContentPart>
export type ChatToolCall = z.infer<typeof ToolCall>

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ResponseToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: { role: 'assistant'; content: string | null; tool_calls?: ResponseToolCall[] }
    finish_reason: FinishReason | null
  }[]
  usage?: Usage
}

export interface ChunkToolCall {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: { role?: 'assistant'; content?: string; tool_calls?: ChunkToolCall[] }
    finish_reason: FinishReason | null
  }[]
  usage?: Usage | null
}

// A parsed upstream Server-Sent Event.
export interface SSEvent {
  event?: string
  data: string
}

// Per-request context threaded into the translator: the requested model is echoed back to the
// client, conversationId pins the upstream prompt cache, includeUsage is captured from the original
// request before sanitize strips stream_options.
export interface TranslateContext {
  requestedModel: string
  upstreamModel: string
  conversationId: string
  includeUsage: boolean
  reasoningEffort?: ReasoningEffort
}

// FORMAT-AGNOSTIC translator between Chat Completions and a provider's native wire format.
// Because ownllm always streams upstream, fromUpstream consumes the event stream and aggregates
// (rather than taking a pre-assembled body).
export interface Translator {
  toUpstream(request: ChatCompletionRequest, ctx: TranslateContext): unknown
  fromUpstream(
    events: AsyncIterable<SSEvent>,
    ctx: TranslateContext,
  ): Promise<ChatCompletionResponse>
  streamToChunks(
    events: AsyncIterable<SSEvent>,
    ctx: TranslateContext,
  ): AsyncIterable<ChatCompletionChunk>
}
