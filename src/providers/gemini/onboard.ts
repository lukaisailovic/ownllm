import { randomUUID } from 'node:crypto'
import { AuthError } from '../../auth/errors'
import { readJsonBody } from '../../auth/oauth-http'
import { delay } from '../../util/async'
import { asRecord, getString } from '../../util/json'
import {
  GEMINI_CLI_USER_AGENT,
  GEMINI_CODE_ASSIST_HOST,
  GEMINI_GOOG_API_CLIENT,
} from './fingerprint'

const BASE = `https://${GEMINI_CODE_ASSIST_HOST}/v1internal`
const CLIENT_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
}
const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 12

// Cloud Code Assist requires a project id in every inference body. Resolve it once at login:
// loadCodeAssist returns the account's assigned project (paid) or none (free); for free we provision
// one via onboardUser and poll its long-running operation. An env project short-circuits discovery.
export async function resolveGeminiProject(accessToken: string): Promise<string> {
  const envProject = process.env.OWNLLM_GEMINI_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? ''
  const loaded = await loadCodeAssist(accessToken, envProject)
  if (loaded.project) return loaded.project
  return onboardUser(accessToken, loaded.tier ?? 'free-tier', envProject)
}

async function loadCodeAssist(
  accessToken: string,
  project: string,
): Promise<{ project?: string; tier?: string }> {
  const metadata: Record<string, unknown> = { ...CLIENT_METADATA }
  if (project) metadata.duetProject = project
  const body: Record<string, unknown> = { metadata }
  if (project) body.cloudaicompanionProject = project

  const data = await call(':loadCodeAssist', accessToken, body)
  return {
    project: getString(data, 'cloudaicompanionProject'),
    tier: getString(asRecord(data)?.currentTier, 'id'),
  }
}

async function onboardUser(accessToken: string, tier: string, project: string): Promise<string> {
  const body: Record<string, unknown> = { tierId: tier, metadata: CLIENT_METADATA }
  if (project) body.cloudaicompanionProject = project

  let operation = await call(':onboardUser', accessToken, body)
  for (let poll = 0; poll < MAX_POLLS && !asRecord(operation)?.done; poll++) {
    const name = getString(operation, 'name')
    if (!name) break
    await delay(POLL_INTERVAL_MS)
    operation = await call(`/${name}`, accessToken, {})
  }

  const onboarded = getString(asRecord(asRecord(operation)?.response), 'cloudaicompanionProject')
  if (!onboarded) throw new AuthError('login_failed', 'Gemini onboarding did not return a project')
  return onboarded
}

async function call(pathSuffix: string, accessToken: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${pathSuffix}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': GEMINI_CLI_USER_AGENT,
      'x-goog-api-client': GEMINI_GOOG_API_CLIENT,
      'x-activity-request-id': randomUUID(),
    },
    body: JSON.stringify(body),
  })
  const data = await readJsonBody(res)
  if (!res.ok) throw new AuthError('login_failed', `Gemini ${pathSuffix} failed (${res.status})`)
  return data
}
