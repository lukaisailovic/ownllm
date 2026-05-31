import type { Hono } from 'hono'
import { parseConfig } from '../../src/config/load'
import type { Config } from '../../src/config/schema'
import { type AppDeps, createApp } from '../../src/server/app'
import type { AppEnv } from '../../src/server/types'

const DEFAULT_CONFIG_YAML = `
server:
  host: 127.0.0.1
  api_key: test-key
providers:
  openai-codex: { enabled: true }
  xai: { enabled: true }
models:
  gpt-5: { provider: openai-codex, upstream: gpt-5 }
  grok: { provider: xai, upstream: grok-build }
`

export function testConfig(yaml = DEFAULT_CONFIG_YAML): Config {
  const result = parseConfig(yaml, {})
  if (!result.ok) throw new Error(`bad test config: ${JSON.stringify(result.issues)}`)
  return result.config
}

export function createTestApp(overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  return createApp({
    config: testConfig(),
    startedAt: 1000,
    isReady: async () => true,
    ...overrides,
  })
}
