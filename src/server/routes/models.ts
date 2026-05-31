import type { Hono } from 'hono'
import type { Config } from '../../config/schema'
import type { AppEnv } from '../types'

export function registerModelsRoutes(app: Hono<AppEnv>, config: Config, createdAt: number): void {
  app.get('/v1/models', (c) => {
    const data = Object.entries(config.models).map(([id, route]) => ({
      id,
      object: 'model',
      created: createdAt,
      owned_by: route.provider,
    }))
    return c.json({ object: 'list', data })
  })
}
