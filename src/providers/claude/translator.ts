import { chatToCompletion } from '../../translate/chat/response'
import { chatToChunks } from '../../translate/chat/stream'
import type { ChatCompletionRequest, ChatMessage, Translator } from '../../translate/types'
import { asRecord, getString } from '../../util/json'

export interface ClaudeCliRequest {
  model: string
  prompt: string
}

export const claudeTranslator: Translator = {
  toUpstream(request, ctx): ClaudeCliRequest {
    return {
      model: ctx.upstreamModel,
      prompt: buildClaudePrompt(request),
    }
  },
  fromUpstream: chatToCompletion,
  streamToChunks: chatToChunks,
}

export function buildClaudePrompt(request: ChatCompletionRequest): string {
  return request.messages.map(formatMessage).filter(Boolean).join('\n\n')
}

function formatMessage(message: ChatMessage): string {
  const content = messageText(message)
  const toolCalls = formatToolCalls(message)
  const parts = [content, toolCalls].filter(Boolean)
  if (parts.length === 0) return ''
  return `${message.role.toUpperCase()}:\n${parts.join('\n')}`
}

function messageText(message: ChatMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'image_url') {
        const imageUrl = asRecord(asRecord(part)?.image_url)
        return `[image: ${getString(imageUrl, 'url') ?? ''}]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function formatToolCalls(message: ChatMessage): string {
  if (!message.tool_calls?.length) return ''
  return message.tool_calls
    .map((call) => `Tool call ${call.id}: ${call.function.name}(${call.function.arguments})`)
    .join('\n')
}
