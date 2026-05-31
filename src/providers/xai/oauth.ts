import { Credential } from '../../auth/credential'
import { AuthError, classifyTokenError } from '../../auth/errors'
import { decodeJwtClaims, jwtExpirySeconds } from '../../auth/jwt'
import { extractBaseTokens, postForm, readJsonBody } from '../../auth/oauth-http'
import { type Pkce, createPkce, randomToken } from '../../auth/pkce'
import { canOpenBrowser, isRemoteSession } from '../../util/environment'
import { getNumber, getString } from '../../util/json'
import type { AuthProvider, LoginContext } from '../types'
import { startLoopbackServer } from './loopback'

// xAI Grok Build OAuth, per PLAN §9b. Tier-gated and version-sensitive.
const XAI = {
  id: 'xai',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
  loopbackPort: 56121,
  callbackPath: '/callback',
  scopes: 'openid profile email offline_access grok-cli:access api:access',
  skewSeconds: 120,
} as const

interface Endpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
}

let cachedEndpoints: Endpoints | undefined

class XaiAuthProvider implements AuthProvider {
  readonly id = XAI.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(XAI.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const endpoints = await discoverEndpoints(ctx.signal)
    const pkce = createPkce()
    const state = randomToken()
    const nonce = randomToken()
    // Both paths use this loopback redirect_uri: the loopback server binds it, and the paste path
    // sends it byte-identical at exchange (xAI cross-checks redirect_uri against the authorize step).
    const redirectUri = `http://127.0.0.1:${XAI.loopbackPort}${XAI.callbackPath}`
    const authorizeUrl = buildAuthorizeUrl(endpoints.authorizationEndpoint, redirectUri, pkce, {
      state,
      nonce,
    })

    const code = usePasteFlow(ctx)
      ? await authorizeByPaste(authorizeUrl, state, ctx)
      : await authorizeByLoopback(authorizeUrl, state, ctx)

    const tokens = await this.exchange(endpoints.tokenEndpoint, code, redirectUri, pkce, ctx.signal)
    return toCredential(tokens, endpoints.tokenEndpoint, { expectedNonce: nonce })
  }

  async refresh(credential: Credential): Promise<Credential> {
    const tokenEndpoint = credential.tokenEndpoint ?? (await discoverEndpoints()).tokenEndpoint
    const res = await postForm(tokenEndpoint, {
      grant_type: 'refresh_token',
      client_id: XAI.clientId,
      refresh_token: credential.refreshToken,
    })
    const body = await readJsonBody(res)
    if (res.status === 403) throw tierDenied()
    if (!res.ok) throw classifyTokenError(res.status, body)
    return toCredential(body, tokenEndpoint, { previous: credential })
  }

  private async exchange(
    tokenEndpoint: string,
    code: string,
    redirectUri: string,
    pkce: Pkce,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await postForm(
      tokenEndpoint,
      {
        grant_type: 'authorization_code',
        client_id: XAI.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
        // xAI re-validates the challenge at exchange time (non-standard) — PLAN risk C.
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      },
      { signal },
    )
    const body = await readJsonBody(res)
    if (res.status === 403) throw tierDenied()
    if (!res.ok) throw classifyTokenError(res.status, body)
    return body
  }
}

// The loopback server only catches the redirect when the user's browser can reach this machine.
// On a remote/headless host (Docker, SSH, cloud shell) it can't, so fall back to pasting the code.
function usePasteFlow(ctx: LoginContext): boolean {
  return ctx.manual === true || isRemoteSession() || !canOpenBrowser()
}

async function authorizeByLoopback(
  authorizeUrl: string,
  state: string,
  ctx: LoginContext,
): Promise<string> {
  const server = await startLoopbackServer(XAI.loopbackPort, XAI.callbackPath)
  try {
    ctx.report(
      `To authorize Grok, open this URL in your browser:\n  ${authorizeUrl}\nThis machine is waiting for the redirect. If your browser cannot reach it (remote/Docker), press Ctrl-C and re-run with --manual.`,
    )

    const result = await server.waitForCallback(ctx.signal)
    if (result.state !== state)
      throw new AuthError('login_failed', 'state mismatch (possible CSRF)')
    return result.code
  } finally {
    server.close()
  }
}

