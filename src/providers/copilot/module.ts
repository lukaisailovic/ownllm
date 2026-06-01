import { chatCompletionsTranslator } from '../../translate/chat'
import type { ProviderModule } from '../types'
import { discoverCopilotModels } from './models'
import { copilotAuthProvider } from './oauth'
import { copilotTransport } from './transport'

export const copilotModule: ProviderModule = {
  id: 'copilot',
  aliases: ['github-copilot', 'github-models'],
  auth: copilotAuthProvider,
  translator: chatCompletionsTranslator,
  transport: copilotTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: true },
  listModels: discoverCopilotModels,
}
