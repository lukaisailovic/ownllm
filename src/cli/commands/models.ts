import { defineCommand } from 'citty'
import { openAuthStore } from '../../auth/store'
import { loadConfigForCli } from '../../config/load'
import { getProvider } from '../../providers/registry'

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'List configured models' },
  args: {
    config: { type: 'string', description: 'Path to config file' },
    remote: { type: 'boolean', description: 'Also discover upstream models per provider' },
  },
  async run({ args }) {
    const config = loadConfigForCli(args.config)

    for (const [id, route] of Object.entries(config.models)) {
      process.stdout.write(`${id}  ->  ${route.provider}/${route.upstream}\n`)
    }
    if (!args.remote) return

    const store = openAuthStore()
    for (const [id, providerConfig] of Object.entries(config.providers)) {
      const provider = getProvider(id)
      if (!provider || !providerConfig.enabled) continue
      const credential = await store.getCredential(id)
      try {
        const models = await provider.listModels(credential)
        process.stdout.write(`\n${id} upstream: ${models.map((m) => m.id).join(', ')}\n`)
      } catch (error) {
        process.stdout.write(`\n${id} upstream: discovery failed (${(error as Error).message})\n`)
      }
    }
  },
})
