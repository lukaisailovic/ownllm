# Configuration

llmgate reads one YAML file. `llmgate config init` writes a starter copy to `~/.llmgate/config.yaml`;
edit it and restart `serve` to pick up changes (there is no hot reload). A fully commented reference
lives in [`config.example.yaml`](../config.example.yaml).

To keep config and credentials somewhere other than `~/.llmgate`, set `LLMGATE_HOME`. To load a
one-off file, pass `serve --config /path/to.yaml`.

## A minimal config

```yaml
server:
  host: 127.0.0.1
  port: 8787
providers:
  openai-codex: { enabled: true }
  xai:          { enabled: true }
models:
  gpt-5: { provider: openai-codex, upstream: gpt-5 }
  grok:  { provider: xai,          upstream: grok-build, reasoning_effort: medium }
```

## The models table

`models` is the routing table: it maps the model name a client asks for to the provider and upstream
model that should serve it. This is the part that makes llmgate worth running.

```yaml
models:
  gpt-5: { provider: openai-codex, upstream: gpt-5 }
  fast:  { provider: openai-codex, upstream: gpt-5-mini }
  grok:  { provider: xai,          upstream: grok-build, reasoning_effort: medium }
```

The left side is yours to name. A client that sends `"model": "fast"` gets routed by this table; the
name has nothing to do with any upstream id, so you can call things whatever you like.

A few rules:

- Names are matched exactly and are case-sensitive. A model that isn't listed comes back as a normal
  OpenAI `model_not_found` 404 — llmgate won't guess for you.
- Every `provider` you reference has to be enabled under `providers`, or the server won't start.
- `reasoning_effort` is optional (`minimal`, `low`, `medium`, `high`). It sets the default for that
  model when a request doesn't send one.

Run `llmgate models` to print the table, or `llmgate models --remote` to also fetch the live upstream
model ids. Grok's churn often, so it's worth checking before you pin one.

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
port. Bind anywhere else and `api_key` becomes required: llmgate refuses to start without it, so you
can't leave an unauthenticated proxy to your subscriptions sitting on the network by accident.

```yaml
server:
  host: 0.0.0.0
  api_key: ${LLMGATE_API_KEY}
```

```bash
export LLMGATE_API_KEY=$(openssl rand -hex 32)
llmgate serve
# clients then send:  Authorization: Bearer $LLMGATE_API_KEY
```

## Secrets with ${ENV}

Any string value can reference an environment variable as `${VAR}`:

```yaml
server:
  api_key: ${LLMGATE_API_KEY}
```

Substitution runs after the YAML is parsed, so a `${…}` sitting in a comment is harmless, and
referencing a variable that isn't set is a startup error that names the exact path. Use it for
secrets like `api_key`. Keep numbers like `port` as plain literals, or set them with `serve --port`.

## Environment variables

| Variable | Purpose |
|---|---|
| `LLMGATE_HOME` | Where config and credentials live (default `~/.llmgate`). |
| `LLMGATE_API_KEY` | The usual source for `server.api_key`, referenced as `${LLMGATE_API_KEY}`. |
| `LOG_LEVEL` | `trace` through `error` (default `info`). Request and response bodies log only at `debug`. |

## Files

- `~/.llmgate/config.yaml` — this file.
- `~/.llmgate/auth.json` — your OAuth credentials, managed by `auth login`. See
  [Authentication](./auth.md).
