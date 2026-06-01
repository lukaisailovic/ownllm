import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import {
  extractBaseTokens,
  parseTokenResponse,
  postForm,
  readJsonBody,
} from '../../auth/oauth-http'
import { type Pkce, createPkce } from '../../auth/pkce'
import { delay } from '../../util/async'
import { getNumber, getString } from '../../util/json'
import { style } from '../../util/term'
import type { AuthProvider, LoginContext } from '../types'

// Qwen (qwen.ai) OAuth 2.0 device flow with PKCE, matching the official `qwen` CLI. The access token
// is a Bearer for the OpenAI-compatible Qwen portal; refresh rotates the tokens. (Hermes only ships
// the refresh half — the device endpoints are the CLI's published values.)
const QWEN = {
  id: 'qwen',
  clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
  deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
  scope: 'openid profile email model.completion',
  skewSeconds: 120,
} as const

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const POLL_TIMEOUT_MS = 15 * 60 * 1000

interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
}

class QwenAuthProvider implements AuthProvider {
  readonly id = QWEN.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(QWEN.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const pkce = createPkce()
    const device = await this.requestDeviceCode(pkce, ctx.signal)
    ctx.report(
      `To authorize Qwen, open this URL on any device:\n  ${style.cyan(device.verificationUri)}\nand enter the code: ${style.bold(device.userCode)}`,
    )
    return toCredential(await this.pollForTokens(device, pkce, ctx))
  }

  async refresh(credential: Credential): Promise<Credential> {
    const res = await postForm(QWEN.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: QWEN.clientId,
      refresh_token: credential.refreshToken,
    })
    return toCredential(await parseTokenResponse(res), credential)
  }

  private async requestDeviceCode(pkce: Pkce, signal?: AbortSignal): Promise<DeviceCode> {
    const res = await postForm(
      QWEN.deviceCodeUrl,
      {
        client_id: QWEN.clientId,
        scope: QWEN.scope,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      },
      { signal },
    )
    const body = await readJsonBody(res)
    const deviceCode = getString(body, 'device_code')
    const userCode = getString(body, 'user_code')
    // verification_uri_complete already embeds the code, so a phone can approve without retyping.
    const verificationUri =
      getString(body, 'verification_uri_complete') ?? getString(body, 'verification_uri')
    if (!deviceCode || !userCode || !verificationUri) {
      throw new AuthError('login_failed', 'Qwen device-code response was incomplete')
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      intervalMs: (getNumber(body, 'interval') ?? 5) * 1000,
    }
  }

  private async pollForTokens(device: DeviceCode, pkce: Pkce, ctx: LoginContext): Promise<unknown> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let intervalMs = device.intervalMs
    for (;;) {
      if (ctx.signal?.aborted) throw new AuthError('login_cancelled', 'login cancelled')
      await delay(intervalMs, ctx.signal)
      if (Date.now() > deadline) {
        throw new AuthError('login_timeout', 'device authorization timed out')
      }

      const res = await postForm(
        QWEN.tokenUrl,
        {
          grant_type: DEVICE_GRANT,
          client_id: QWEN.clientId,
          device_code: device.deviceCode,
          code_verifier: pkce.verifier,
        },
        { signal: ctx.signal },
      )
      const body = await readJsonBody(res)
      if (res.ok && getString(body, 'access_token')) return body
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

function toCredential(tokens: unknown, previous?: Credential): Credential {
  const { accessToken, refreshToken } = extractBaseTokens(tokens, {
    refreshToken: previous?.refreshToken,
  })
  return new Credential({
    type: 'oauth',
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (getNumber(tokens, 'expires_in') ?? 3600),
    last_refresh: new Date().toISOString(),
  })
}

export const qwenAuthProvider = new QwenAuthProvider()
