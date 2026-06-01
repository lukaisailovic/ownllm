import type { ModelInfo } from '../types'

// Known Gemini models reachable through Cloud Code Assist; overridable per route in config.
export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash' },
  { id: 'gemini-3-pro-preview' },
  { id: 'gemini-3-flash-preview' },
]
