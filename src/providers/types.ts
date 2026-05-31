import type { Credential } from '../auth/credential'

export interface LoginContext {
  signal?: AbortSignal
  report(message: string): void
}

// An AuthProvider owns one provider's OAuth lifecycle: interactive login, token refresh, and the
// expiry policy (provider-specific clock skew). The rest of llmgate treats credentials opaquely.
export interface AuthProvider {
  readonly id: string
  login(ctx: LoginContext): Promise<Credential>
  refresh(credential: Credential): Promise<Credential>
  isExpired(credential: Credential): boolean
}
