import type { ModelInfo } from '../types'

// Codex models are server-driven; this is the known static catalog (overridable defaults).
export const CODEX_MODELS: ModelInfo[] = [{ id: 'gpt-5' }, { id: 'gpt-5-codex' }]
