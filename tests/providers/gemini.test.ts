import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import { geminiAuthProvider } from '../../src/providers/gemini/oauth'
import { geminiTransport } from '../../src/providers/gemini/transport'
import { getProvider } from '../../src/providers/registry'
import { resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'
import { ctx } from '../support/responses'

const CONFIG_YAML = `
server: { host: 127.0.0.1, api_key: test-key }
providers:
  gemini: { enabled: true }
models:
  gemini-2.5-pro: { provider: gemini, upstream: gemini-2.5-pro }
`

const credential = new Credential({
  type: 'oauth',
  access_token: 'GT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
  project_id: 'proj-123',
  auth_mode: 'gemini',
})

describe('gemini transport', () => {
  it('targets streamGenerateContent with the gemini-cli fingerprint headers', () => {
    const headers = geminiTransport.headers(credential, ctx())
    expect(headers.authorization).toBe('Bearer GT')
    expect(headers['user-agent']).toBe('google-api-nodejs-client/9.15.1 (gzip)')
    expect(headers['x-goog-api-client']).toBe('gl-node/24.0.0')
    expect(geminiTransport.endpoint(ctx())).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    )
    expect(geminiTransport.hosts).toEqual(['cloudcode-pa.googleapis.com'])
  })

  it("folds the credential's project id into the request envelope", () => {
    const body = geminiTransport.sanitizeBody?.(
      { model: 'gemini-2.5-pro', request: { contents: [] } },
      ctx(),
      credential,
    )
    expect(body).toEqual({
      model: 'gemini-2.5-pro',
      request: { contents: [] },
      project: 'proj-123',
    })
  })

  it('classifies 401 as credential_expired and 429 as rate limit', () => {
    expect(geminiTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(geminiTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })
})

describe('gemini auth + routing', () => {
  it('applies a refresh skew and registers under its id + aliases', () => {
    const nearlyExpired = new Credential({
      type: 'oauth',
      access_token: 'GT',
      refresh_token: 'RT',
      expires_at: Math.floor(Date.now() / 1000) + 30,
    })
    expect(geminiAuthProvider.isExpired(nearlyExpired)).toBe(true)
    expect(geminiAuthProvider.isExpired(credential)).toBe(false)
    expect(getProvider('gemini')?.id).toBe('gemini')
    expect(getProvider('google-gemini-cli')?.id).toBe('gemini')
    expect(getProvider('google')?.id).toBe('gemini')
  })

  it('uses the Gemini translator and resolves through the router', () => {
    expect(getProvider('gemini')?.translator.toUpstream).toBeDefined()
    expect(resolveModel(testConfig(CONFIG_YAML), 'gemini-2.5-pro')).toMatchObject({
      providerId: 'gemini',
      upstreamModel: 'gemini-2.5-pro',
    })
  })
})
