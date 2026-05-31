import type { Config, ReasoningEffort } from '../config/schema'

export interface ResolvedRoute {
  providerId: string
  upstreamModel: string
  reasoningEffort?: ReasoningEffort
}

// Exact-match, case-sensitive lookup of a requested model in the config routing table.
export function resolveModel(config: Config, model: string): ResolvedRoute | undefined {
  const route = config.models[model]
  if (!route) return undefined
  return {
    providerId: route.provider,
    upstreamModel: route.upstream,
    reasoningEffort: route.reasoning_effort,
  }
}
