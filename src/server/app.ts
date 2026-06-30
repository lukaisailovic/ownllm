import { Hono } from 'hono'
import type { Credential } from '../auth/credential'
import type { Config } from '../config/schema'
import { logger } from '../logger'
import type { ProviderModule } from '../providers/types'
import { type CircuitBreaker, createCircuitBreaker } from '../router/breaker'
import { OwnllmError, internalError } from '../translate/errors'
import { clientAuth } from './middleware/clientAuth'
import { requestLogger } from './middleware/logger'
import { requestId } from './middleware/requestId'
import { registerChatRoutes } from './routes/chat-completions'
import { registerHealthRoutes } from './routes/health'
import { registerModelsRoutes } from './routes/models'
import { registerResponsesRoutes } from './routes/responses'
import type { AppEnv } from './types'

export interface AppDeps {
  config: Config
  startedAt: number // epoch seconds; used as `created` in /v1/models
  isReady: () => Promise<boolean>
  getProvider: (id: string) => ProviderModule | undefined
  ensureCredential: (providerId: string) => Promise<Credential>
  refreshAfterUnauthorized: (providerId: string) => Promise<Credential>
  // Per-server fallback circuit breaker; defaults to one built from config.fallback.
  breaker?: CircuitBreaker
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const breaker =
    deps.breaker ??
    createCircuitBreaker({
      failureThreshold: deps.config.fallback.failure_threshold,
      cooldownMs: deps.config.fallback.cooldown_ms,
    })

  app.use('*', requestId)

  app.onError((err, c) => {
    const id = c.get('requestId')
    if (err instanceof OwnllmError) {
      logger[err.status >= 500 ? 'error' : 'warn'](
        { requestId: id, status: err.status, type: err.type, code: err.code },
        'request error',
      )
      return err.toResponse(id)
    }
    logger.error({ err: err.message, requestId: id }, 'unhandled server error')
    return internalError().toResponse(id)
  })

  registerHealthRoutes(app, deps.isReady)

  app.use('/v1/*', requestLogger)
  app.use('/v1/*', clientAuth(deps.config.server.api_key))
  registerModelsRoutes(app, deps.config, deps.startedAt)
  registerChatRoutes(app, deps, breaker)
  registerResponsesRoutes(app, deps, breaker)

  return app
}
