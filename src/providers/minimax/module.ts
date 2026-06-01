import { anthropicTranslator } from '../../translate/anthropic'
import type { ProviderModule } from '../types'
import { MINIMAX_MODELS } from './models'
import { minimaxAuthProvider } from './oauth'
import { minimaxTransport } from './transport'

export const minimaxModule: ProviderModule = {
  id: 'minimax',
  aliases: ['minimax-oauth'],
  auth: minimaxAuthProvider,
  translator: anthropicTranslator,
  transport: minimaxTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: false },
  listModels: async () => MINIMAX_MODELS,
}
