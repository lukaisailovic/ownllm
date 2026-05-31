import type { AuthProvider } from '../providers/types'
import type { Credential } from './credential'
import { AuthError } from './errors'
import type { AuthStore } from './store'

const MIN_REFRESH_INTERVAL_MS = 10_000

type RefreshReason = 'proactive' | 'reactive'

// Coordinates token refresh so concurrent callers never rotate the refresh_token in parallel
// (which would mutually invalidate them -> forced re-login). Two layers of protection:
//   - in-process: one in-flight Promise per provider; concurrent callers await it
//   - cross-process: AuthStore.update holds a file lock and re-reads under it (double-check)
export class RefreshManager {
  private readonly inflight = new Map<string, Promise<Credential>>()

  constructor(
    private readonly store: AuthStore,
    private readonly providers: Map<string, AuthProvider>,
  ) {}

  // Hot path: return the stored credential if still valid, otherwise refresh once.
  async ensureFresh(providerId: string): Promise<Credential> {
    const provider = this.requireProvider(providerId)
    const current = await this.store.getCredential(providerId)
    if (!current) {
      throw new AuthError(
        'credential_missing',
        `no credential for '${providerId}' (run: ownllm auth login ${providerId})`,
      )
    }
    if (!provider.isExpired(current)) return current
    return this.coalesce(providerId, provider, 'proactive')
  }

  // Reactive path (used by the 401 retry-once): refresh even if the clock says valid, but the
  // min-interval guard refuses if we just rotated, so a stale-server 401 can't burn a rotation.
  async refreshAfterUnauthorized(providerId: string): Promise<Credential> {
    return this.coalesce(providerId, this.requireProvider(providerId), 'reactive')
  }

  private coalesce(
    providerId: string,
    provider: AuthProvider,
    reason: RefreshReason,
  ): Promise<Credential> {
    const existing = this.inflight.get(providerId)
    if (existing) return existing
    const promise = this.refresh(providerId, provider, reason).finally(() =>
      this.inflight.delete(providerId),
    )
    this.inflight.set(providerId, promise)
    return promise
  }

  private refresh(
    providerId: string,
    provider: AuthProvider,
    reason: RefreshReason,
  ): Promise<Credential> {
    return this.store.update(providerId, async (current) => {
      if (!current) {
        throw new AuthError('credential_missing', `no credential for '${providerId}'`)
      }
      if (reason === 'proactive' && !provider.isExpired(current)) return current
      if (reason === 'reactive' && refreshedWithinGuard(current)) {
        throw new AuthError(
          'refresh_too_soon',
          `credential for '${providerId}' was refreshed in the last ${MIN_REFRESH_INTERVAL_MS / 1000}s`,
        )
      }
      return provider.refresh(current)
    })
  }

  private requireProvider(providerId: string): AuthProvider {
    const provider = this.providers.get(providerId)
    if (!provider) throw new AuthError('oauth_error', `unknown provider '${providerId}'`)
    return provider
  }
}

function refreshedWithinGuard(credential: Credential): boolean {
  if (!credential.lastRefresh) return false
  const last = Date.parse(credential.lastRefresh)
  return Number.isFinite(last) && Date.now() - last < MIN_REFRESH_INTERVAL_MS
}
