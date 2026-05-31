import { createHash, randomBytes } from 'node:crypto'

export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
