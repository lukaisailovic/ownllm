import { defineCommand } from 'citty'
import { notImplemented } from '../notImplemented'

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'List configured models' },
  args: {
    config: { type: 'string', description: 'Path to config file' },
    remote: { type: 'boolean', description: 'Merge upstream /v1/models' },
  },
  run: () => notImplemented('models'),
})
