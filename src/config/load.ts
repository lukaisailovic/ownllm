import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { type Config, ConfigSchema } from './schema'

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export interface ConfigIssue {
  path: string
  message: string
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] }

interface Interpolation {
  value: unknown
  missing: ConfigIssue[]
}

// Interpolates ${ENV} references in string values of the parsed document. Running after the
// YAML parse (not on raw text) keeps comments out of interpolation and yields config-path errors.
export function interpolateEnv(
  document: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Interpolation {
  const missing: ConfigIssue[] = []
  const value = walk(document, '', env, missing)
  return { value, missing }
}

function walk(
  value: unknown,
  path: string,
  env: NodeJS.ProcessEnv,
  missing: ConfigIssue[],
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_match, name: string) => {
      const resolved = env[name]
      if (resolved !== undefined) return resolved
      missing.push({
        path: path || '(root)',
        message: `environment variable \${${name}} is not set`,
      })
      return ''
    })
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, `${path}[${index}]`, env, missing))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        walk(item, path ? `${path}.${key}` : key, env, missing),
      ]),
    )
  }
  return value
}

export function parseConfig(raw: string, env?: NodeJS.ProcessEnv): ConfigResult {
  let document: unknown
  try {
    document = parseYaml(raw)
  } catch (error) {
    return { ok: false, issues: [{ path: '(yaml)', message: (error as Error).message }] }
  }

  const { value, missing } = interpolateEnv(document ?? {}, env)
  if (missing.length > 0) return { ok: false, issues: missing }

  const result = ConfigSchema.safeParse(value)
  if (result.success) return { ok: true, config: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  }
}

export function loadConfigOrExit(path: string): Config {
  const raw = readConfigFileOrExit(path)
  const result = parseConfig(raw)
  if (result.ok) return result.config

  process.stderr.write(`invalid config: ${path}\n`)
  for (const issue of result.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`)
  process.exit(1)
}

function readConfigFileOrExit(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`config not found: ${path}\nrun 'llmgate config init' to create one\n`)
    } else {
      process.stderr.write(`failed to read config ${path}: ${(error as Error).message}\n`)
    }
    process.exit(1)
  }
}
