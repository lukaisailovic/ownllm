import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import { QWEN_MODELS, discoverQwenModels, parseModelList } from '../../src/providers/qwen/models'
import { qwenAuthProvider } from '../../src/providers/qwen/oauth'
import { qwenTransport } from '../../src/providers/qwen/transport'
import { getProvider } from '../../src/providers/registry'
import { resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'
import { ctx } from '../support/responses'

const CONFIG_YAML = `
server: { host: 127.0.0.1, api_key: test-key }
providers:
  qwen: { enabled: true }
models:
  qwen3-coder: { provider: qwen, upstream: qwen3-coder-plus }
`

const credential = new Credential({
  type: 'oauth',
  access_token: 'QT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
})

describe('qwen transport', () => {
  it('sends the bearer token to the OpenAI-compatible portal endpoint', () => {
    expect(qwenTransport.headers(credential, ctx()).authorization).toBe('Bearer QT')
    expect(qwenTransport.endpoint(ctx())).toBe('https://portal.qwen.ai/v1/chat/completions')
    expect(qwenTransport.hosts).toEqual(['portal.qwen.ai'])
  })

  it('classifies 401 as credential_expired and 429 as rate limit', () => {
    expect(qwenTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(qwenTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })
})

describe('qwen models', () => {
  it('parses an upstream /models list', () => {
    expect(parseModelList({ data: [{ id: 'qwen3-coder-plus' }] })).toEqual([
      { id: 'qwen3-coder-plus' },
    ])
  })

  it('returns the static catalog without a credential', async () => {
    expect(await discoverQwenModels()).toBe(QWEN_MODELS)
  })
})

describe('qwen auth + routing', () => {
  it('applies a refresh skew and registers under its id + aliases', () => {
    const nearlyExpired = new Credential({
      type: 'oauth',
      access_token: 'QT',
      refresh_token: 'RT',
      expires_at: Math.floor(Date.now() / 1000) + 60,
    })
    expect(qwenAuthProvider.isExpired(nearlyExpired)).toBe(true)
    expect(qwenAuthProvider.isExpired(credential)).toBe(false)
    expect(getProvider('qwen')?.id).toBe('qwen')
    expect(getProvider('qwen-oauth')?.id).toBe('qwen')
  })

  it('resolves through the router', () => {
    expect(resolveModel(testConfig(CONFIG_YAML), 'qwen3-coder')).toMatchObject({
      providerId: 'qwen',
      upstreamModel: 'qwen3-coder-plus',
    })
  })
})
