import type { Credential } from '../../auth/credential'
import { asRecord, getString } from '../../util/json'
import type { ModelInfo } from '../types'

const MODELS_URL = 'https://api.x.ai/v1/models'

// Grok Build model names churn (week-old beta); these are the seen defaults. `ownllm models
// --remote` discovers live values. (PLAN §9b / §3E.)
export const XAI_MODELS: ModelInfo[] = [
  { id: 'grok-build' },
  { id: 'grok-4.3' },
  { id: 'grok-4.20-0309-reasoning' },
  { id: 'grok-4.20-0309-non-reasoning' },
  { id: 'grok-4.20-multi-agent-0309' },
  { id: 'grok-3-mini' },
]

export function parseModelList(body: unknown): ModelInfo[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) => getString(entry, 'id'))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }))
}

export async function discoverXaiModels(credential?: Credential): Promise<ModelInfo[]> {
  if (!credential) return XAI_MODELS
  const res = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${credential.accessToken}` },
  })
  if (!res.ok) return XAI_MODELS
  const models = parseModelList(await res.json())
  return models.length > 0 ? models : XAI_MODELS
}
