import { describe, expect, it } from 'vitest'
import { interpolateEnv, parseConfig } from '../../src/config/load'
import { isLoopbackHost } from '../../src/config/loopback'

const baseConfig = `
server:
  host: 127.0.0.1
  port: 8787
providers:
  openai-codex:
    enabled: true
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
`

describe('interpolateEnv', () => {
  it('substitutes set variables in string values', () => {
    const { value, missing } = interpolateEnv({ key: '${FOO}' }, { FOO: 'bar' })
    expect(value).toEqual({ key: 'bar' })
    expect(missing).toEqual([])
  })

  it('reports missing variables with their config path', () => {
    const { missing } = interpolateEnv({ a: '${X}', nested: { b: '${Y}' } }, {})
    expect(missing.map((issue) => issue.path)).toEqual(['a', 'nested.b'])
  })

  it('leaves non-string values untouched', () => {
    const { value } = interpolateEnv({ port: 8787, enabled: true }, {})
    expect(value).toEqual({ port: 8787, enabled: true })
  })
})

describe('parseConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const result = parseConfig(baseConfig, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.server.request_timeout_ms).toBe(600_000)
    expect(result.config.server.strict_params).toBe(false)
    expect(result.config.models['gpt-5']).toEqual({
      provider: 'openai-codex',
      upstream: 'gpt-5',
    })
  })

  it('fails on an unresolved env variable, pointing at the config path', () => {
    const result = parseConfig('server:\n  api_key: ${MISSING_KEY}', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: 'server.api_key',
      message: 'environment variable ${MISSING_KEY} is not set',
    })
  })

  it('ignores ${...} that appears only in comments', () => {
    const result = parseConfig('# api_key: ${OWNLLM_API_KEY}\nserver:\n  port: 8787', {})
    expect(result.ok).toBe(true)
  })

  it('substitutes env into the config', () => {
    const result = parseConfig('server:\n  host: 0.0.0.0\n  api_key: ${OWNLLM_API_KEY}', {
      OWNLLM_API_KEY: 'secret',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.server.api_key).toBe('secret')
  })

  it('refuses a non-loopback host without an api_key', () => {
    const result = parseConfig('server:\n  host: 0.0.0.0', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.path).toBe('server.api_key')
  })

  it('rejects a model routed to an undeclared provider', () => {
    const config = `
providers:
  xai:
    enabled: true
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
`
    const result = parseConfig(config, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.path).toBe('models.gpt-5.provider')
  })

  it('rejects an out-of-range port', () => {
    const result = parseConfig('server:\n  port: 70000', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.path).toBe('server.port')
  })

  it('reports invalid yaml', () => {
    const result = parseConfig('server: : :', {})
    expect(result.ok).toBe(false)
  })

  it('parses fallbacks and defaults the fallback policy', () => {
    const config = `
providers:
  openai-codex:
    enabled: true
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
    fallbacks: [fast]
  fast:
    provider: openai-codex
    upstream: gpt-5-mini
`
    const result = parseConfig(config, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.models['gpt-5']?.fallbacks).toEqual(['fast'])
    expect(result.config.fallback).toEqual({ failure_threshold: 3, cooldown_ms: 30_000 })
  })

  it('applies custom fallback policy values', () => {
    const result = parseConfig('fallback:\n  failure_threshold: 5\n  cooldown_ms: 1000', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.fallback).toEqual({ failure_threshold: 5, cooldown_ms: 1000 })
  })

  it('rejects a fallback that references an unknown model', () => {
    const config = `
providers:
  openai-codex:
    enabled: true
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
    fallbacks: [ghost]
`
    const result = parseConfig(config, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.path).toBe('models.gpt-5.fallbacks')
  })

  it('allows a fallback cycle between models', () => {
    const config = `
providers:
  openai-codex:
    enabled: true
models:
  a:
    provider: openai-codex
    upstream: up-a
    fallbacks: [b]
  b:
    provider: openai-codex
    upstream: up-b
    fallbacks: [a]
`
    expect(parseConfig(config, {}).ok).toBe(true)
  })
})

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.5.5.5', true],
    ['localhost', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['192.168.1.10', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected)
  })
})
