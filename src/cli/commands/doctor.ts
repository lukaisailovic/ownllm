import { defineCommand } from 'citty'
import type { Credential } from '../../auth/credential'
import { openAuthStore } from '../../auth/store'
import { loadConfigForCli } from '../../config/load'
import { getProvider } from '../../providers/registry'
import type { ProviderModule } from '../../providers/types'
import { parseModelList } from '../../providers/xai/models'
import type { TranslateContext } from '../../translate/types'
import { type StatusKind, out, style } from '../../util/term'

const PROVIDER_IDS = ['openai-codex', 'xai'] as const
const PROBE_TIMEOUT_MS = 10_000

interface Check {
  kind: StatusKind
  text: string
}

export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose auth, endpoints, and reachability' },
  args: { config: { type: 'string', description: 'Path to config file' } },
  async run({ args }) {
    const config = loadConfigForCli(args.config)
    const store = openAuthStore()

    for (const id of PROVIDER_IDS) {
      const enabled = config.providers[id]?.enabled ?? false
      out.line(`${style.bold(id)}${enabled ? '' : style.dim('  (disabled)')}`)
      for (const check of await diagnose(id, await store.getCredential(id))) {
        out.status(check.kind, check.text)
      }
      out.blank()
    }
  },
})

async function diagnose(id: string, credential: Credential | undefined): Promise<Check[]> {
  const provider = getProvider(id)
  if (!provider || !credential) {
    return [{ kind: 'bad', text: `credential missing — run: ownllm auth login ${id}` }]
  }

  const expiry = new Date(credential.expiresAt * 1000).toISOString()
  const expired = provider.auth.isExpired(credential)
  const credentialCheck: Check = {
    kind: expired ? 'bad' : 'ok',
    text: `credential ${expired ? 'EXPIRED' : 'valid'} ${style.dim(`· expires ${expiry}`)}`,
  }

  const probe =
    id === 'openai-codex' ? await probeCodex(provider, credential) : await probeXai(credential)
  return [credentialCheck, ...probe]
}

// Sends an intentionally minimal body: past Cloudflare the API answers 400, while a CF challenge
// answers a 403 HTML page — so we learn reachability without spending a completion.
async function probeCodex(provider: ProviderModule, credential: Credential): Promise<Check[]> {
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
        return [
          {
            kind: 'bad',
            text: 'cloudflare BLOCKED — try a residential IP or a TLS-impersonating client',
          },
        ]
      }
    }
    return [
      { kind: 'ok', text: `cloudflare reachable ${style.dim(`(probe status ${res.status})`)}` },
    ]
  } catch (error) {
    return [{ kind: 'warn', text: `cloudflare probe failed (${(error as Error).message})` }]
  }
}

async function probeXai(credential: Credential): Promise<Check[]> {
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 403) {
      return [{ kind: 'bad', text: 'tier DENIED — account not entitled to programmatic access' }]
    }
    if (!res.ok) return [{ kind: 'warn', text: `tier check failed (status ${res.status})` }]
    const models = parseModelList(await res.json()).map((m) => m.id)
    return [
      { kind: 'ok', text: 'tier entitled' },
      { kind: 'info', text: `models: ${models.join(', ') || '(none returned)'}` },
    ]
  } catch (error) {
    return [{ kind: 'warn', text: `tier probe failed (${(error as Error).message})` }]
  }
}
