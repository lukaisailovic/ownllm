// A per-model circuit breaker for the fallback chain. After `failureThreshold` consecutive
// failures a model is "open" for `cooldownMs`: the router skips it while a healthy alternative
// exists. Once the window passes the next attempt is an implicit trial — a success closes the
// circuit, a failure re-arms the window (failures are already at the threshold). State is
// in-process and per server; a model with no alternative is still attempted (see the router).

export interface CircuitBreaker {
  shouldSkip(key: string): boolean
  recordSuccess(key: string): void
  recordFailure(key: string): void
}

export interface BreakerOptions {
  failureThreshold: number
  cooldownMs: number
  now?: () => number
}

interface KeyState {
  failures: number
  openUntil: number
}

export function createCircuitBreaker(options: BreakerOptions): CircuitBreaker {
  const now = options.now ?? (() => Date.now())
  const states = new Map<string, KeyState>()

  const stateFor = (key: string): KeyState => {
    const existing = states.get(key)
    if (existing) return existing
    const created: KeyState = { failures: 0, openUntil: 0 }
    states.set(key, created)
    return created
  }

  return {
    shouldSkip(key) {
      return stateFor(key).openUntil > now()
    },
    recordSuccess(key) {
      const state = stateFor(key)
      state.failures = 0
      state.openUntil = 0
    },
    recordFailure(key) {
      const state = stateFor(key)
      state.failures += 1
      if (state.failures >= options.failureThreshold) {
        state.openUntil = now() + options.cooldownMs
      }
    },
  }
}
