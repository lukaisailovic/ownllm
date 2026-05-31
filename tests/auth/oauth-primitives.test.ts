import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { classifyTokenError } from '../../src/auth/errors'
import { decodeJwtClaims, jwtExpirySeconds } from '../../src/auth/jwt'
import { createPkce, randomToken } from '../../src/auth/pkce'

function encodeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none' })}.${segment(payload)}.`
}

describe('createPkce', () => {
  it('derives an S256 challenge from the verifier', () => {
    const pkce = createPkce()
    expect(pkce.method).toBe('S256')
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
  })

  it('produces url-safe, unique verifiers', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier)
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('decodeJwtClaims', () => {
  it('decodes claims without verifying the signature', () => {
    expect(decodeJwtClaims(encodeJwt({ sub: 'u1', exp: 123 }))).toMatchObject({ sub: 'u1' })
    expect(jwtExpirySeconds(encodeJwt({ exp: 456 }))).toBe(456)
  })

  it('returns undefined for malformed tokens or a missing exp', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeUndefined()
    expect(jwtExpirySeconds(encodeJwt({ sub: 'no-exp' }))).toBeUndefined()
  })
})

describe('classifyTokenError', () => {
  it('marks invalid_grant and refresh_token_* as dead credentials', () => {
    expect(classifyTokenError(400, { error: 'invalid_grant' }).code).toBe('credential_dead')
    expect(classifyTokenError(400, { error: 'refresh_token_reused' }).code).toBe('credential_dead')
  })

  it('classifies 429 as a retryable rate limit', () => {
    const error = classifyTokenError(429, {})
    expect(error.code).toBe('rate_limited')
    expect(error.retryable).toBe(true)
  })

  it('falls back to a generic oauth_error', () => {
    expect(classifyTokenError(500, { raw: 'boom' }).code).toBe('oauth_error')
  })
})
