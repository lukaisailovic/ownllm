import { getString } from '../util/json'
import { AuthError, classifyTokenError } from './errors'

interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}

export function postJson(url: string, body: unknown, opts: RequestOptions = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
}

export function postForm(
  url: string,
  params: Record<string, string>,
  opts: RequestOptions = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...opts.headers,
    },
    body: new URLSearchParams(params).toString(),
    signal: opts.signal,
  })
}

export async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// Reads a token-endpoint response, throwing a classified AuthError on any non-2xx. Providers with
// a status quirk (e.g. xAI 403 -> tier_denied) branch before delegating to classifyTokenError.
export async function parseTokenResponse(res: Response): Promise<unknown> {
  const body = await readJsonBody(res)
  if (!res.ok) throw classifyTokenError(res.status, body)
  return body
}

export interface BaseTokens {
  accessToken: string
  refreshToken: string
  idToken?: string
}

// Extracts the access/refresh/id tokens common to every provider, falling back to the prior
// credential when a refresh response omits a rotated refresh_token or id_token.
export function extractBaseTokens(
  tokens: unknown,
  fallback: { refreshToken?: string; idToken?: string } = {},
): BaseTokens {
  const accessToken = getString(tokens, 'access_token')
  if (!accessToken) throw new AuthError('login_failed', 'token response missing access_token')
  const refreshToken = getString(tokens, 'refresh_token') ?? fallback.refreshToken
  if (!refreshToken) throw new AuthError('login_failed', 'token response missing refresh_token')
  return { accessToken, refreshToken, idToken: getString(tokens, 'id_token') ?? fallback.idToken }
}
