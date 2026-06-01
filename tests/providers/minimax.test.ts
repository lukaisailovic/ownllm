import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import { minimaxAuthProvider } from '../../src/providers/minimax/oauth'
import { minimaxTransport } from '../../src/providers/minimax/transport'
import { getProvider } from '../../src/providers/registry'
import { resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'
import { ctx } from '../support/responses'

const CONFIG_YAML = `
server: { host: 127.0.0.1, api_key: test-key }
providers:
  minimax: { enabled: true }
models:
  minimax: { provider: minimax, upstream: MiniMax-M2 }
`

const credential = new Credential({
  type: 'oauth',
  access_token: 'MT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
})

describe('minimax transport', () => {
  it('targets the Anthropic-compatible endpoint with a bearer + anthropic-version header', () => {
    const headers = minimaxTransport.headers(credential, ctx())
    expect(headers.authorization).toBe('Bearer MT')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(minimaxTransport.endpoint(ctx())).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(minimaxTransport.hosts).toEqual(['api.minimax.io'])
  })

  it('classifies 401 as credential_expired and 429 as rate limit', () => {
    expect(minimaxTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(minimaxTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })
})

describe('minimax auth + routing', () => {
  it('applies a refresh skew and registers under its id + alias', () => {
    const nearlyExpired = new Credential({
      type: 'oauth',
      access_token: 'MT',
      refresh_token: 'RT',
      expires_at: Math.floor(Date.now() / 1000) + 30,
    })
    expect(minimaxAuthProvider.isExpired(nearlyExpired)).toBe(true)
    expect(minimaxAuthProvider.isExpired(credential)).toBe(false)
    expect(getProvider('minimax')?.id).toBe('minimax')
    expect(getProvider('minimax-oauth')?.id).toBe('minimax')
  })

  it('uses the Anthropic translator and resolves through the router', () => {
    expect(getProvider('minimax')?.translator.toUpstream).toBeDefined()
    expect(resolveModel(testConfig(CONFIG_YAML), 'minimax')).toMatchObject({
      providerId: 'minimax',
      upstreamModel: 'MiniMax-M2',
    })
  })
})
