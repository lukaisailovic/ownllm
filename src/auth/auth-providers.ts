import { codexAuthProvider } from '../providers/codex/oauth'
import type { AuthProvider } from '../providers/types'
import { xaiAuthProvider } from '../providers/xai/oauth'

// v1 wiring of AuthProviders by id. P3 introduces the full ProviderModule registry; the auth map
// will be derived from it then.
export const authProviders: Map<string, AuthProvider> = new Map(
  [codexAuthProvider, xaiAuthProvider].map((provider) => [provider.id, provider]),
)

export function getAuthProvider(id: string): AuthProvider | undefined {
  return authProviders.get(id)
}

export function authProviderIds(): string[] {
  return [...authProviders.keys()]
}
