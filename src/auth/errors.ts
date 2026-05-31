export type AuthErrorCode =
  | 'credential_missing' // no stored credential; user must log in
  | 'credential_dead' // invalid_grant / refresh_token reused; re-login required
  | 'tier_denied' // xAI 403; account not entitled to programmatic access
  | 'rate_limited' // 429 on a token endpoint; existing token still valid
  | 'refresh_too_soon' // reactive refresh blocked by min-interval guard
  | 'login_failed'
  | 'login_timeout'
  | 'login_cancelled'
  | 'oauth_error'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

function bodyErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>).error
  return typeof value === 'string' ? value : undefined
}

// Shared classification of a non-2xx token-endpoint response. Provider-specific cases (xAI 403
// tier gating, Codex Cloudflare on inference) are handled by the provider before calling this.
export function classifyTokenError(status: number, body: unknown): AuthError {
  const code = bodyErrorCode(body)
  if (code === 'invalid_grant' || code?.startsWith('refresh_token')) {
    return new AuthError('credential_dead', `token rejected (${code}); re-login required`)
  }
  if (status === 429) {
    return new AuthError('rate_limited', 'token endpoint rate limited', true)
  }
  return new AuthError(
    'oauth_error',
    `token endpoint returned ${status}${code ? ` (${code})` : ''}`,
  )
}
