import { z } from 'zod'

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
