import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { postForm, readJsonBody } from '../../auth/oauth-http'
import { delay } from '../../util/async'
import { getNumber, getString } from '../../util/json'
import { style } from '../../util/term'
import type { AuthProvider, LoginContext } from '../types'

// GitHub Copilot. A GitHub OAuth device-code login yields a durable GitHub token, which is exchanged
// for a short-lived Copilot API token used as the inference bearer. We persist the Copilot token as
// access_token and the durable GitHub token as refresh_token, so refresh() simply re-exchanges —
// reusing ownllm's single-flight refresh + reactive-401 machinery unchanged.
const COPILOT = {
  id: 'copilot',
  clientId: 'Ov23li8tweQw6odWQebz', // GitHub OAuth app (public; the one the Copilot/opencode CLIs use)
  deviceCodeUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  exchangeUrl: 'https://api.github.com/copilot_internal/v2/token',
  scope: 'read:user',
  editorVersion: 'vscode/1.104.1',
  exchangeUserAgent: 'GitHubCopilotChat/0.26.7',
  skewSeconds: 120,
  fallbackTtlSeconds: 1800,
} as const

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const POLL_TIMEOUT_MS = 15 * 60 * 1000

interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
}

class CopilotAuthProvider implements AuthProvider {
  readonly id = COPILOT.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(COPILOT.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const device = await this.requestDeviceCode(ctx.signal)
    ctx.report(
      `To authorize GitHub Copilot, open this URL on any device:\n  ${style.cyan(device.verificationUri)}\nand enter the code: ${style.bold(device.userCode)}`,
    )
    const githubToken = await this.pollForGithubToken(device, ctx)
    return exchangeForCopilotToken(githubToken)
  }

  // The durable GitHub token lives in refresh_token; mint a fresh Copilot API token from it.
  refresh(credential: Credential): Promise<Credential> {
    return exchangeForCopilotToken(credential.refreshToken)
  }

  private async requestDeviceCode(signal?: AbortSignal): Promise<DeviceCode> {
    const res = await postForm(
      COPILOT.deviceCodeUrl,
      { client_id: COPILOT.clientId, scope: COPILOT.scope },
      { signal },
    )
    const body = await readJsonBody(res)
    const deviceCode = getString(body, 'device_code')
    const userCode = getString(body, 'user_code')
    const verificationUri = getString(body, 'verification_uri')
    if (!deviceCode || !userCode || !verificationUri) {
      throw new AuthError('login_failed', 'GitHub device-code response was incomplete')
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      intervalMs: (getNumber(body, 'interval') ?? 5) * 1000,
    }
  }

  private async pollForGithubToken(device: DeviceCode, ctx: LoginContext): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let intervalMs = device.intervalMs
    for (;;) {
      if (ctx.signal?.aborted) throw new AuthError('login_cancelled', 'login cancelled')
      await delay(intervalMs, ctx.signal)
      if (Date.now() > deadline) {
        throw new AuthError('login_timeout', 'device authorization timed out')
      }

      const res = await postForm(
        COPILOT.tokenUrl,
        { client_id: COPILOT.clientId, device_code: device.deviceCode, grant_type: DEVICE_GRANT },
        { signal: ctx.signal },
      )
      const body = await readJsonBody(res)
      const token = getString(body, 'access_token')
      if (token) return token
      // RFC 8628: GitHub returns 200 + {error} while the user has not approved yet.
      const error = getString(body, 'error')
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        intervalMs += (getNumber(body, 'interval') ?? 5) * 1000
        continue
      }
      throw new AuthError(
        'login_failed',
        `device authorization failed${error ? ` (${error})` : ''}`,
      )
    }
  }
}

// Swaps a GitHub token for a short-lived Copilot API token (a semicolon-delimited string, not a
// JWT). The `token` scheme (not `Bearer`) and Editor-Version header are required by the endpoint.
async function exchangeForCopilotToken(githubToken: string): Promise<Credential> {
  const res = await fetch(COPILOT.exchangeUrl, {
    headers: {
      authorization: `token ${githubToken}`,
      'user-agent': COPILOT.exchangeUserAgent,
      accept: 'application/json',
      'editor-version': COPILOT.editorVersion,
    },
  })
  const body = await readJsonBody(res)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        'credential_dead',
        'GitHub account is not entitled to Copilot; re-login required',
      )
    }
    throw new AuthError('oauth_error', `Copilot token exchange failed (${res.status})`)
  }
  const token = getString(body, 'token')
  if (!token) throw new AuthError('login_failed', 'Copilot token exchange returned no token')
  const nowSeconds = Math.floor(Date.now() / 1000)
  return new Credential({
    type: 'oauth',
    access_token: token,
    refresh_token: githubToken,
    expires_at: getNumber(body, 'expires_at') ?? nowSeconds + COPILOT.fallbackTtlSeconds,
    last_refresh: new Date().toISOString(),
    auth_mode: 'copilot',
  })
}

export const copilotAuthProvider = new CopilotAuthProvider()
