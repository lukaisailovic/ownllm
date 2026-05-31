import { Hono } from 'hono'
import { registerHealthRoutes } from './routes/health'

export function createApp(): Hono {
  const app = new Hono()
  registerHealthRoutes(app)
  return app
}
