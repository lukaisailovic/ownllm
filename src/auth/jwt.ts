// Decodes JWT claims WITHOUT signature verification. We only read claims from tokens we just
// received over TLS from the issuer's token endpoint, so there is nothing to verify against.
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(json)
    return typeof claims === 'object' && claims !== null ? claims : undefined
  } catch {
    return undefined
  }
}

export function jwtExpirySeconds(token: string): number | undefined {
  const exp = decodeJwtClaims(token)?.exp
  return typeof exp === 'number' ? exp : undefined
}
