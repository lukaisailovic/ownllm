import type { Credential } from '../../auth/credential'
import { asRecord, getString } from '../../util/json'
import type { ModelInfo } from '../types'

const MODELS_URL = 'https://api.githubcopilot.com/models'
const EDITOR_VERSION = 'vscode/1.104.1'

// Copilot's Chat Completions models. ownllm routes only the Chat Completions subset here (GPT-5 and
// Claude on Copilot speak Responses / Anthropic wire formats); `ownllm models` discovers the live
// per-account catalog.
export const COPILOT_MODELS: ModelInfo[] = [{ id: 'gpt-4.1' }, { id: 'gpt-4o' }, { id: 'o4-mini' }]

export function parseModelList(body: unknown): ModelInfo[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) => getString(entry, 'id'))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }))
}

export async function discoverCopilotModels(credential?: Credential): Promise<ModelInfo[]> {
  if (!credential) return COPILOT_MODELS
  const res = await fetch(MODELS_URL, {
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'editor-version': EDITOR_VERSION,
      'copilot-integration-id': 'vscode-chat',
    },
  })
  if (!res.ok) return COPILOT_MODELS
  const models = parseModelList(await res.json())
  return models.length > 0 ? models : COPILOT_MODELS
}
