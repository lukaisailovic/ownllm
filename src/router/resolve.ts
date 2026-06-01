import type { Config, ReasoningEffort } from '../config/schema'

export interface ResolvedRoute {
  providerId: string
  upstreamModel: string
  reasoningEffort?: ReasoningEffort
}

export interface ResolvedCandidate {
  model: string
  route: ResolvedRoute
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

// The ordered list of candidates to try for a request: the requested model, then its own
// `fallbacks` in declaration order. Fallbacks are NOT expanded transitively — a fallback's own
// fallbacks are never followed, so `a -> [b]` with `b -> [a]` resolves to `[a, b]` and stops, never
// looping back. Duplicates (incl. a model listing itself) collapse. An empty result means the
// requested model is not in the routing table.
export function resolveChain(config: Config, model: string): ResolvedCandidate[] {
  const names = [model, ...(config.models[model]?.fallbacks ?? [])]
  const chain: ResolvedCandidate[] = []
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const route = resolveModel(config, name)
    if (route) chain.push({ model: name, route })
  }

  return chain
}
