import { describe, expect, it } from 'vitest'
import { resolveModel } from '../../src/router/resolve'
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
