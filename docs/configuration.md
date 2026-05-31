# Configuration

Config lives at `~/.llmgate/config.yaml`. Override the directory with `LLMGATE_HOME`, or pass a path
with `serve --config`. `llmgate config init` writes a starter file. A working example is
[`config.example.yaml`](../config.example.yaml).

## Schema

```yaml
server:
  host: 127.0.0.1            # non-loopback host requires api_key, or the server refuses to start
  port: 8787
  api_key: ${LLMGATE_API_KEY}  # client auth (timing-safe); optional only when host is loopback
  request_timeout_ms: 600000  # upstream abort deadline
  strict_params: false        # true => unsupported params return 400 instead of being ignored
providers:                    # open record keyed by provider id
  openai-codex: { enabled: true }
  xai:          { enabled: true }
models:                       # routing table: requested model -> upstream provider + model
  gpt-5:  { provider: openai-codex, upstream: gpt-5 }
  grok:   { provider: xai,          upstream: grok-build, reasoning_effort: medium }
```

- **`models`** is the routing table. The requested `model` is matched **exactly** (case-sensitive);
  an absent model returns a 404 `model_not_found`. `reasoning_effort` sets a per-model default used
  when the request omits one.
- Each model's `provider` must be declared under `providers`, or load fails.

Loading is restart-only (no hot reload), so there are no live routing-table races.

## `${ENV}` interpolation

String values support `${VAR}` interpolation, resolved against the environment **after** the YAML is
parsed (so `${...}` inside comments is ignored). An unset referenced variable is a hard startup
error printed as `path: message`. Because interpolation targets string values, use it for secrets
like `api_key`; numeric fields such as `port` should be literals (or use `serve --port`).

## Client authentication and the loopback rule

`server.api_key` is compared in constant time. If `host` is not loopback (`127.0.0.0/8`, `::1`,
`localhost`) the key is **required** — the server refuses to start without it, and `serve --host`
re-checks the effective host. This is fail-closed: exposing the port beyond localhost always
requires a key.

## Environment variables

| Variable | Purpose |
|---|---|
| `LLMGATE_HOME` | Config + auth-store directory (default `~/.llmgate`). |
| `LLMGATE_API_KEY` | Conventional source for `server.api_key` via `${LLMGATE_API_KEY}`. |
| `LOG_LEVEL` | `trace`…`error` (default `info`). Message bodies log only at `debug`. |

## Files

- `~/.llmgate/config.yaml` — this config.
- `~/.llmgate/auth.json` — OAuth credentials (`0600`); independent of config. See [auth](./auth.md).
