import type { AuthStore } from '../auth/store'
import type { Config } from '../config/schema'

// /ready is true when config is valid (already enforced at load) AND at least one enabled provider
// has a stored credential. A merely-expired credential still counts — it refreshes on demand.
export function makeReadinessCheck(config: Config, store: AuthStore): () => Promise<boolean> {
  const enabledProviders = Object.entries(config.providers)
    .filter(([, provider]) => provider.enabled)
    .map(([id]) => id)

  return async () => {
    for (const id of enabledProviders) {
      if (await store.getCredential(id)) return true
    }
    return false
  }
}
