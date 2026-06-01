import type { Credential } from '../auth/credential'
import type { UpstreamClient } from '../http/upstream-client'
import type { OwnllmError } from '../translate/errors'
import type { TranslateContext, Translator } from '../translate/types'

export interface LoginContext {
  signal?: AbortSignal
  report(message: string): void
  // Read one line of input from the user (e.g. a pasted OAuth code); rejects if input is aborted.
  prompt(message: string): Promise<string>
  // User asked to skip the browser/loopback and paste the code by hand (headless, Docker, SSH).
  manual?: boolean
}

// An AuthProvider owns one provider's OAuth lifecycle: interactive login, token refresh, and the
// expiry policy (provider-specific clock skew). The rest of ownllm treats credentials opaquely.
export interface AuthProvider {
  readonly id: string
  login(ctx: LoginContext): Promise<Credential>
  refresh(credential: Credential): Promise<Credential>
  isExpired(credential: Credential): boolean
}

export interface ModelInfo {
  id: string
}

export interface Capabilities {
  stream: boolean
  tools: boolean
  vision: boolean
  reasoning: boolean
}

// The transport owns everything about reaching one provider's upstream: where, with which headers,
// host-pinning, provider-only body quirks, the HTTP client, and how to classify failures.
export interface Transport {
  hosts: string[]
  endpoint(ctx: TranslateContext): string
  headers(credential: Credential, ctx: TranslateContext): Record<string, string>
  // credential is supplied so a provider can fold per-account state (e.g. Gemini's project id) into
  // the body; most providers ignore it and own only their wire quirks here.
  sanitizeBody?(body: unknown, ctx: TranslateContext, credential: Credential): unknown
  client(): UpstreamClient
  classifyError(status: number, headers: Headers, body: string): OwnllmError
}

// A provider is one self-contained module: auth + translator + transport + capabilities + catalog.
// Adding a provider means implementing this and registering it — no core edits. (PLAN §5.)
export interface ProviderModule {
  id: string
  aliases?: string[]
  auth: AuthProvider
  translator: Translator
  transport: Transport
  capabilities: Capabilities
  listModels(credential?: Credential): Promise<ModelInfo[]>
}
