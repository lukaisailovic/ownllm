import { describe, expect, it } from 'vitest'
import { resolveChain, resolveModel } from '../../src/router/resolve'
import { testConfig } from '../support/app'

describe('resolveModel', () => {
  it('resolves a configured model to its provider and upstream', () => {
    expect(resolveModel(testConfig(), 'gpt-5')).toEqual({
      providerId: 'openai-codex',
      upstreamModel: 'gpt-5',
      reasoningEffort: undefined,
    })
  })

  it('is case-sensitive and returns undefined for unknown models', () => {
    expect(resolveModel(testConfig(), 'GPT-5')).toBeUndefined()
    expect(resolveModel(testConfig(), 'does-not-exist')).toBeUndefined()
  })
})

const CHAIN_YAML = `
server:
  host: 127.0.0.1
  api_key: test-key
providers:
  openai-codex:
    enabled: true
  xai:
    enabled: true
models:
  a:
    provider: openai-codex
    upstream: up-a
    fallbacks: [b, c]
  b:
    provider: xai
    upstream: up-b
    reasoning_effort: high
    fallbacks: [d]
  c:
    provider: openai-codex
    upstream: up-c
  d:
    provider: xai
    upstream: up-d
  cyc1:
    provider: openai-codex
    upstream: up-cyc1
    fallbacks: [cyc2]
  cyc2:
    provider: xai
    upstream: up-cyc2
    fallbacks: [cyc1]
`

describe('resolveChain', () => {
  const config = testConfig(CHAIN_YAML)

  it('returns just the model when it has no fallbacks', () => {
    expect(resolveChain(config, 'c').map((entry) => entry.model)).toEqual(['c'])
  })

  it('includes the model and its direct fallbacks in order, not transitively', () => {
    // a -> [b, c]; b -> [d]. `d` is b's fallback, so it must NOT appear when requesting a.
    expect(resolveChain(config, 'a').map((entry) => entry.model)).toEqual(['a', 'b', 'c'])
  })

  it('carries the resolved route for each candidate', () => {
    expect(resolveChain(config, 'b')).toEqual([
      { model: 'b', route: { providerId: 'xai', upstreamModel: 'up-b', reasoningEffort: 'high' } },
      {
        model: 'd',
        route: { providerId: 'xai', upstreamModel: 'up-d', reasoningEffort: undefined },
      },
    ])
  })

  it('does not loop on a cycle: each side resolves to a two-step chain and stops', () => {
    // cyc1 -> [cyc2], cyc2 -> [cyc1]. Requesting either tries it, then the other, then stops —
    // never cyc1 -> cyc2 -> cyc1.
    expect(resolveChain(config, 'cyc1').map((entry) => entry.model)).toEqual(['cyc1', 'cyc2'])
    expect(resolveChain(config, 'cyc2').map((entry) => entry.model)).toEqual(['cyc2', 'cyc1'])
  })

  it('returns an empty chain for an unknown model', () => {
    expect(resolveChain(config, 'nope')).toEqual([])
  })
})
