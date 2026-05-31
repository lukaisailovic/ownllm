import { serve } from '@hono/node-server'
import { defineCommand } from 'citty'
import { authProviders } from '../../auth/auth-providers'
import { RefreshManager } from '../../auth/refresh'
import { openAuthStore } from '../../auth/store'
import { loadConfigForCli } from '../../config/load'
import { isLoopbackHost } from '../../config/loopback'
import { logger } from '../../logger'
import { getProvider } from '../../providers/registry'
import { createApp } from '../../server/app'
import { makeReadinessCheck } from '../../server/readiness'
import { fail } from '../../util/term'

const SHUTDOWN_GRACE_MS = 25_000

export const serveCommand = defineCommand({
  meta: { name: 'serve', description: 'Start the API server' },
  args: {
    config: { type: 'string', description: 'Path to config file' },
    host: { type: 'string', description: 'Override bind host' },
    port: { type: 'string', description: 'Override bind port' },
  },
  run({ args }) {
    const config = loadConfigForCli(args.config)

    const host = args.host ?? config.server.host
    const port = args.port ? Number.parseInt(args.port, 10) : config.server.port

    if (!isLoopbackHost(host) && !config.server.api_key) {
      fail(`refusing to start: host '${host}' is not loopback and server.api_key is not set`)
      process.exit(1)
    }

    const store = openAuthStore()
    const refreshManager = new RefreshManager(store, authProviders)
    const app = createApp({
      config,
      startedAt: Math.floor(Date.now() / 1000),
      isReady: makeReadinessCheck(config, store),
      getProvider,
      ensureCredential: (providerId) => refreshManager.ensureFresh(providerId),
      refreshAfterUnauthorized: (providerId) => refreshManager.refreshAfterUnauthorized(providerId),
    })
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      logger.info({ host: info.address, port: info.port }, 'ownllm listening')
    })

    // Stop accepting, drain in-flight streams, then exit — or force-exit after the grace period.
    const shutdown = (signal: NodeJS.Signals) => {
      logger.info({ signal }, 'shutting down')
      const force = setTimeout(() => {
        logger.warn('grace period elapsed; forcing exit')
        process.exit(1)
      }, SHUTDOWN_GRACE_MS)
      force.unref()
      server.close(() => {
        clearTimeout(force)
        process.exit(0)
      })
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  },
})
