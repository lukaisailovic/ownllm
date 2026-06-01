import type { ModelInfo } from '../types'

// MiniMax's Anthropic endpoint has no standard catalog probe; this is the known static default,
// overridable per route in config.
export const MINIMAX_MODELS: ModelInfo[] = [{ id: 'MiniMax-M2' }]
