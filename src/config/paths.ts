import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Paths {
  configDir: string
  configFile: string
  authFile: string
  authLockFile: string
}

export function resolvePaths(): Paths {
  const configDir = process.env.LLMGATE_HOME ?? join(homedir(), '.llmgate')
  return {
    configDir,
    configFile: join(configDir, 'config.yaml'),
    authFile: join(configDir, 'auth.json'),
    authLockFile: join(configDir, 'auth.json.lock'),
  }
}
