import type { Translator } from '../types'
import { buildChatRequest } from './request'
import { chatToCompletion } from './response'
import { chatToChunks } from './stream'

// Translator for providers that speak the OpenAI Chat Completions API upstream (Copilot, Qwen).
// Incoming and upstream share the wire format, so translation is a faithful forward plus edge
// aggregation; provider-specific quirks live in each provider's transport.sanitizeBody.
export const chatCompletionsTranslator: Translator = {
  toUpstream: buildChatRequest,
  fromUpstream: chatToCompletion,
  streamToChunks: chatToChunks,
}
