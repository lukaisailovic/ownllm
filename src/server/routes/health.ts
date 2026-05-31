import type { Hono } from 'hono'
import type { AppEnv } from '../types'

export function registerHealthRoutes(app: Hono<AppEnv>, isReady: () => Promise<boolean>): void {
  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.get('/ready', async (c) => {
    const ready = await isReady()
    return c.json({ status: ready ? 'ready' : 'not_ready' }, ready ? 200 : 503)
  })
}
