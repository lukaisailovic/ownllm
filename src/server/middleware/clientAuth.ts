import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { invalidApiKey } from '../../translate/errors'
import type { AppEnv } from '../types'

// Enforces the client api_key when configured. When unset, the server only ever bound to loopback
// (guaranteed at startup), so requests are allowed through.
export function clientAuth(apiKey: string | undefined) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!apiKey) {
      await next()
      return
    }
    const provided = bearerToken(c.req.header('authorization'))
    if (!provided || !constantTimeEqual(provided, apiKey)) throw invalidApiKey()
    await next()
  })
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null
  return match?.[1]
}

// Hash both sides so the comparison is constant time regardless of length (timingSafeEqual throws
// on length mismatch otherwise, which would itself leak length).
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}
