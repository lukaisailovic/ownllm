import type { Translator } from '../types'
import { buildAnthropicRequest } from './request'
import { anthropicToCompletion } from './response'
import { anthropicToChunks } from './stream'

// Translator for providers that speak the Anthropic Messages API upstream (MiniMax). Provider-only
// wire quirks (auth header shape, anthropic-version) live in the transport, not here.
export const anthropicTranslator: Translator = {
  toUpstream: buildAnthropicRequest,
  fromUpstream: anthropicToCompletion,
  streamToChunks: anthropicToChunks,
}
