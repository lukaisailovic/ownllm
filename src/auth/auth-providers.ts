import { listProviderModules } from '../providers/registry'
import type { AuthProvider } from '../providers/types'

// AuthProviders derived from the provider registry: every module contributes its auth lifecycle
// keyed by the module id, so registering a provider wires up its login/refresh with no edit here.
export const authProviders: Map<string, AuthProvider> = new Map(
  listProviderModules().map((module) => [module.id, module.auth]),
)

export function getAuthProvider(id: string): AuthProvider | undefined {
  return authProviders.get(id)
}

export function authProviderIds(): string[] {
  return [...authProviders.keys()]
}
