import type { ProviderModule } from '../types'
import { claudeAuthProvider } from './auth'
import { CLAUDE_MODELS } from './models'
import { claudeTranslator } from './translator'
import { claudeTransport } from './transport'

export const claudeModule: ProviderModule = {
  id: 'claude',
  aliases: ['claude-code'],
  auth: claudeAuthProvider,
  translator: claudeTranslator,
  transport: claudeTransport,
  capabilities: { stream: true, tools: false, vision: false, reasoning: false },
  listModels: async () => CLAUDE_MODELS,
}
