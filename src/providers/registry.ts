import { codexModule } from './codex/module'
import type { ProviderModule } from './types'
import { xaiModule } from './xai/module'

// Provider registry keyed by id (and aliases). The server core routes by id via config and never
// names a provider directly; adding one is register() + config, with zero core edits. (PLAN §5.)
const modules = new Map<string, ProviderModule>()

export function registerProvider(module: ProviderModule): void {
  modules.set(module.id, module)
  for (const alias of module.aliases ?? []) modules.set(alias, module)
}

export function getProvider(id: string): ProviderModule | undefined {
  return modules.get(id)
}

export function listProviderModules(): ProviderModule[] {
  return [...new Set(modules.values())]
}

registerProvider(codexModule)
registerProvider(xaiModule)
