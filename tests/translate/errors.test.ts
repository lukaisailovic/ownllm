import { describe, expect, it } from 'vitest'
import * as errors from '../../src/translate/errors'

describe('error factory (PLAN §11)', () => {
  it('model_not_found is a 404 mirroring the OpenAI message', () => {
    const error = errors.modelNotFound('gpt-foo')
    expect(error.status).toBe(404)
    expect(error.toErrorObject()).toEqual({
      message: "The model 'gpt-foo' does not exist or you do not have access to it.",
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
    })
  })

  it('maps each documented condition to its status/type/code', () => {
    expect([errors.invalidApiKey().status, errors.invalidApiKey().code]).toEqual([
      401,
      'invalid_api_key',
    ])
    expect([errors.credentialExpired().status, errors.credentialExpired().code]).toEqual([
      401,
      'credential_expired',
    ])
    expect([errors.xaiTierDenied().status, errors.xaiTierDenied().type]).toEqual([
      403,
      'permission_error',
    ])
    expect([errors.codexCloudflareBlocked().status, errors.codexCloudflareBlocked().code]).toEqual([
      502,
      'codex_cloudflare_blocked',
    ])
    expect([errors.rateLimited().status, errors.rateLimited().type]).toEqual([
      429,
      'rate_limit_error',
    ])
    expect(errors.upstreamError().status).toBe(502)
    expect(errors.unsupportedParameter('n').code).toBe('unsupported_parameter')
  })

  it('renders a Response with the error envelope and x-request-id header', async () => {
    const res = errors.modelNotFound('x').toResponse('req-123')
    expect(res.status).toBe(404)
    expect(res.headers.get('x-request-id')).toBe('req-123')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: {
        message: "The model 'x' does not exist or you do not have access to it.",
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
      },
    })
  })

  it('passes upstream headers (e.g. retry-after) through on rate limits', () => {
    const res = errors.rateLimited({ 'retry-after': '30' }).toResponse('r')
    expect(res.headers.get('retry-after')).toBe('30')
  })

  it('omits undefined param/code from the serialized error', async () => {
    const body = (await errors.upstreamError().toResponse('r').json()) as { error: object }
    expect(body.error).toEqual({
      message: 'The upstream provider returned an error.',
      type: 'api_error',
    })
  })
})
