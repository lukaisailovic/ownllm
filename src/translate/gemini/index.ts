import type { Translator } from '../types'
import { buildGeminiRequest } from './request'
import { geminiToCompletion } from './response'
import { geminiToChunks } from './stream'

// Translator for Google's Cloud Code Assist generateContent wire format (Gemini). The transport
// folds the per-credential `project` into the body and supplies the gemini-cli header fingerprint.
export const geminiTranslator: Translator = {
  toUpstream: buildGeminiRequest,
  fromUpstream: geminiToCompletion,
  streamToChunks: geminiToChunks,
}
