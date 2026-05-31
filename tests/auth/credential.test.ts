import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Credential, type CredentialData } from '../../src/auth/credential'

function makeCredential(overrides: Partial<CredentialData> = {}): Credential {
  return new Credential({
    type: 'oauth',
    access_token: 'access-SECRET-7890',
    refresh_token: 'refresh-SECRET',
    id_token: 'id.token.value',
    expires_at: 2_000_000_000,
    email: 'user@example.com',
    ...overrides,
  })
}

describe('Credential redaction', () => {
  it('never exposes tokens through JSON.stringify', () => {
    const serialized = JSON.stringify(makeCredential())
    expect(serialized).not.toContain('access-SECRET-7890')
    expect(serialized).not.toContain('refresh-SECRET')
    expect(serialized).toContain('***')
  })

  it('never exposes tokens through util.inspect', () => {
    const text = inspect(makeCredential())
    expect(text).not.toContain('access-SECRET-7890')
    expect(text).not.toContain('refresh-SECRET')
  })

  it('preserves raw tokens for persistence via toStored', () => {
    expect(makeCredential().toStored().access_token).toBe('access-SECRET-7890')
  })

  it('summary exposes only last4 + non-secret identity', () => {
    const summary = makeCredential().summary()
    expect(summary.access_token_last4).toBe('7890')
    expect(summary.email).toBe('user@example.com')
    expect(JSON.stringify(summary)).not.toContain('access-SECRET')
  })
})

describe('Credential.isExpired', () => {
  const now = 1_000_000

  it('is not expired before the deadline minus skew', () => {
    expect(makeCredential({ expires_at: now + 1000 }).isExpired(120, now)).toBe(false)
  })

  it('is expired once now + skew reaches the deadline', () => {
    expect(makeCredential({ expires_at: now + 100 }).isExpired(120, now)).toBe(true)
  })

  it('is expired at the exact deadline', () => {
    expect(makeCredential({ expires_at: now }).isExpired(0, now)).toBe(true)
  })
})
