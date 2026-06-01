import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as readline from 'node:readline/promises'
import { defineCommand } from 'citty'
import { authProviderIds, getAuthProvider } from '../../auth/auth-providers'
import type { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { type AuthStore, openAuthStore } from '../../auth/store'
import { codexCredentialFromTokens } from '../../providers/codex/oauth'
import type { AuthProvider } from '../../providers/types'
import { asRecord } from '../../util/json'
import { fail, out, style } from '../../util/term'

const PROVIDER_ARG = {
  provider: {
    type: 'positional',
    description: `Provider id (${authProviderIds().join(' | ')})`,
    required: true,
  },
} as const

function resolveProvider(id: string): AuthProvider {
  const provider = getAuthProvider(id)
  if (provider) return provider
  fail(`unknown provider '${id}' (expected: ${authProviderIds().join(', ')})`)
  process.exit(1)
}

const loginCommand = defineCommand({
  meta: { name: 'login', description: 'OAuth login and store a credential' },
  args: {
    ...PROVIDER_ARG,
    manual: {
      type: 'boolean',
      description:
        'Paste the code by hand instead of using the loopback listener (headless, Docker, SSH)',
    },
  },
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
        prompt: (message) => promptLine(message, controller.signal),
        manual: args.manual === true,
      })
      await store.setCredential(provider.id, credential)
      out.status('ok', `logged in to ${provider.id}`)
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
      out.status('info', 'no stored credentials — run: ownllm auth login <provider>')
      return
    }
    const rows = [['PROVIDER', 'IDENTITY', 'TOKEN', 'EXPIRES', 'STATUS']]
    for (const id of ids) rows.push(await statusRow(store, id))
    out.table(rows, { head: true })
  },
})

const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove a stored credential' },
  args: PROVIDER_ARG,
  async run({ args }) {
    const removed = await openAuthStore().removeCredential(args.provider)
    if (removed) {
      out.status('ok', `logged out of ${args.provider}`)
      return
    }
    out.status('info', `no credential stored for ${args.provider}`)
  },
})

const importCommand = defineCommand({
  meta: { name: 'import', description: 'Import credentials from an official CLI' },
  args: PROVIDER_ARG,
  async run({ args }) {
    if (args.provider !== 'openai-codex') {
      fail(`import is only supported for openai-codex (got '${args.provider}')`)
      process.exit(1)
    }
    process.stderr.write(
      'warning: this shares the refresh token with the official Codex CLI. Using both rotates the\n' +
        'shared token and can revoke BOTH credentials. Prefer `ownllm auth login openai-codex`.\n',
    )
    await openAuthStore().setCredential('openai-codex', readCodexCredentialOrExit())
    out.status('ok', 'imported openai-codex credential')
  },
})

function readCodexCredentialOrExit(): Credential {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    fail(`could not read ${file}; is the Codex CLI logged in?`)
    process.exit(1)
  }
  const tokens = asRecord(asRecord(parsed)?.tokens) ?? asRecord(parsed)
  if (!tokens) {
    fail(`no tokens found in ${file}`)
    process.exit(1)
  }
  try {
    return codexCredentialFromTokens(tokens)
  } catch (error) {
    fail(`failed to import: ${(error as Error).message}`)
    process.exit(1)
  }
}

export const authCommand = defineCommand({
  meta: { name: 'auth', description: 'Manage provider credentials' },
  subCommands: {
    login: loginCommand,
    status: statusCommand,
    logout: logoutCommand,
    import: importCommand,
  },
})

async function statusRow(store: AuthStore, id: string): Promise<string[]> {
  const credential = await store.getCredential(id)
  if (!credential) return [id, '-', '-', '-', style.dim('missing')]

  const provider = getAuthProvider(id)
  const summary = credential.summary()
  const expired = provider ? provider.isExpired(credential) : summary.expired
  const identity = summary.email ?? summary.account_id ?? '-'
  const expiry = new Date(summary.expires_at * 1000).toISOString()
  const state = expired ? style.red('EXPIRED') : style.green('valid')
  return [id, identity, `…${summary.access_token_last4}`, expiry, state]
}

async function promptLine(message: string, signal: AbortSignal): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(message, { signal })).trim()
  } finally {
    rl.close()
  }
}

function exitWithAuthError(error: unknown): never {
  if (error instanceof AuthError) {
    const hint = error.code === 'login_cancelled' ? '' : ` (${error.code})`
    fail(`login failed${hint}: ${error.message}`)
    process.exit(1)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    fail('login cancelled')
    process.exit(1)
  }
  throw error
}
