import { createMiddleware } from 'hono/factory'
import { logger } from '../../logger'
import type { AppEnv } from '../types'

// Structured access log for successful API requests. Failures are logged by the app's onError
// handler (which has the mapped status/type/code). Message bodies are never logged here.
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now()
  await next()
  logger.info(
    {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    },
    'request',
  )
})
