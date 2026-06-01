# Architecture

ownllm is a small, provider-agnostic core wrapped around pluggable provider modules. The core
never names a provider: it routes by the requested `model` through a config table to a provider id,
looks that id up in a registry, and drives the provider through three interfaces — `AuthProvider`,
`Translator`, and `Transport`.

## Layers

```
src/
  cli/          citty commands: serve, auth, config, models, doctor
  config/       zod schema, ${ENV} loader, XDG-ish paths, loopback check
  server/       Hono app, middleware (requestId, clientAuth), routes, readiness
  router/       resolveModel/resolveChain (model -> ordered candidates) + fallback circuit breaker
  providers/    types (the extension contract), registry, codex/, xai/
  translate/    CC types + error factory + param policy; responses/ translator
  auth/         Credential, AuthStore (0600 + lock), single-flight RefreshManager
  http/         host-pinned UpstreamClient, Codex cookie jar, SSE parser
  util/         small async + json helpers
```

The dependency direction is roughly `cli → server → {router, providers, translate, auth} → http`.
`translate` is format-agnostic and knows nothing about any provider; `providers/codex` composes
the shared Responses translator with a Codex-specific transport.

## Request flow: `POST /v1/chat/completions`

1. **requestId** middleware mints or echoes `x-request-id`.
2. **clientAuth** middleware enforces `server.api_key` (timing-safe) unless the bind is loopback.
3. **Validate** the body against the Chat Completions zod schema (`translate/types.ts`).
4. **Param policy** (`translate/param-policy.ts`): `n>1` → 400; ignored params are dropped (or 400
   under `strict_params`).
5. **Resolve the candidate chain** via `router/resolve.ts`: the requested model plus its direct
   `fallbacks` (one level deep, deduped so cycles can't loop) → 404 `model_not_found` if the
   requested model is absent. Ordered healthy-first by the per-model breaker (`router/breaker.ts`).
6. **Wire abort**: one `AbortController` fed by both `request_timeout_ms` and the client's
   `c.req.raw.signal`, shared across every candidate attempt, so a disconnect aborts the upstream.
7. **Attempt candidates in order** until one yields a streamable upstream. Each attempt resolves the
   provider, ensures a fresh credential (single-flight `RefreshManager`), builds context (requested
   model echoed back, upstream model, deterministic conversation id, `include_usage`, per-model
   reasoning effort), translates CC → wire (`translator.toUpstream`) + sanitizes
   (`transport.sanitizeBody`), and POSTs through the host-pinned client, always streaming.
8. **On a pre-first-byte failure** (connection error, non-2xx, dead credential) record it on the
   breaker and try the next candidate; an abort (disconnect/timeout) stops the loop without
   penalizing the model. Exhausting the chain throws the last error.
9. **Relay or aggregate** the winner (and set `x-ownllm-served-by`): if the client asked for
   `stream:true`, relay `streamToChunks` as SSE ending in exactly one `[DONE]`; otherwise aggregate
   the stream via `fromUpstream` into one `chat.completion`.

Any thrown `OwnllmError` is rendered by the app's `onError` into the OpenAI error envelope with the
request id (`translate/errors.ts`).

## Why "always stream upstream"

Codex requires `stream:true`. So ownllm always streams from the upstream and decides at the edge
whether to relay chunks to the client or buffer them into a single response. This is why the
`Translator.fromUpstream` consumes the event stream and aggregates, rather than taking a
pre-assembled body.

## Statelessness

There is no conversation store. The client resends history each turn. ownllm derives a
*deterministic* conversation id by hashing the prompt prefix (everything except the latest user
turn), so the upstream prompt cache hits across turns instead of missing on a random id. See
[translation](./translation.md#conversation-id).

## Reliability

- **Retry-once on 401:** if the upstream returns 401 before the first byte, the route refreshes the
  credential reactively (single-flight + a 10s min-interval guard) and retries exactly once. A
  second 401 surfaces as `credential_expired`. 403 and 429 are never retried.
- **Mid-stream failure:** once streaming has begun, no OpenAI error object can be sent, so the route
  emits a finish chunk and exactly one `[DONE]`, logs the failure, and does not retry.
- **Timeouts + disconnect:** each request has an `AbortController` driven by `request_timeout_ms`
  and the client connection signal, so a timeout or client disconnect aborts the upstream fetch.
- **Graceful shutdown:** SIGTERM/SIGINT stop accepting connections and drain in-flight streams, with
  a 25s grace period before a forced exit.
- **Logging:** `pino` with redaction; an access log per `/v1` request plus a request-error log via
  `onError`. Message bodies log only at `debug`.

## Security posture

- Client requests require `server.api_key` unless bound to loopback; a non-loopback bind without a
  key refuses to start (fail-closed).
- The upstream client is **host-pinned**: bearer tokens and cookies only go to allowlisted hosts,
  and redirects are never auto-followed.
- Credentials live at `~/.ownllm/auth.json` (mode `0600`) and never appear in logs; see
  [auth](./auth.md).
