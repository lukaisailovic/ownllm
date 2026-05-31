# Authentication

llmgate authenticates to providers with **subscription OAuth**, not API keys. Each provider owns its
flow behind the `AuthProvider` interface; the shared store and refresh manager treat credentials
opaquely.

## OAuth flows

- **Codex (ChatGPT)** — device-code, no browser bind ([`providers/codex/oauth.ts`](../src/providers/codex/oauth.ts)).
  Start a device authorization, print a URL + code, poll for the grant (honoring `slow_down`,
  `authorization_pending`, expiry, and Ctrl-C), then exchange the returned authorization code +
  server-issued verifier for tokens. Works headless/in Docker.
- **xAI Grok** — loopback authorization-code + PKCE ([`providers/xai/oauth.ts`](../src/providers/xai/oauth.ts)).
  Discover endpoints from `auth.x.ai/.well-known/openid-configuration`, open the browser, and catch
  the redirect on a loopback server whose preflight grants CORS + Private Network Access. The token
  exchange echoes `code_challenge` (xAI re-validates it). `state` and the id_token `nonce` are
  verified.

These are hand-rolled because both deviate from standard OAuth in ways general libraries fight
(Codex's bespoke device endpoints; xAI's challenge echo + PNA loopback).

## Credential and redaction

[`Credential`](../src/auth/credential.ts) wraps the stored token data. Its `toJSON` and
`util.inspect` representations are **redacted** (`***`), so an accidental log or `JSON.stringify`
cannot leak a token. Raw tokens are only exposed through `toStored()` for persistence. `auth status`
shows the last 4 characters and expiry only.

`expires_at` is an absolute epoch (seconds), normalized at store time: Codex uses the access
token's JWT `exp`; xAI uses `now + expires_in` (falling back to the JWT `exp`). `isExpired` is
`now + skew >= expires_at`, with a per-provider skew (Codex 300s, xAI 120s).

## Token store

[`AuthStore`](../src/auth/store.ts) keeps `~/.llmgate/auth.json` at mode `0600` inside a `0700`
directory, written atomically (`O_EXCL` temp file → `rename`). It is keyed per provider; v1 stores a
single active credential but the array shape leaves room for pooling later. An advisory
`auth.json.lock` (with stale-break by mtime) serializes read-modify-write across processes (a second
`serve`/`doctor`).

## Refresh: single-flight

[`RefreshManager`](../src/auth/refresh.ts) prevents concurrent refreshes from rotating the
refresh token in parallel and mutually invalidating it (which would force a re-login). Two layers:

- **In-process:** one in-flight `Promise` per provider; concurrent callers await it.
- **Cross-process:** `AuthStore.update` holds the file lock and re-reads under it, so a refresh that
  lost the race observes the winner's rotated token instead of clobbering it.

The reactive path (refresh after a 401) additionally honors a 10s min-interval guard, so a
stale-server 401 right after a fresh refresh can't burn a second rotation.

## Error classification

`invalid_grant` / `refresh_token_*` → the credential is dead, re-login required. An xAI 403 on a
token endpoint → tier denied (not a token error; do not retry). 429 → rate limited, token still
valid. These map to the HTTP error contract in [api.md](./api.md).

## CLI

```
llmgate auth login <openai-codex|xai>
llmgate auth status      # redacted: identity, last4, expiry, validity
llmgate auth logout <provider>
```
