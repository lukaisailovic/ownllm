import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { decodeJwtClaims, jwtExpirySeconds } from '../../auth/jwt'
import {
  extractBaseTokens,
  parseTokenResponse,
  postForm,
  postJson,
  readJsonBody,
} from '../../auth/oauth-http'
import { delay } from '../../util/async'
import { asRecord, getNumber, getString } from '../../util/json'
import type { AuthProvider, LoginContext } from '../types'

// Codex (ChatGPT) device-code flow, per PLAN §9a. These are version-sensitive defaults.
const CODEX = {
  id: 'openai-codex',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  usercodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  devicePageUrl: 'https://auth.openai.com/codex/device',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
  skewSeconds: 300,
} as const

const POLL_TIMEOUT_MS = 15 * 60 * 1000
const ACCOUNT_ID_CLAIM = 'https://api.openai.com/auth'

interface DeviceAuth {
  userCode: string
  deviceAuthId: string
  intervalMs: number
}

interface Grant {
  authorizationCode: string
  codeVerifier: string
}

class CodexAuthProvider implements AuthProvider {
  readonly id = CODEX.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(CODEX.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const device = await this.startDeviceAuth(ctx.signal)
    ctx.report(
      `To authorize Codex, open this URL on any device:\n  ${CODEX.devicePageUrl}\nand enter the code: ${device.userCode}`,
    )
    const grant = await this.pollForGrant(device, ctx)
    const tokens = await this.exchange(grant, ctx.signal)
    return codexCredentialFromTokens(tokens)
  }

  async refresh(credential: Credential): Promise<Credential> {
    const res = await postForm(CODEX.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: CODEX.clientId,
      refresh_token: credential.refreshToken,
    })
    return codexCredentialFromTokens(await parseTokenResponse(res), credential)
  }

  private async startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuth> {
    const res = await postJson(CODEX.usercodeUrl, { client_id: CODEX.clientId }, { signal })
    const body = await parseTokenResponse(res)
    const userCode = getString(body, 'user_code')
    const deviceAuthId = getString(body, 'device_auth_id')
    if (!userCode || !deviceAuthId) {
      throw new AuthError(
        'login_failed',
        'device authorization response missing user_code/device_auth_id',
      )
    }
    return { userCode, deviceAuthId, intervalMs: (getNumber(body, 'interval') ?? 5) * 1000 }
  }

  private async pollForGrant(device: DeviceAuth, ctx: LoginContext): Promise<Grant> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      if (ctx.signal?.aborted) throw new AuthError('login_cancelled', 'login cancelled')
      await delay(device.intervalMs, ctx.signal)
      if (Date.now() > deadline)
        throw new AuthError('login_timeout', 'device authorization timed out')

      const res = await postJson(
        CODEX.deviceTokenUrl,
        { device_auth_id: device.deviceAuthId, user_code: device.userCode },
        { signal: ctx.signal },
      )
      const body = await readJsonBody(res)
      if (res.ok) {
        const authorizationCode = getString(body, 'authorization_code')
        const codeVerifier = getString(body, 'code_verifier')
        if (authorizationCode && codeVerifier) return { authorizationCode, codeVerifier }
        throw new AuthError('login_failed', 'device authorization missing authorization_code')
      }
      // OpenAI reports "still pending" as a 403 (sometimes 404), not RFC-8628's 400 +
      // authorization_pending — so keep polling on those; the deadline above bounds the wait.
      if (res.status === 403 || res.status === 404) continue
      const message = getString(asRecord(body)?.error, 'message')
      throw new AuthError(
        'login_failed',
        `device authorization failed (${res.status}${message ? `, ${message}` : ''})`,
      )
    }
  }

  private async exchange(grant: Grant, signal?: AbortSignal): Promise<unknown> {
    const res = await postForm(
      CODEX.tokenUrl,
      {
        grant_type: 'authorization_code',
        client_id: CODEX.clientId,
        code: grant.authorizationCode,
        code_verifier: grant.codeVerifier,
        redirect_uri: CODEX.redirectUri,
      },
      { signal },
    )
    return parseTokenResponse(res)
  }
}

// Builds a Codex credential from an OAuth token response or an imported ~/.codex token object.
export function codexCredentialFromTokens(tokens: unknown, previous?: Credential): Credential {
  const { accessToken, refreshToken, idToken } = extractBaseTokens(tokens, {
    refreshToken: previous?.refreshToken,
    idToken: previous?.idToken,
  })

  return new Credential({
    type: 'oauth',
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken,
    // Codex expiry is the access_token's JWT exp; no exp derivable => 0 (treated as expired).
    expires_at: jwtExpirySeconds(accessToken) ?? 0,
    last_refresh: new Date().toISOString(),
    account_id: extractAccountId(idToken) ?? previous?.accountId,
    auth_mode: 'chatgpt',
  })
}

function extractAccountId(idToken?: string): string | undefined {
  if (!idToken) return undefined
  const auth = asRecord(decodeJwtClaims(idToken)?.[ACCOUNT_ID_CLAIM])
  const id = auth?.chatgpt_account_id
  return typeof id === 'string' ? id : undefined
}

export const codexAuthProvider = new CodexAuthProvider()
