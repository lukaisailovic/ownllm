import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

const HEADER = 'x-request-id'
const MAX_ECHO_LENGTH = 200

// Mints (or echoes a sane client-supplied) request id, exposing it on the context for logs and on
// the response header. The error handler reads the same id so failures are correlatable too.
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header(HEADER)
  const id = incoming && incoming.length <= MAX_ECHO_LENGTH ? incoming : randomUUID()
  c.set('requestId', id)
  c.header(HEADER, id)
  await next()
})
