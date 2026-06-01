import { randomUUID } from 'node:crypto'
import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import {
  extractBaseTokens,
  parseTokenResponse,
  postForm,
  readJsonBody,
} from '../../auth/oauth-http'
import { type Pkce, createPkce, randomToken } from '../../auth/pkce'
import { delay } from '../../util/async'
import { getNumber, getString } from '../../util/json'
import { style } from '../../util/term'
import type { AuthProvider, LoginContext } from '../types'

// MiniMax OAuth: a PKCE-protected `user_code` grant (device-flow shaped). The access token is a
// short-lived Bearer for MiniMax's Anthropic-compatible endpoint; refresh rotates both tokens.
const MINIMAX = {
  id: 'minimax',
  clientId: '78257093-7e40-4613-99e0-527b14b39113',
  portalBase: 'https://api.minimax.io',
  scope: 'group_id profile model.completion',
  skewSeconds: 60,
} as const

const USER_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:user_code'
const POLL_TIMEOUT_MS = 15 * 60 * 1000
const POLL_INTERVAL_MS = 5_000
const DEFAULT_TTL_SECONDS = 900

class MinimaxAuthProvider implements AuthProvider {
  readonly id = MINIMAX.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(MINIMAX.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const pkce = createPkce()
    const state = randomToken()
    const { userCode, verificationUri } = await this.requestUserCode(pkce, state, ctx.signal)
    ctx.report(
      `To authorize MiniMax, open this URL on any device:\n  ${style.cyan(verificationUri)}\nand enter the code: ${style.bold(userCode)}`,
    )
    return toCredential(await this.pollForTokens(userCode, pkce, ctx))
  }

  async refresh(credential: Credential): Promise<Credential> {
    const res = await postForm(`${MINIMAX.portalBase}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: MINIMAX.clientId,
      refresh_token: credential.refreshToken,
    })
    return toCredential(await parseTokenResponse(res), credential)
  }

  private async requestUserCode(
    pkce: Pkce,
    state: string,
    signal?: AbortSignal,
  ): Promise<{ userCode: string; verificationUri: string }> {
    const res = await postForm(
      `${MINIMAX.portalBase}/oauth/code`,
      {
        response_type: 'code',
        client_id: MINIMAX.clientId,
        scope: MINIMAX.scope,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        state,
      },
      { signal, headers: { 'x-request-id': randomUUID() } },
    )
    const body = await parseTokenResponse(res)
    const userCode = getString(body, 'user_code')
    const verificationUri = getString(body, 'verification_uri')
    if (!userCode || !verificationUri) {
      throw new AuthError('login_failed', 'MiniMax authorization response was incomplete')
    }
    const returnedState = getString(body, 'state')
    if (returnedState !== undefined && returnedState !== state) {
      throw new AuthError('login_failed', 'state mismatch (possible CSRF)')
    }
    return { userCode, verificationUri }
  }

  private async pollForTokens(userCode: string, pkce: Pkce, ctx: LoginContext): Promise<unknown> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      if (ctx.signal?.aborted) throw new AuthError('login_cancelled', 'login cancelled')
      await delay(POLL_INTERVAL_MS, ctx.signal)
      if (Date.now() > deadline) throw new AuthError('login_timeout', 'authorization timed out')

      const res = await postForm(
        `${MINIMAX.portalBase}/oauth/token`,
        {
          grant_type: USER_CODE_GRANT,
          client_id: MINIMAX.clientId,
          user_code: userCode,
          code_verifier: pkce.verifier,
        },
        { signal: ctx.signal },
      )
      const body = await readJsonBody(res)
      if (getString(body, 'access_token')) return body
      const status = getString(body, 'status')
      if (status === 'pending') continue
      throw new AuthError('login_failed', `authorization failed${status ? ` (${status})` : ''}`)
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
    expires_at: resolveExpiry(getNumber(tokens, 'expired_in')),
    last_refresh: new Date().toISOString(),
  })
}

// MiniMax's `expired_in` is sent inconsistently as a TTL in seconds or an absolute unix timestamp
// (s or ms); normalize all three to absolute epoch seconds.
function resolveExpiry(expiredIn: number | undefined): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (expiredIn === undefined) return nowSeconds + DEFAULT_TTL_SECONDS
  if (expiredIn > 1e12) return Math.floor(expiredIn / 1000)
  if (expiredIn > 1e9) return expiredIn
  return nowSeconds + expiredIn
}

export const minimaxAuthProvider = new MinimaxAuthProvider()
