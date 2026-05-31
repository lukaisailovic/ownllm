import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import { codexTransport } from '../../src/providers/codex/transport'
import { getProvider } from '../../src/providers/registry'
import { ctx } from '../support/responses'

const credential = new Credential({
  type: 'oauth',
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
  account_id: 'acct_9',
})

describe('codex provider', () => {
  it('is registered in the provider registry', () => {
    const module = getProvider('openai-codex')
    expect(module?.id).toBe('openai-codex')
    expect(module?.capabilities).toMatchObject({ stream: true, tools: true })
  })

  it('builds Codex headers and omits OpenAI-Beta', () => {
    const headers = codexTransport.headers(credential, ctx({ conversationId: 'sess-1' }))
    expect(headers.authorization).toBe('Bearer AT')
    expect(headers.originator).toBe('codex_cli_rs')
    expect(headers['chatgpt-account-id']).toBe('acct_9')
    expect(headers['session-id']).toBe('sess-1')
    expect(headers['user-agent']).toContain('codex_cli_rs/')
    expect('openai-beta' in headers).toBe(false)
  })

  it('classifies a Cloudflare 403 as a transport block (502)', () => {
    const headers = new Headers({ server: 'cloudflare', 'content-type': 'text/html' })
    const error = codexTransport.classifyError(403, headers, '<html>Just a moment...</html>')
    expect(error.status).toBe(502)
    expect(error.code).toBe('codex_cloudflare_blocked')
  })

  it('classifies 401 as credential_expired and 429 as rate limit (with retry-after)', () => {
    expect(codexTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    const rateLimit = codexTransport.classifyError(429, new Headers({ 'retry-after': '5' }), '')
    expect(rateLimit.status).toBe(429)
    expect(rateLimit.headers['retry-after']).toBe('5')
  })

  it('adds store:false in sanitizeBody', () => {
    expect(codexTransport.sanitizeBody?.({ input: [] }, ctx())).toEqual({ input: [], store: false })
  })
})
