import { describe, expect, it } from 'vitest'
import type { LlmgateError } from '../../src/translate/errors'
import { enforceParamPolicy } from '../../src/translate/param-policy'
import type { ChatCompletionRequest } from '../../src/translate/types'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'm', messages: [{ role: 'user', content: 'hi' }], ...overrides }
}

function thrown(fn: () => void): LlmgateError | undefined {
  try {
    fn()
  } catch (error) {
    return error as LlmgateError
  }
  return undefined
}

describe('enforceParamPolicy', () => {
  it('rejects n>1 with unsupported_parameter on param n', () => {
    const error = thrown(() => enforceParamPolicy(request({ n: 2 }), false))
    expect(error?.code).toBe('unsupported_parameter')
    expect(error?.param).toBe('n')
  })

  it('allows n=1', () => {
    expect(enforceParamPolicy(request({ n: 1 }), false).ignored).toEqual([])
  })

  it('reports ignored params without throwing in non-strict mode', () => {
    expect(enforceParamPolicy(request({ seed: 1, user: 'u' }), false).ignored).toEqual([
      'seed',
      'user',
    ])
  })

  it('throws on the first ignored param under strict mode', () => {
    const error = thrown(() => enforceParamPolicy(request({ frequency_penalty: 1 }), true))
    expect(error?.param).toBe('frequency_penalty')
  })

  it('does not flag mapped/forwarded params', () => {
    const result = enforceParamPolicy(
      request({ temperature: 0.5, tools: [{ type: 'function' }] }),
      true,
    )
    expect(result.ignored).toEqual([])
  })
})
