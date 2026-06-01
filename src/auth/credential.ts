import { inspect } from 'node:util'

// Persisted shape. expires_at is an ABSOLUTE epoch in SECONDS, normalized at store time
// (see PLAN §7) so expiry checks never depend on a fixed-window assumption.
export interface CredentialData {
  type: 'oauth'
  access_token: string
  refresh_token: string
  id_token?: string
  expires_at: number
  last_refresh?: string
  account_id?: string // codex
  auth_mode?: string // codex, copilot
  sub?: string // xai
  email?: string // xai
  token_endpoint?: string // xai
  project_id?: string // gemini (Cloud Code Assist project)
}

export interface CredentialSummary {
  email?: string
  account_id?: string
  expires_at: number
  seconds_until_expiry: number
  expired: boolean
  access_token_last4: string
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function last4(token: string): string {
  return token.length <= 4 ? '****' : token.slice(-4)
}

// Wraps credential data with redaction: toJSON / util.inspect never expose secrets, so an
// accidental log or JSON.stringify can't leak tokens. Persistence goes through toStored().
export class Credential {
  constructor(private readonly data: CredentialData) {}

  get accessToken(): string {
    return this.data.access_token
  }
  get refreshToken(): string {
    return this.data.refresh_token
  }
  get idToken(): string | undefined {
    return this.data.id_token
  }
  get expiresAt(): number {
    return this.data.expires_at
  }
  get lastRefresh(): string | undefined {
    return this.data.last_refresh
  }
  get accountId(): string | undefined {
    return this.data.account_id
  }
  get email(): string | undefined {
    return this.data.email
  }
  get sub(): string | undefined {
    return this.data.sub
  }
  get tokenEndpoint(): string | undefined {
    return this.data.token_endpoint
  }
  get projectId(): string | undefined {
    return this.data.project_id
  }

  isExpired(skewSeconds: number, now = nowSeconds()): boolean {
    return now + skewSeconds >= this.data.expires_at
  }

  toStored(): CredentialData {
    return { ...this.data }
  }

  summary(now = nowSeconds()): CredentialSummary {
    return {
      email: this.data.email,
      account_id: this.data.account_id,
      expires_at: this.data.expires_at,
      seconds_until_expiry: this.data.expires_at - now,
      expired: this.isExpired(0, now),
      access_token_last4: last4(this.data.access_token),
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      type: 'oauth',
      expires_at: this.data.expires_at,
      last_refresh: this.data.last_refresh,
      email: this.data.email,
      account_id: this.data.account_id,
      access_token: '***',
      refresh_token: '***',
      id_token: this.data.id_token ? '***' : undefined,
      token_endpoint: this.data.token_endpoint,
    }
  }

  [INSPECT](): string {
    return `Credential ${inspect(this.toJSON())}`
  }
}
