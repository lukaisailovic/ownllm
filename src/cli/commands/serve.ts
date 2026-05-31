import { serve } from '@hono/node-server'
import { defineCommand } from 'citty'
import { openAuthStore } from '../../auth/store'
import { loadConfigOrExit } from '../../config/load'
import { isLoopbackHost } from '../../config/loopback'
import { resolvePaths } from '../../config/paths'
import { logger } from '../../logger'
import { createApp } from '../../server/app'
import { makeReadinessCheck } from '../../server/readiness'

export const serveCommand = defineCommand({
  meta: { name: 'serve', description: 'Start the API server' },
  args: {
    config: { type: 'string', description: 'Path to config file' },
    host: { type: 'string', description: 'Override bind host' },
    port: { type: 'string', description: 'Override bind port' },
  },
  run({ args }) {
    const configPath = args.config ?? resolvePaths().configFile
    const config = loadConfigOrExit(configPath)

    const host = args.host ?? config.server.host
    const port = args.port ? Number.parseInt(args.port, 10) : config.server.port

    if (!isLoopbackHost(host) && !config.server.api_key) {
      process.stderr.write(
        `refusing to start: host '${host}' is not loopback and server.api_key is not set\n`,
      )
      process.exit(1)
    }

    const store = openAuthStore()
    const app = createApp({
      config,
      startedAt: Math.floor(Date.now() / 1000),
      isReady: makeReadinessCheck(config, store),
    })
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      logger.info({ host: info.address, port: info.port }, 'llmgate listening')
    })

    const shutdown = (signal: NodeJS.Signals) => {
      logger.info({ signal }, 'shutting down')
      server.close(() => process.exit(0))
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  },
})
