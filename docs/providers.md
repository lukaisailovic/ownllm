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

ownllm ships four translators under [`src/translate/`](../src/translate): `responses` (Codex, xAI),
`chat` (Copilot, Qwen, Claude CLI adapter), `anthropic` (MiniMax), and `gemini` (Google Cloud Code
Assist). Reuse the one that matches your provider's wire format; for a brand-new format, add a
`translate/<format>/` implementation — the router and server don't change. They all share the
format-agnostic helpers in [`src/translate/wire.ts`](../src/translate/wire.ts).

## 3. Transport

Everything about reaching the upstream:

```ts
interface Transport {
  hosts: string[]                                  // allowlist; the client refuses other hosts
  endpoint(ctx: TranslateContext): string
  headers(cred: Credential, ctx): Record<string, string>
  sanitizeBody?(body, ctx, cred): unknown          // provider quirks ONLY (cred for per-account fields)
  client(): UpstreamClient                         // plain | cookie-jar | (future) TLS-impersonation
  classifyError(status, headers, body): OwnllmError
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
  my-provider:
    enabled: true
models:
  my-model:
    provider: my-provider
    upstream: upstream-model-id
```

The `providers` block is an open record keyed by id (not a closed enum), so a new id needs no schema
change. Worked examples, by wire format:

- **Responses** — [`codex`](../src/providers/codex) (device-code auth, Cloudflare-aware transport,
  cookie jar) and [`xai`](../src/providers/xai) (loopback/paste auth, `x-grok-conv-id`, a
  `sanitize.ts` of quirks, live model discovery, `403 → xai_tier_denied`).
- **Chat Completions** — [`copilot`](../src/providers/copilot) (GitHub device-code login then a
  Copilot-token exchange in `refresh`) and [`qwen`](../src/providers/qwen) (device-code + PKCE).
- **Claude Code CLI** — [`claude`](../src/providers/claude) shells out to the locally authenticated
  `claude -p` command and emits OpenAI-compatible SSE; it stores only a local-auth placeholder and
  has no Anthropic API-key path.
- **Anthropic Messages** — [`minimax`](../src/providers/minimax) (PKCE user-code grant).
- **Gemini** — [`gemini`](../src/providers/gemini) (Google auth-code + PKCE paste flow, a login-time
  Cloud Code project-onboarding step in `onboard.ts`, and a `sanitizeBody` that folds the account's
  project into each request).
