import { responsesTranslator } from '../../translate/responses'
import type { ProviderModule } from '../types'
import { discoverXaiModels } from './models'
import { xaiAuthProvider } from './oauth'
import { xaiTransport } from './transport'

export const xaiModule: ProviderModule = {
  id: 'xai',
  auth: xaiAuthProvider,
  translator: responsesTranslator,
  transport: xaiTransport,
  capabilities: { stream: true, tools: true, vision: true, reasoning: true },
  listModels: discoverXaiModels,
}
