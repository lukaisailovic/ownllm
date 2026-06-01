import { describe, expect, it } from 'vitest'
import { createCircuitBreaker } from '../../src/router/breaker'

describe('createCircuitBreaker', () => {
  it('does not skip a key with no failures', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => 0 })
    expect(breaker.shouldSkip('a')).toBe(false)
  })

  it('opens only after the threshold of consecutive failures', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => 0 })
    breaker.recordFailure('a')
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(false)
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(true)
  })

  it('resets the failure count on success', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => 0 })
    breaker.recordFailure('a')
    breaker.recordSuccess('a')
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(false)
  })

  it('stops skipping once the cooldown passes, and a trial success closes it', () => {
    let now = 0
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(true)
    now = 999
    expect(breaker.shouldSkip('a')).toBe(true)
    now = 1000
    expect(breaker.shouldSkip('a')).toBe(false)
    breaker.recordSuccess('a')
    now = 1_000_000
    expect(breaker.shouldSkip('a')).toBe(false)
  })

  it('re-arms the cooldown when the trial fails again', () => {
    let now = 0
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now })
    breaker.recordFailure('a')
    now = 1000
    expect(breaker.shouldSkip('a')).toBe(false)
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(true)
    now = 1999
    expect(breaker.shouldSkip('a')).toBe(true)
    now = 2000
    expect(breaker.shouldSkip('a')).toBe(false)
  })

  it('tracks keys independently', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => 0 })
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(true)
    expect(breaker.shouldSkip('b')).toBe(false)
  })

  it('never skips when cooldown is zero', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 0, now: () => 0 })
    breaker.recordFailure('a')
    breaker.recordFailure('a')
    expect(breaker.shouldSkip('a')).toBe(false)
  })
})
