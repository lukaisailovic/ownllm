import { z } from 'zod'
import { isLoopbackHost } from './loopback'

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const

export const ServerConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  api_key: z.string().min(1).optional(),
  request_timeout_ms: z.number().int().positive().default(600_000),
  strict_params: z.boolean().default(false),
})

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
})

export const ModelRouteSchema = z.object({
  provider: z.string().min(1),
  upstream: z.string().min(1),
  reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
})

export const ConfigSchema = z
  .object({
    server: ServerConfigSchema.default({}),
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    models: z.record(z.string(), ModelRouteSchema).default({}),
  })
  .superRefine((config, ctx) => {
    if (!isLoopbackHost(config.server.host) && !config.server.api_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['server', 'api_key'],
        message: 'required when host is not loopback (refusing to start fail-open)',
      })
    }
    for (const [name, route] of Object.entries(config.models)) {
      if (route.provider in config.providers) continue
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', name, 'provider'],
        message: `unknown provider '${route.provider}' (not declared under providers)`,
      })
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type ModelRoute = z.infer<typeof ModelRouteSchema>
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
