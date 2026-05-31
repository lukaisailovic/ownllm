import { Hono } from 'hono'
import type { Config } from '../config/schema'
import { logger } from '../logger'
import { LlmgateError, internalError } from '../translate/errors'
import { clientAuth } from './middleware/clientAuth'
import { requestId } from './middleware/requestId'
import { registerHealthRoutes } from './routes/health'
import { registerModelsRoutes } from './routes/models'
import type { AppEnv } from './types'

export interface AppDeps {
  config: Config
  startedAt: number // epoch seconds; used as `created` in /v1/models
  isReady: () => Promise<boolean>
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', requestId)

  app.onError((err, c) => {
    const id = c.get('requestId')
    if (err instanceof LlmgateError) return err.toResponse(id)
    logger.error({ err: err.message, requestId: id }, 'unhandled server error')
    return internalError().toResponse(id)
  })

  registerHealthRoutes(app, deps.isReady)

  app.use('/v1/*', clientAuth(deps.config.server.api_key))
  registerModelsRoutes(app, deps.config, deps.startedAt)

  return app
}
