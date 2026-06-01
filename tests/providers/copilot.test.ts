import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import {
  COPILOT_MODELS,
  discoverCopilotModels,
  parseModelList,
} from '../../src/providers/copilot/models'
import { copilotAuthProvider } from '../../src/providers/copilot/oauth'
import { copilotTransport } from '../../src/providers/copilot/transport'
import { getProvider } from '../../src/providers/registry'
import { resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'
import { ctx } from '../support/responses'

const CONFIG_YAML = `
server: { host: 127.0.0.1, api_key: test-key }
providers:
  copilot: { enabled: true }
models:
  gpt-4.1: { provider: copilot, upstream: gpt-4.1 }
`

const credential = new Credential({
  type: 'oauth',
  access_token: 'CT',
  refresh_token: 'gho_durable',
  expires_at: 9_999_999_999,
  auth_mode: 'copilot',
})

describe('copilot transport', () => {
  it('sends the bearer token plus the editor/integration headers that gate the endpoint', () => {
    const headers = copilotTransport.headers(credential, ctx())
    expect(headers.authorization).toBe('Bearer CT')
    expect(headers['editor-version']).toBe('vscode/1.104.1')
    expect(headers['copilot-integration-id']).toBe('vscode-chat')
    expect(headers['x-initiator']).toBe('agent')
    expect(headers.accept).toBe('text/event-stream')
  })

  it('targets the Copilot chat completions endpoint and pins the host', () => {
    expect(copilotTransport.endpoint(ctx())).toBe('https://api.githubcopilot.com/chat/completions')
    expect(copilotTransport.hosts).toEqual(['api.githubcopilot.com'])
  })

  it('classifies 401 as credential_expired and 429 as rate limit', () => {
    expect(copilotTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(copilotTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })
})

describe('copilot models', () => {
  it('parses an upstream /models list', () => {
    expect(parseModelList({ data: [{ id: 'gpt-4.1' }, { id: 'o4-mini' }] })).toEqual([
      { id: 'gpt-4.1' },
      { id: 'o4-mini' },
    ])
  })

  it('returns the static catalog without a credential', async () => {
    expect(await discoverCopilotModels()).toBe(COPILOT_MODELS)
  })
})

describe('copilot auth', () => {
  it('applies a refresh skew to the short-lived Copilot token', () => {
    const nearlyExpired = new Credential({
      type: 'oauth',
      access_token: 'CT',
      refresh_token: 'gho_durable',
      expires_at: Math.floor(Date.now() / 1000) + 60,
    })
    expect(copilotAuthProvider.isExpired(nearlyExpired)).toBe(true)
    expect(copilotAuthProvider.isExpired(credential)).toBe(false)
    expect(copilotAuthProvider.id).toBe('copilot')
  })
})

describe('copilot routing', () => {
  it('is registered under its id and alias and resolves through the router', () => {
    expect(getProvider('copilot')?.id).toBe('copilot')
    expect(getProvider('github-copilot')?.id).toBe('copilot')
    expect(resolveModel(testConfig(CONFIG_YAML), 'gpt-4.1')).toMatchObject({
      providerId: 'copilot',
      upstreamModel: 'gpt-4.1',
    })
  })
})
