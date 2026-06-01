import { chatCompletionsTranslator } from '../../translate/chat'
import type { ProviderModule } from '../types'
import { discoverQwenModels } from './models'
import { qwenAuthProvider } from './oauth'
import { qwenTransport } from './transport'

export const qwenModule: ProviderModule = {
  id: 'qwen',
  aliases: ['qwen-oauth', 'qwen-portal'],
  auth: qwenAuthProvider,
  translator: chatCompletionsTranslator,
  transport: qwenTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: true },
  listModels: discoverQwenModels,
}
