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
  // Other model names to try, in order, when this model's request fails pre-first-byte. Targets
  // must be declared under `models`; cycles are allowed (resolution dedupes via a visited set).
  fallbacks: z.array(z.string().min(1)).optional(),
})

// Circuit-breaker policy for the fallback chain: a model that fails failure_threshold times in a
// row is skipped for cooldown_ms, then gets one trial request (success closes it, failure re-arms).
export const FallbackConfigSchema = z.object({
  failure_threshold: z.number().int().positive().default(3),
  cooldown_ms: z.number().int().nonnegative().default(30_000),
})

export const ConfigSchema = z
  .object({
    server: ServerConfigSchema.default({}),
    fallback: FallbackConfigSchema.default({}),
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
      if (!(route.provider in config.providers)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', name, 'provider'],
          message: `unknown provider '${route.provider}' (not declared under providers)`,
        })
      }
      for (const fallback of route.fallbacks ?? []) {
        if (fallback in config.models) continue
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', name, 'fallbacks'],
          message: `unknown fallback model '${fallback}' (not declared under models)`,
        })
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
export type FallbackConfig = z.infer<typeof FallbackConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type ModelRoute = z.infer<typeof ModelRouteSchema>
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
