import { defineCommand } from 'citty'
import { notImplemented } from '../notImplemented'

const PROVIDER_ARG = {
  provider: { type: 'positional', description: 'Provider id (openai-codex | xai)', required: true },
} as const

const loginCommand = defineCommand({
  meta: { name: 'login', description: 'OAuth login and store a credential' },
  args: PROVIDER_ARG,
  run: () => notImplemented('auth login'),
})

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show stored credential validity (redacted)' },
  run: () => notImplemented('auth status'),
})

const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove a stored credential' },
  args: PROVIDER_ARG,
  run: () => notImplemented('auth logout'),
})

const importCommand = defineCommand({
  meta: { name: 'import', description: 'Import credentials from an official CLI' },
  args: PROVIDER_ARG,
  run: () => notImplemented('auth import'),
})

export const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Manage provider credentials' },
  subCommands: {
    login: loginCommand,
    status: statusCommand,
    logout: logoutCommand,
    import: importCommand,
  },
})
