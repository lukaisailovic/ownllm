import { pino } from 'pino'

const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  'cf_clearance',
]

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '***' },
  })
}

export const logger = createLogger()

export type Logger = ReturnType<typeof createLogger>
