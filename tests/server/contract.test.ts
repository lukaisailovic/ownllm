import { serve } from '@hono/node-server'
import OpenAI from 'openai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../support/app'

let server: ReturnType<typeof serve>
let baseURL: string

beforeAll(async () => {
  const app = createTestApp()
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      baseURL = `http://127.0.0.1:${info.port}/v1`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

describe('OpenAI SDK contract', () => {
  it('lists models through the official SDK', async () => {
    const client = new OpenAI({ apiKey: 'test-key', baseURL })
    const models = await client.models.list()
    expect(models.data.map((model) => model.id)).toContain('gpt-5')
  })

  it('surfaces a bad api key as a 401 error', async () => {
    const client = new OpenAI({ apiKey: 'wrong-key', baseURL, maxRetries: 0 })
    await expect(client.models.list()).rejects.toMatchObject({ status: 401 })
  })
})
