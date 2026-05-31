import { defineCommand } from 'citty'
import { authProviderIds, getAuthProvider } from '../../auth/auth-providers'
import { AuthError } from '../../auth/errors'
import { type AuthStore, openAuthStore } from '../../auth/store'
import type { AuthProvider } from '../../providers/types'
import { notImplemented } from '../notImplemented'

const PROVIDER_ARG = {
  provider: { type: 'positional', description: 'Provider id (openai-codex | xai)', required: true },
} as const

function resolveProvider(id: string): AuthProvider {
  const provider = getAuthProvider(id)
  if (provider) return provider
  process.stderr.write(`unknown provider '${id}' (expected: ${authProviderIds().join(', ')})\n`)
  process.exit(1)
}

const loginCommand = defineCommand({
  meta: { name: 'login', description: 'OAuth login and store a credential' },
  args: PROVIDER_ARG,
  async run({ args }) {
    const provider = resolveProvider(args.provider)
    const store = openAuthStore()
    const controller = new AbortController()
    const onSigint = () => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      const credential = await provider.login({
        signal: controller.signal,
        report: (message) => process.stdout.write(`${message}\n`),
      })
      await store.setCredential(provider.id, credential)
      process.stdout.write(`logged in to ${provider.id}\n`)
    } catch (error) {
      exitWithAuthError(error)
    } finally {
      process.off('SIGINT', onSigint)
    }
  },
})

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show stored credential validity (redacted)' },
  async run() {
    const store = openAuthStore()
    const ids = await store.listProviders()
    if (ids.length === 0) {
      process.stdout.write('no stored credentials (run: llmgate auth login <provider>)\n')
      return
    }
    for (const id of ids) {
      process.stdout.write(await formatStatus(store, id))
    }
  },
})

const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove a stored credential' },
  args: PROVIDER_ARG,
  async run({ args }) {
    const removed = await openAuthStore().removeCredential(args.provider)
    process.stdout.write(
      removed ? `logged out of ${args.provider}\n` : `no credential stored for ${args.provider}\n`,
    )
  },
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

async function formatStatus(store: AuthStore, id: string): Promise<string> {
  const credential = await store.getCredential(id)
  if (!credential) return `${id}: (missing)\n`

  const provider = getAuthProvider(id)
  const summary = credential.summary()
  const expired = provider ? provider.isExpired(credential) : summary.expired
  const identity = summary.email ?? summary.account_id ?? '-'
  const expiry = new Date(summary.expires_at * 1000).toISOString()
  const state = expired ? 'EXPIRED' : 'valid'
  return `${id}: ${state}  identity=${identity}  token=…${summary.access_token_last4}  expires=${expiry}\n`
}

function exitWithAuthError(error: unknown): never {
  if (error instanceof AuthError) {
    const hint = error.code === 'login_cancelled' ? '' : ` (${error.code})`
    process.stderr.write(`login failed${hint}: ${error.message}\n`)
    process.exit(1)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    process.stderr.write('login cancelled\n')
    process.exit(1)
  }
  throw error
}
