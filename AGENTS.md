# AGENTS.md

Agent-facing guide for working in **ownllm** — a subscription-OAuth, OpenAI-compatible API gateway
with real per-request model routing. For the human-facing intro see [README.md](./README.md); for
design depth see [`docs/`](./docs/) (start with [architecture](./docs/architecture.md)).

## Commands

```bash
pnpm install
pnpm dev -- <args>     # run the CLI under tsx (no build); e.g. pnpm dev -- serve
pnpm build             # tsup -> dist/main.js (the bundled CLI)
pnpm typecheck         # tsc --noEmit
pnpm lint              # biome check .   (fails on unformatted code)
pnpm format            # biome check --write .  (run this BEFORE lint)
pnpm test              # vitest run
```

**The verify loop before declaring anything done:** `pnpm format && pnpm lint && pnpm typecheck &&
pnpm test` (and `pnpm build` if you touched build/runtime wiring). Match what CI runs.

## Layout

```
src/cli/         citty commands (serve, auth, config, models, doctor)
src/config/      zod schema, ${ENV} loader, paths, loopback check
src/server/      Hono app, middleware, readiness; routes/ (chat-completions, responses) over a shared serve-upstream engine
src/router/      resolveModel/resolveChain(name) -> ordered route candidates; fallback breaker
src/providers/   types (extension contract), registry, codex/, xai/, copilot/, qwen/, minimax/, gemini/
src/translate/   CC types + error factory + param policy; shared wire.ts; responses/ (+ inbound from-client/to-client) chat/ anthropic/ gemini/ translators
src/auth/        Credential, AuthStore (0600+lock), single-flight RefreshManager, OAuth primitives
src/http/        host-pinned UpstreamClient, Codex cookie jar, SSE parser
tests/support/   shared test helpers (createTestApp, fakeModule, sseResponse, responses fixtures)
```

## Conventions

- **TypeScript ESM, strict.** `noUncheckedIndexedAccess` is on — `arr[0]` is `T | undefined`, handle
  it. `verbatimModuleSyntax` is on — use `import type` for types. `exactOptionalPropertyTypes` is
  off (assigning `undefined` to an optional field is fine).
- **Biome** is the formatter+linter: single quotes, no semicolons, 2-space indent, width 100,
  trailing commas. It also organizes imports. Style is not negotiable — run `pnpm format`.
- **Code style** (from the maintainer's guidelines): no obvious comments — comment only what the
  code can't say; prefer early returns over `if/else`; prefer offensive programming for invariants;
  keep changes surgical (clean up only orphans your change created).
- **Parsing unknown JSON** (upstream bodies, token responses): use `asRecord` / `getString` /
  `getNumber` / `omit` from `src/util/json.ts` rather than casts.
- **Tests** run with `LOG_LEVEL=silent`. Reuse `tests/support/*` (real translator + fake transport
  via `fakeModule`, `createTestApp`, `eventStream`/`sseText`, `INTERLEAVED_EVENTS`). Provider OAuth
  network flows are not unit-tested (manual e2e); test the pure pieces + the route orchestration.

## Footguns this codebase has already hit

- **`pnpm format` before `pnpm lint`.** `biome check` fails on unformatted code, and several Biome
  fixes are "unsafe" (not auto-applied): `useOptionalChain`, `useTemplate`, `noDelete`. For removing
  object keys, use the `omit()` helper or `x = undefined` (it's dropped on JSON serialization) —
  **not** `delete`.
- **`instanceof` needs a value import.** A type-only import (e.g. `import type { OwnllmError }`)
  makes `error instanceof OwnllmError` throw at runtime (the symbol is `undefined`), which surfaces
  as a 500. Import such classes as values.
- **Editing churns files.** Format/organize-imports rewrites files after a Write/Edit; re-read
  before the next edit if the harness flags the file as modified.

## Invariants — do not break these

- **Subscription-only.** No API-key provider or fallback (incl. no `XAI_API_KEY`). That's the whole
  thesis.
- **Single-flight refresh** (`auth/refresh.ts`). Concurrent refreshes rotate the refresh token in
  parallel and mutually invalidate it → forced re-login. The in-process promise + cross-process file
  lock + reactive 10s min-interval guard exist for this. Don't add a code path that refreshes
  outside `RefreshManager`.
- **Translator ownership rule.** The base `ResponsesTranslator` owns all provider-agnostic
  CC→Responses semantics (multimodal, `response_format`, `reasoning_effort`, tool flattening,
  `max_tokens` precedence). A provider's `transport.sanitizeBody` owns **only** that provider's
  quirks. Never do the same thing in both (drift).
- **Always stream upstream**; relay to the client or aggregate at the edge. `fromUpstream` consumes
  the event stream.
- **Fallback is pre-first-byte only.** The route tries candidates (requested model + its direct
  `fallbacks`, not transitive) until one yields a streamable upstream; once relay starts we're
  committed. Never fall back on a client disconnect/timeout, and don't penalize a model's breaker
  health for those. `resolveChain` (`router/resolve.ts`) dedupes so a cycle can't loop; the circuit
  breaker (`router/breaker.ts`) is in-process and keyed by model name.
- **Host-pinned egress.** Bearer tokens/cookies go only to allowlisted hosts; `redirect:'manual'`.
  Don't bypass `UpstreamClient`.
- **Redaction.** Never log tokens. `Credential` redacts in `toJSON`/`inspect`; raw tokens come out
  only via `toStored()` (persistence). Logger redacts `authorization`/`cookie`/`*_token`/`cf_clearance`.
- **Error contract.** Throw a `OwnllmError` from `translate/errors.ts` (the §11 factory); the app's
  `onError` renders the OpenAI envelope + `x-request-id`. Don't hand-roll error responses.
- **403 ≠ 401.** Branch by provider in `transport.classifyError`: Codex Cloudflare 403 → transport
  block (`codex_cloudflare_blocked`), xAI 403 → `xai_tier_denied`. Never refresh-loop on 403/429.
- **Stateless.** No conversation store; the deterministic conv-id (`translate/responses/conv-id.ts`)
  pins the upstream prompt cache. Keep it deterministic over the prompt prefix.

## Adding a provider

Implement `ProviderModule` (`src/providers/types.ts`), register it in `src/providers/registry.ts`,
and enable it in config. Zero core edits — the router/server only call the registry + interfaces.
Reuse `responsesTranslator` if the provider speaks the OpenAI Responses API; otherwise add a new
`translate/<format>/`. Worked examples: `src/providers/codex` and `src/providers/xai`. Full guide:
[docs/providers.md](./docs/providers.md).

## Deliberate deviations (don't "fix" these)

- **`${ENV}` interpolation runs post-parse on string values**, not on raw text — avoids `${...}` in
  comments breaking the load and yields config-path errors.
- **OAuth is hand-rolled** (not `openid-client`/`oauth4webapi`): Codex uses bespoke device endpoints
  (server-issued PKCE verifier), and xAI requires a non-standard `code_challenge` echo + a
  CORS/Private-Network loopback. Libraries fight these.

## Status / planning

`PLAN.md` is the design doc (gitignored — local only). Its **§0 Status** tracks what's done vs.
deferred-optional vs. needs-real-subscription e2e. The maintainer runs `/simplify` after each
substantial change to keep the code lean.