async function authorizeByPaste(
  authorizeUrl: string,
  state: string,
  ctx: LoginContext,
): Promise<string> {
  ctx.report(
    `To authorize Grok, open this URL in any browser:\n  ${authorizeUrl}\n\nAfter approving, your browser is redirected to a http://127.0.0.1 page that will not load — that's expected. Paste the full address from the address bar (or the code shown on the page).`,
  )
  const pasted = parsePastedCallback(await ctx.prompt('Paste the callback URL or code: '))
  if (pasted.error) throw new AuthError('login_failed', `authorization failed: ${pasted.error}`)
  if (!pasted.code) throw new AuthError('login_failed', 'no authorization code provided')
  // A pasted bare code carries no state; PKCE still binds the exchange to this client, so only
  // enforce the state check when the pasted callback actually included one.
  if (pasted.state !== undefined && pasted.state !== state)
    throw new AuthError('login_failed', 'state mismatch (possible CSRF)')
  return pasted.code
}

export interface PastedCallback {
  code?: string
  state?: string
  error?: string
}

// Parses what a user pastes in the manual flow: a full loopback callback URL, a bare
// `code=...&state=...` query, or just the opaque code xAI sometimes renders in-page instead.
export function parsePastedCallback(raw: string): PastedCallback {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  let query: string
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    query = safeUrlSearch(trimmed)
  } else if (trimmed.includes('=')) {
    query = trimmed
  } else {
    return { code: trimmed }
  }

  const params = new URLSearchParams(query)
  return {
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    error: params.get('error') ?? undefined,
  }
}

function safeUrlSearch(url: string): string {
  try {
    return new URL(url).search
  } catch {
    return ''
  }
}

async function discoverEndpoints(signal?: AbortSignal): Promise<Endpoints> {
  if (cachedEndpoints) return cachedEndpoints
  const res = await fetch(XAI.discoveryUrl, { signal })
  if (!res.ok) throw new AuthError('oauth_error', `OIDC discovery failed (${res.status})`)
  const body = await res.json()
  const authorizationEndpoint = getString(body, 'authorization_endpoint')
  const tokenEndpoint = getString(body, 'token_endpoint')
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new AuthError('oauth_error', 'OIDC discovery missing authorization/token endpoint')
  }
  cachedEndpoints = { authorizationEndpoint, tokenEndpoint }
  return cachedEndpoints
}

function buildAuthorizeUrl(
  endpoint: string,
  redirectUri: string,
  pkce: Pkce,
  ids: { state: string; nonce: string },
): string {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: XAI.clientId,
    redirect_uri: redirectUri,
    scope: XAI.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    state: ids.state,
    nonce: ids.nonce,
    plan: 'generic',
    referrer: 'ownllm',
  }).toString()
  return url.toString()
}

function toCredential(
  tokens: unknown,
  tokenEndpoint: string,
  opts: { expectedNonce?: string; previous?: Credential } = {},
): Credential {
  const { accessToken, refreshToken, idToken } = extractBaseTokens(tokens, {
    refreshToken: opts.previous?.refreshToken,
    idToken: opts.previous?.idToken,
  })
  const claims = idToken ? decodeJwtClaims(idToken) : undefined

  if (opts.expectedNonce !== undefined && claims?.nonce !== opts.expectedNonce) {
    throw new AuthError('login_failed', 'id_token nonce mismatch')
  }

  const expiresIn = getNumber(tokens, 'expires_in')
  const expiresAt =
    expiresIn !== undefined
      ? Math.floor(Date.now() / 1000) + expiresIn
      : (jwtExpirySeconds(accessToken) ?? 0)

  return new Credential({
    type: 'oauth',
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken,
    expires_at: expiresAt,
    last_refresh: new Date().toISOString(),
    sub: (typeof claims?.sub === 'string' ? claims.sub : undefined) ?? opts.previous?.sub,
    email: (typeof claims?.email === 'string' ? claims.email : undefined) ?? opts.previous?.email,
    token_endpoint: tokenEndpoint,
  })
}

function tierDenied(): AuthError {
  return new AuthError('tier_denied', 'xAI denied programmatic access (account not entitled)')
}

export const xaiAuthProvider = new XaiAuthProvider()
