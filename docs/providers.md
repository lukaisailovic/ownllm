# Adding a provider

A provider is one self-contained module. Adding one is: implement `ProviderModule`, register it,
and enable it in config. No core edits — the router and server only ever call the registry and the
module interfaces.

The contract lives in [`src/providers/types.ts`](../src/providers/types.ts):

```ts
interface ProviderModule {
  id: string
  aliases?: string[]
  auth: AuthProvider          // OAuth login / refresh / expiry policy
  translator: Translator      // CC <-> native wire format (reuse or bespoke)
  transport: Transport        // endpoint, headers, host-pinning, sanitize, client, errors
  capabilities: { stream: boolean; tools: boolean; vision: boolean; reasoning: boolean }
  listModels(cred?: Credential): Promise<ModelInfo[]>
}
```

## 1. AuthProvider

Owns the OAuth lifecycle and the expiry policy (its own clock skew). See [auth](./auth.md). For a
provider that speaks standard OAuth, `login` runs the interactive flow and returns a `Credential`;
`refresh` exchanges the refresh token; `isExpired` applies the provider's skew.

## 2. Translator

Format-agnostic; converts between Chat Completions and the provider's native wire format:

```ts
interface Translator {
  toUpstream(req: ChatCompletionRequest, ctx: TranslateContext): unknown
  fromUpstream(events: AsyncIterable<SSEvent>, ctx): Promise<ChatCompletionResponse>  // aggregate
  streamToChunks(events: AsyncIterable<SSEvent>, ctx): AsyncIterable<ChatCompletionChunk>
}
```

If your provider speaks the OpenAI Responses API (Codex and xAI both do), reuse the shared
`responsesTranslator` from [`src/translate/responses`](../src/translate/responses/index.ts). If it
speaks Chat Completions, Anthropic Messages, or Gemini, add a new `translate/<format>/`
implementation — the router and server don't change.

## 3. Transport

Everything about reaching the upstream:

```ts
interface Transport {
  hosts: string[]                                  // allowlist; the client refuses other hosts
  endpoint(ctx: TranslateContext): string
  headers(cred: Credential, ctx): Record<string, string>
  sanitizeBody?(body: unknown, ctx): unknown       // provider quirks ONLY
  client(): UpstreamClient                         // plain | cookie-jar | (future) TLS-impersonation
  classifyError(status, headers, body): LlmgateError
}
```

**Ownership rule (avoid drift):** the base translator owns all provider-agnostic CC→native
semantics (multimodal, `response_format`, `reasoning_effort`, tool flattening, `max_tokens`
precedence). `sanitizeBody` owns *only* this provider's quirks. Nothing should be done in both.

`classifyError` is where provider-specific status handling lives — e.g. a Cloudflare 403 is a
transport block (502 `codex_cloudflare_blocked`), not an auth failure; an xAI 403 is
`xai_tier_denied`.

## 4. Register and enable

```ts
// src/providers/registry.ts
registerProvider(myModule)
```

```yaml
# config.yaml
providers:
  my-provider: { enabled: true }
models:
  my-model: { provider: my-provider, upstream: upstream-model-id }
```

The `providers` block is an open record keyed by id (not a closed enum), so a new id needs no schema
change. Worked example: [`src/providers/codex`](../src/providers/codex) (module + transport +
static catalog) reusing the Responses translator.
