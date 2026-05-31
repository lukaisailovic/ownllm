import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// '../package.json' resolves from both src/meta.ts (dev/test) and the bundled
// dist/main.js (npm + Docker), keeping package.json the single source of the version.
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }

export const NAME = 'ownllm'
export const VERSION = pkg.version
export const DESCRIPTION =
  'Subscription-auth, OpenAI-compatible API gateway with real model routing.'
