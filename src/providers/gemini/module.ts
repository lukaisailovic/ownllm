import { geminiTranslator } from '../../translate/gemini'
import type { ProviderModule } from '../types'
import { GEMINI_MODELS } from './models'
import { geminiAuthProvider } from './oauth'
import { geminiTransport } from './transport'

export const geminiModule: ProviderModule = {
  id: 'gemini',
  aliases: ['google-gemini-cli', 'gemini-cli', 'google'],
  auth: geminiAuthProvider,
  translator: geminiTranslator,
  transport: geminiTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: true },
  listModels: async () => GEMINI_MODELS,
}
