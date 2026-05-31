import { defineCommand } from 'citty'
import { openAuthStore } from '../../auth/store'
import { loadConfigForCli } from '../../config/load'
import type { Config } from '../../config/schema'
import { getProvider } from '../../providers/registry'
import { out, style } from '../../util/term'

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'List configured models' },
  args: {
    config: { type: 'string', description: 'Path to config file' },
    remote: {
      type: 'boolean',
      description: 'Also ask each provider which models your subscription offers (live for xAI)',
    },
  },
  async run({ args }) {
    const config = loadConfigForCli(args.config)

    out.line(`${style.bold('Routing table')}  ${style.dim('— names clients can request')}`)
    printRoutes(config.models)
    if (!args.remote) return

    out.blank()
    out.line(
      `${style.bold('Upstream catalog')}  ${style.dim('— what each provider offers; pick `upstream` values from here')}`,
    )
    const store = openAuthStore()
    for (const [id, providerConfig] of Object.entries(config.providers)) {
      const provider = getProvider(id)
      if (!provider || !providerConfig.enabled) continue
      out.blank()
      out.line(id)
      try {
        const models = await provider.listModels(await store.getCredential(id))
        for (const model of models) out.status('info', model.id)
      } catch (error) {
        out.status('bad', `discovery failed (${(error as Error).message})`)
      }
    }
  },
})

function printRoutes(models: Config['models']): void {
  const entries = Object.entries(models)
  if (entries.length === 0) {
    out.status('warn', 'no routes configured — add a `models` table to your config')
    return
  }
  const rows = entries.map(([id, route]) => {
    const upstream = route.reasoning_effort
      ? `${route.upstream} ${style.dim(`· reasoning ${route.reasoning_effort}`)}`
      : route.upstream
    return [id, route.provider, upstream]
  })
  out.table([['ALIAS', 'PROVIDER', 'UPSTREAM'], ...rows], { head: true })
}
