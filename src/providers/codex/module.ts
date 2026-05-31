import { responsesTranslator } from '../../translate/responses'
import type { ProviderModule } from '../types'
import { CODEX_MODELS } from './models'
import { codexAuthProvider } from './oauth'
import { codexTransport } from './transport'

export const codexModule: ProviderModule = {
  id: 'openai-codex',
  auth: codexAuthProvider,
  translator: responsesTranslator,
  transport: codexTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: true },
  listModels: async () => CODEX_MODELS,
}
