import type { Translator } from '../types'
import { assembleResponse } from './assemble'
import { buildResponsesRequest } from './request'
import { responsesToCompletion } from './response'
import { responsesToChunks } from './stream'

export { deriveConversationId } from './conv-id'

// One Translator implementation of the OpenAI Responses format, shared by Codex and (P4) xAI.
export const responsesTranslator: Translator = {
  toUpstream: buildResponsesRequest,
  async fromUpstream(events, ctx) {
    return responsesToCompletion(await assembleResponse(events), ctx)
  },
  streamToChunks: responsesToChunks,
}
