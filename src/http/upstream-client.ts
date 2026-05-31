import {
  type OwnllmError,
  credentialExpired,
  rateLimited,
  upstreamError,
} from '../translate/errors'
import { CookieJar } from './cookie-jar'

export interface UpstreamRequestInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface UpstreamClient {
  fetch(url: string, init: UpstreamRequestInit): Promise<Response>
}

// Host-pinning: refuse any request to a host outside the provider's allowlist, so a bearer token or
// cookie can never be sent to the wrong origin. redirect:'manual' stops a 30x from silently doing
// the same.
function assertHostAllowed(url: string, allowed: Set<string>): void {
  const host = new URL(url).hostname
  if (!allowed.has(host)) {
    throw upstreamError(`refusing request to non-allowlisted host: ${host}`)
  }
}

export function createUpstreamClient(hosts: string[]): UpstreamClient {
  const allowed = new Set(hosts)
  return {
    fetch(url, init) {
      assertHostAllowed(url, allowed)
      return fetch(url, { ...init, redirect: 'manual' })
    },
  }
}

// Codex variant with a per-client cookie jar that captures Set-Cookie via getSetCookie() and
// replays it as a Cookie header on subsequent requests.
// Maps the upstream statuses every provider handles the same way. A provider's transport handles
// its own special case (Codex Cloudflare 403, xAI tier 403) before delegating here.
export function classifyUpstreamStatus(
  status: number,
  headers: Headers,
  providerLabel: string,
): OwnllmError {
  if (status === 401) return credentialExpired()
  if (status === 429) return rateLimited(pickRateLimitHeaders(headers))
  return upstreamError(`${providerLabel} upstream returned ${status}`)
}

// Rate-limit-related response headers to echo back to the client on a 429 (PLAN §11).
export function pickRateLimitHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key === 'retry-after' || key.startsWith('x-ratelimit')) picked[key] = value
  })
  return picked
}

export function createCookieJarClient(hosts: string[]): UpstreamClient {
  const allowed = new Set(hosts)
  const jar = new CookieJar()
  return {
    async fetch(url, init) {
      assertHostAllowed(url, allowed)
      const cookie = jar.cookieHeader(url)
      const headers = cookie ? { ...init.headers, cookie } : init.headers
      const res = await fetch(url, { ...init, headers, redirect: 'manual' })
      jar.store(url, res.headers.getSetCookie())
      return res
    },
  }
}
