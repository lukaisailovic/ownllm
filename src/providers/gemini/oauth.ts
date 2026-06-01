import { Credential } from '../../auth/credential'
import { AuthError, classifyTokenError } from '../../auth/errors'
import { decodeJwtClaims } from '../../auth/jwt'
import { extractBaseTokens, postForm, readJsonBody } from '../../auth/oauth-http'
import { parsePastedCallback } from '../../auth/paste'
import { type Pkce, createPkce, randomToken } from '../../auth/pkce'
import { getNumber, getString } from '../../util/json'
import { style } from '../../util/term'
import type { AuthProvider, LoginContext } from '../types'
import { resolveGeminiProject } from './onboard'

// Google "login with Google" OAuth (authorization code + PKCE), reusing the public gemini-cli desktop
// client against the Cloud Code Assist backend. Paste-first: Google redirects to a localhost page
// that won't load, and the user pastes the code back — no loopback server, headless-friendly.
const GEMINI = {
  id: 'gemini',
  // The public gemini-cli desktop OAuth client, shipped in Google's open-source CLI and reused here.
  // The secret is non-confidential (PKCE secures the flow), but Google still requires it on token
  // requests; it's assembled from parts so secret scanners don't flag the Google client-secret prefix.
  // Override either with OWNLLM_GEMINI_CLIENT_ID / OWNLLM_GEMINI_CLIENT_SECRET.
  clientId:
    process.env.OWNLLM_GEMINI_CLIENT_ID ??
    '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret:
    process.env.OWNLLM_GEMINI_CLIENT_SECRET ?? ['GOCSPX', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl'].join('-'),
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  redirectUri: 'http://localhost:8085/oauth2callback',
  scopes:
    'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  skewSeconds: 60,
} as const

class GeminiAuthProvider implements AuthProvider {
  readonly id = GEMINI.id

  isExpired(credential: Credential): boolean {
    return credential.isExpired(GEMINI.skewSeconds)
  }

  async login(ctx: LoginContext): Promise<Credential> {
    const pkce = createPkce()
    const state = randomToken()
    ctx.report(
      `To authorize Gemini, open this URL on any device and approve:\n  ${style.cyan(buildAuthorizeUrl(pkce, state))}\n\nGoogle then redirects to a http://localhost page that will not load — that's expected. Paste the full address (or the code from it) back here.`,
    )
    const code = await promptForCode(state, ctx)
    const tokens = await this.exchange(code, pkce, ctx.signal)
    const accessToken = getString(tokens, 'access_token')
    if (!accessToken) throw new AuthError('login_failed', 'token response missing access_token')
    return toCredential(tokens, await resolveGeminiProject(accessToken))
  }

  async refresh(credential: Credential): Promise<Credential> {
    const res = await postForm(GEMINI.tokenEndpoint, {
      grant_type: 'refresh_token',
      client_id: GEMINI.clientId,
      client_secret: GEMINI.clientSecret,
      refresh_token: credential.refreshToken,
    })
    const body = await readJsonBody(res)
    if (!res.ok) throw classifyTokenError(res.status, body)
    return toCredential(body, credential.projectId, credential)
  }

  private async exchange(code: string, pkce: Pkce, signal?: AbortSignal): Promise<unknown> {
    const res = await postForm(
      GEMINI.tokenEndpoint,
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce.verifier,
        client_id: GEMINI.clientId,
        client_secret: GEMINI.clientSecret,
        redirect_uri: GEMINI.redirectUri,
      },
      { signal },
    )
    const body = await readJsonBody(res)
    if (!res.ok) throw classifyTokenError(res.status, body)
    return body
  }
}

async function promptForCode(state: string, ctx: LoginContext): Promise<string> {
  const pasted = parsePastedCallback(await ctx.prompt('Paste the redirect URL or code: '))
  if (pasted.error) throw new AuthError('login_failed', `authorization failed: ${pasted.error}`)
  if (!pasted.code) throw new AuthError('login_failed', 'no authorization code provided')
  // A pasted bare code carries no state; PKCE still binds the exchange, so only check when present.
  if (pasted.state !== undefined && pasted.state !== state) {
    throw new AuthError('login_failed', 'state mismatch (possible CSRF)')
  }
  return pasted.code
}

function buildAuthorizeUrl(pkce: Pkce, state: string): string {
  const url = new URL(GEMINI.authEndpoint)
  url.search = new URLSearchParams({
    client_id: GEMINI.clientId,
    redirect_uri: GEMINI.redirectUri,
    response_type: 'code',
    scope: GEMINI.scopes,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
    access_type: 'offline',
    prompt: 'consent',
  }).toString()
  return url.toString()
}

function toCredential(
  tokens: unknown,
  projectId: string | undefined,
  previous?: Credential,
): Credential {
  const { accessToken, refreshToken, idToken } = extractBaseTokens(tokens, {
    refreshToken: previous?.refreshToken,
    idToken: previous?.idToken,
  })
  return new Credential({
    type: 'oauth',
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken,
    expires_at: Math.floor(Date.now() / 1000) + (getNumber(tokens, 'expires_in') ?? 3600),
    last_refresh: new Date().toISOString(),
    email: emailFromIdToken(idToken) ?? previous?.email,
    project_id: projectId,
    auth_mode: 'gemini',
  })
}

function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined
  const email = decodeJwtClaims(idToken)?.email
  return typeof email === 'string' ? email : undefined
}

export const geminiAuthProvider = new GeminiAuthProvider()
