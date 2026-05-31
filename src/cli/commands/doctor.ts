import { defineCommand } from 'citty'
import type { Credential } from '../../auth/credential'
import { openAuthStore } from '../../auth/store'
import { loadConfigForCli } from '../../config/load'
import { getProvider } from '../../providers/registry'
import type { ProviderModule } from '../../providers/types'
import { parseModelList } from '../../providers/xai/models'
import type { TranslateContext } from '../../translate/types'

const PROVIDER_IDS = ['openai-codex', 'xai'] as const
const PROBE_TIMEOUT_MS = 10_000

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose auth, endpoints, and reachability' },
  args: { config: { type: 'string', description: 'Path to config file' } },
  async run({ args }) {
    const config = loadConfigForCli(args.config)
    const store = openAuthStore()

    for (const id of PROVIDER_IDS) {
      const enabled = config.providers[id]?.enabled ?? false
      process.stdout.write(`${id}${enabled ? '' : ' (disabled)'}:\n`)

      const provider = getProvider(id)
      const credential = await store.getCredential(id)
      if (!provider || !credential) {
        process.stdout.write(`  credential: missing — run 'ownllm auth login ${id}'\n`)
        continue
      }

      const expiry = new Date(credential.expiresAt * 1000).toISOString()
      const state = provider.auth.isExpired(credential) ? 'EXPIRED' : 'valid'
      process.stdout.write(`  credential: ${state} (expires ${expiry})\n`)

      const report =
        id === 'openai-codex' ? await probeCodex(provider, credential) : await probeXai(credential)
      process.stdout.write(report)
    }
  },
})

// Sends an intentionally minimal body: past Cloudflare the API answers 400, while a CF challenge
// answers a 403 HTML page — so we learn reachability without spending a completion.
async function probeCodex(provider: ProviderModule, credential: Credential): Promise<string> {
  const ctx: TranslateContext = {
    requestedModel: 'probe',
    upstreamModel: 'gpt-5',
    conversationId: '00000000-0000-4000-8000-000000000000',
    includeUsage: false,
  }
  try {
    const res = await provider.transport.client().fetch(provider.transport.endpoint(ctx), {
      method: 'POST',
      headers: provider.transport.headers(credential, ctx),
      body: '{}',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 403) {
      const body = await res.text().catch(() => '')
      if (
        provider.transport.classifyError(403, res.headers, body).code === 'codex_cloudflare_blocked'
      ) {
        return '  cloudflare: BLOCKED — try a residential IP or a TLS-impersonating client\n'
      }
    }
    return `  cloudflare: reachable (probe status ${res.status})\n`
  } catch (error) {
    return `  cloudflare: probe failed (${(error as Error).message})\n`
  }
}

async function probeXai(credential: Credential): Promise<string> {
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 403) return '  tier: DENIED — account not entitled to programmatic access\n'
    if (!res.ok) return `  tier: check failed (status ${res.status})\n`
    const models = parseModelList(await res.json()).map((m) => m.id)
    return `  tier: entitled\n  models: ${models.join(', ') || '(none returned)'}\n`
  } catch (error) {
    return `  tier: probe failed (${(error as Error).message})\n`
  }
}
