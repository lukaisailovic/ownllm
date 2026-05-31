import { describe, expect, it } from 'vitest'
import { createTestApp } from '../support/app'

function makeApp(ready = true) {
  return createTestApp({ isReady: async () => ready })
}

const authorized = { headers: { authorization: 'Bearer test-key' } }

describe('server contract', () => {
  it('GET /health returns ok with a request id', async () => {
    const res = await makeApp().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('GET /ready reflects readiness', async () => {
    expect((await makeApp(true).request('/ready')).status).toBe(200)
    expect((await makeApp(false).request('/ready')).status).toBe(503)
  })

  it('echoes a client-supplied x-request-id', async () => {
    const res = await makeApp().request('/health', { headers: { 'x-request-id': 'abc-123' } })
    expect(res.headers.get('x-request-id')).toBe('abc-123')
  })

  it('rejects /v1/models without an api key (401 invalid_api_key)', async () => {
    const res = await makeApp().request('/v1/models')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_api_key')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('rejects a wrong api key', async () => {
    const res = await makeApp().request('/v1/models', { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
  })

  it('lists configured models in the OpenAI list shape', async () => {
    const res = await makeApp().request('/v1/models', authorized)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(body.data).toContainEqual({
      id: 'gpt-5',
      object: 'model',
      created: 1000,
      owned_by: 'openai-codex',
    })
    expect(body.data).toContainEqual({
      id: 'grok',
      object: 'model',
      created: 1000,
      owned_by: 'xai',
    })
  })
})
