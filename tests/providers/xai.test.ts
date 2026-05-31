import { describe, expect, it } from 'vitest'
import { Credential } from '../../src/auth/credential'
import { getProvider } from '../../src/providers/registry'
import { XAI_MODELS, discoverXaiModels, parseModelList } from '../../src/providers/xai/models'
import { sanitizeXaiResponsesBody } from '../../src/providers/xai/sanitize'
import { xaiTransport } from '../../src/providers/xai/transport'
import { resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'
import { ctx } from '../support/responses'

function sanitize(
  body: Record<string, unknown>,
  upstreamModel = 'grok-build',
): Record<string, unknown> {
  return sanitizeXaiResponsesBody(body, ctx({ upstreamModel, conversationId: 'conv-1' })) as Record<
    string,
    unknown
  >
}

describe('sanitizeXaiResponsesBody', () => {
  it('sets store:false + prompt_cache_key and drops disallowed params', () => {
    const out = sanitize({
      input: [],
      stream_options: { include_usage: true },
      previous_response_id: 'r',
      safety_identifier: 's',
      prompt_cache_retention: 'in-memory',
    })
    expect(out.store).toBe(false)
    expect(out.prompt_cache_key).toBe('conv-1')
    expect(out.stream_options).toBeUndefined()
    expect(out.previous_response_id).toBeUndefined()
    expect(out.safety_identifier).toBeUndefined()
    expect(out.prompt_cache_retention).toBeUndefined()
  })

  it('strips input item ids and folds system items into instructions', () => {
    const out = sanitize({
      instructions: 'base',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'sys' }] },
        { type: 'message', role: 'user', id: 'm1', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    })
    expect(out.instructions).toBe('base\n\nsys')
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })

  it('strips reasoning for non-allowlisted models', () => {
    const out = sanitize({ input: [], reasoning: { effort: 'high' } }, 'grok-build')
    expect(out.reasoning).toBeUndefined()
  })

  it('keeps reasoning for allowlisted models, clamping minimal->low and dropping summary', () => {
    const out = sanitize({ input: [], reasoning: { effort: 'minimal', summary: 'x' } }, 'grok-4.3')
    expect(out.reasoning).toEqual({ effort: 'low' })
  })

  it('drops encrypted_content from include', () => {
    const out = sanitize({ input: [], include: ['reasoning.encrypted_content', 'logprobs'] })
    expect(out.include).toEqual(['logprobs'])
  })

  it('remaps custom tools to function, drops unsupported tools, ensures parameters', () => {
    const out = sanitize({
      input: [],
      tools: [
        { type: 'custom', name: 'c' },
        { type: 'image_generation' },
        { type: 'function', name: 'f' },
      ],
    })
    expect(out.tools).toEqual([
      { type: 'function', name: 'c', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'f', parameters: { type: 'object', properties: {} } },
    ])
  })
})

describe('xai transport', () => {
  const credential = new Credential({
    type: 'oauth',
    access_token: 'XT',
    refresh_token: 'RT',
    expires_at: 9_999_999_999,
  })

  it('sends the bearer token and x-grok-conv-id only', () => {
    const headers = xaiTransport.headers(credential, ctx({ conversationId: 'cv-9' }))
    expect(headers.authorization).toBe('Bearer XT')
    expect(headers['x-grok-conv-id']).toBe('cv-9')
    expect('chatgpt-account-id' in headers).toBe(false)
  })

  it('maps a 403 to xai_tier_denied without retrying', () => {
    const error = xaiTransport.classifyError(403, new Headers(), '')
    expect(error.status).toBe(403)
    expect(error.type).toBe('permission_error')
    expect(error.code).toBe('xai_tier_denied')
  })

  it('maps 401 to credential_expired and 429 to rate limit', () => {
    expect(xaiTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(xaiTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })
})

describe('xai models', () => {
  it('parses an upstream /v1/models list', () => {
    expect(parseModelList({ data: [{ id: 'grok-x' }, { id: 'grok-y' }] })).toEqual([
      { id: 'grok-x' },
      { id: 'grok-y' },
    ])
  })

  it('returns the static catalog without a credential', async () => {
    expect(await discoverXaiModels()).toBe(XAI_MODELS)
  })
})

describe('xai routing', () => {
  it('is registered and reachable through the registry + router', () => {
    expect(getProvider('xai')?.id).toBe('xai')
    expect(resolveModel(testConfig(), 'grok')).toMatchObject({
      providerId: 'xai',
      upstreamModel: 'grok-build',
    })
  })
})
