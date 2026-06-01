export interface PastedCallback {
  code?: string
  state?: string
  error?: string
}

// Parses what a user pastes in a manual OAuth flow: a full loopback callback URL, a bare
// `code=...&state=...` query, or just the opaque code some providers render in-page instead.
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
