# Configuration

ownllm reads one YAML file. `ownllm config init` writes a starter copy to `~/.ownllm/config.yaml`;
edit it and restart `serve` to pick up changes (there is no hot reload). A fully commented reference
lives in [`config.example.yaml`](../config.example.yaml).

To keep config and credentials somewhere other than `~/.ownllm`, set `OWNLLM_HOME`. To load a
one-off file, pass `serve --config /path/to.yaml`.

## A minimal config

```yaml
server:
  host: 127.0.0.1
  port: 8787
providers:
  openai-codex:
    enabled: true
  xai:
    enabled: true
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
  grok:
    provider: xai
    upstream: grok-build
    reasoning_effort: medium
```

The provider ids you can enable are `openai-codex`, `xai`, `copilot`, `qwen`, `minimax`, `gemini`,
and `claude` — each a subscription OAuth or local CLI login (see [auth](./auth.md)).
`config.example.yaml` shows a route for every one.

## The models table

`models` is the routing table: it maps the model name a client asks for to the provider and upstream
model that should serve it. This is the part that makes ownllm worth running.

```yaml
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
  fast:
    provider: openai-codex
    upstream: gpt-5-mini
  grok:
    provider: xai
    upstream: grok-build
    reasoning_effort: medium
```

The left side is yours to name. A client that sends `"model": "fast"` gets routed by this table; the
name has nothing to do with any upstream id, so you can call things whatever you like.

A few rules:

- Names are matched exactly and are case-sensitive. A model that isn't listed comes back as a normal
  OpenAI `model_not_found` 404 — ownllm won't guess for you.
- Every `provider` you reference has to be enabled under `providers`, or the server won't start.
- `reasoning_effort` is optional (`minimal`, `low`, `medium`, `high`). It sets the default for that
  model when a request doesn't send one.
- `fallbacks` is optional — an ordered list of other model names to retry on failure. See
  [Fallbacks](#fallbacks).

`ownllm models` shows two different things, and it's worth keeping them straight:

- **The routing table** (always) — the aliases above: the names a client is allowed to send.
- **The upstream catalog** (`--remote`) — what each provider actually offers, so you know what to put
  on the right-hand `upstream` side. For xAI this is a *live* call against your own subscription, so
  it mirrors your tier; for Codex it's the known-good set (`gpt-5`, `gpt-5-codex`).

The catalog is the one to trust when you pin an `upstream`. A model missing from it may still answer
— xAI tolerates some legacy slugs (`grok-3-mini`, say) — but it isn't supported on your tier and is
often the slow path. Grok's names churn week to week, so re-check `--remote` whenever one misbehaves.

## Fallbacks

Any model can name other models to fall back to when its request fails. `fallbacks` is an ordered
list of model names from the same table:

```yaml
models:
  gpt-5:
    provider: openai-codex
    upstream: gpt-5
    fallbacks: [grok, grok-4]   # try gpt-5, then grok, then grok-4
  grok:
    provider: xai
    upstream: grok-build
  grok-4:
    provider: xai
    upstream: grok-4.3
```

A request for `gpt-5` is attempted on `gpt-5` first; if that fails it retries on `grok`, then
`grok-4`, in order. Because the chain crosses providers, this is also how you ride out one
subscription being rate-limited or blocked by failing over to the other.

A few details:

- **One level deep, not transitive.** Only the requested model's own `fallbacks` are tried. A
  fallback's *own* `fallbacks` are never followed — `gpt-5 → grok` will not then chase `grok`'s
  fallbacks. If you want a longer chain, list every model explicitly on the one you request.
- **Cycles are fine.** `a` may list `b` while `b` lists `a`. Because resolution never expands a
  fallback's own list, requesting `a` just tries `a` then `b` and stops (never `a → b → a`).
  Referencing a model that isn't in the table is a startup error.
- **Pre-first-byte only.** Fallback happens before any response bytes reach the client — on a
  connection error, a non-2xx upstream status (429 / 403 / 5xx), or a dead credential. Once the
  reply has started streaming, ownllm is committed and a mid-stream failure just ends the stream.
  A client disconnect or the request timeout stops the chain without trying further models.
- **Served-by header.** Every response carries `x-ownllm-served-by`, the model that actually
  answered — handy for spotting when a fallback kicked in.

### The circuit breaker

Retrying a model that is reliably down wastes a round-trip on every request. The optional `fallback`
block adds a per-model circuit breaker: after `failure_threshold` consecutive failures a model is
taken out of rotation for `cooldown_ms`, so requests skip straight to a healthy fallback. When the
window passes, the next request is a trial — success puts the model back, another failure re-arms
the cooldown. If every model in a chain is in cooldown, the request still makes one real attempt
rather than failing outright.

```yaml
fallback:
  failure_threshold: 3   # consecutive failures before a model is skipped
  cooldown_ms: 30000     # how long to skip it before the next trial (0 disables skipping)
```

The breaker is in-memory and per server process; it resets on restart.

## Server options

| Key | Default | What it does |
|---|---|---|
| `server.host` | `127.0.0.1` | Address to bind. Anything but loopback requires `api_key`. |
| `server.port` | `8787` | Port to bind. |
| `server.api_key` | (unset) | Key clients send as `Authorization: Bearer …`. |
| `server.request_timeout_ms` | `600000` | How long to wait on an upstream before giving up. |
| `server.strict_params` | `false` | `true` rejects unsupported parameters with a 400 instead of ignoring them. |

## Securing the port

On loopback (`127.0.0.1`, `::1`, `localhost`) the API key is optional, since only you can reach the
port. Bind anywhere else and `api_key` becomes required: ownllm refuses to start without it, so you
can't leave an unauthenticated proxy to your subscriptions sitting on the network by accident.

```yaml
server:
  host: 0.0.0.0
  api_key: ${OWNLLM_API_KEY}
```

```bash
export OWNLLM_API_KEY=$(openssl rand -hex 32)
ownllm serve
# clients then send:  Authorization: Bearer $OWNLLM_API_KEY
```

## Secrets with ${ENV}

Any string value can reference an environment variable as `${VAR}`:

```yaml
server:
  api_key: ${OWNLLM_API_KEY}
```

Substitution runs after the YAML is parsed, so a `${…}` sitting in a comment is harmless, and
referencing a variable that isn't set is a startup error that names the exact path. Use it for
secrets like `api_key`. Keep numbers like `port` as plain literals, or set them with `serve --port`.

## Environment variables

| Variable | Purpose |
|---|---|
| `OWNLLM_HOME` | Where config and credentials live (default `~/.ownllm`). |
| `OWNLLM_API_KEY` | The usual source for `server.api_key`, referenced as `${OWNLLM_API_KEY}`. |
| `LOG_LEVEL` | `trace` through `error` (default `info`). Request and response bodies log only at `debug`. |

## Files

- `~/.ownllm/config.yaml` — this file.
- `~/.ownllm/auth.json` — your OAuth credentials, managed by `auth login`. See
  [Authentication](./auth.md).
