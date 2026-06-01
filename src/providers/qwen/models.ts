import type { Credential } from '../../auth/credential'
import { asRecord, getString } from '../../util/json'
import type { ModelInfo } from '../types'

const MODELS_URL = 'https://portal.qwen.ai/v1/models'

// Qwen portal coding models; `ownllm models` discovers the live catalog when a credential is set.
export const QWEN_MODELS: ModelInfo[] = [{ id: 'qwen3-coder-plus' }, { id: 'qwen3-coder-flash' }]

export function parseModelList(body: unknown): ModelInfo[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) => getString(entry, 'id'))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }))
}

export async function discoverQwenModels(credential?: Credential): Promise<ModelInfo[]> {
  if (!credential) return QWEN_MODELS
  const res = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${credential.accessToken}` },
  })
  if (!res.ok) return QWEN_MODELS
  const models = parseModelList(await res.json())
  return models.length > 0 ? models : QWEN_MODELS
}
