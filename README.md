# llmgate

A self-hostable, OpenAI-compatible API server that runs on your **LLM subscriptions**
instead of API keys.

Point any OpenAI-compatible client at llmgate, and it routes each request — by the
requested `model` — to a backend driven by **subscription OAuth**:

- **ChatGPT / Codex** (`openai-codex`)
- **xAI Grok Build / SuperGrok** (`xai`)

Both backends speak the OpenAI Responses API under the hood; llmgate translates
Chat Completions ⇄ Responses so your existing tooling works unchanged.

## Why

Key-based gateways (LiteLLM and friends) can't use a ChatGPT or SuperGrok
*subscription* — those are OAuth, not API keys. Per-model gateways that do speak
OAuth (e.g. Hermes) pin a single model per server; the request's `model` field is
cosmetic. llmgate does **real per-request routing**: a YAML table maps each
requested model to `{provider, upstreamModel}`, and unknown models return a proper
OpenAI `model_not_found` 404.

## Status

Early. See `PLAN.md` for the milestone roadmap. P0 (scaffold) is in place: the CLI,
config loading, and a health endpoint work; provider auth and inference land in
later milestones.

## Requirements

- Node.js >= 22
- pnpm (via corepack)

## Quickstart

```bash
pnpm install
pnpm build

# create ~/.llmgate/config.yaml
node dist/main.js config init

# start the server (loopback by default — no api_key needed)
node dist/main.js serve
curl http://127.0.0.1:8787/health
```

During development, `pnpm dev` runs the CLI under `tsx` with watch mode.

## Configuration

Config lives at `~/.llmgate/config.yaml` (override the directory with
`LLMGATE_HOME`). See [`config.example.yaml`](./config.example.yaml). Values support
`${ENV_VAR}` interpolation; an unset referenced variable is a hard startup error.

The routing table is the core of llmgate:

```yaml
models:
  gpt-5:  { provider: openai-codex, upstream: gpt-5 }
  grok:   { provider: xai,          upstream: grok-build, reasoning_effort: medium }
```

### Client authentication

Requests are authenticated with `server.api_key`, compared in constant time. If
`server.host` is **not** loopback, an `api_key` is **required** — the server refuses
to start without one. This is fail-closed by design.

## CLI

```
llmgate config init                  # write a starter config
llmgate serve [--config] [--host] [--port]
llmgate auth login <openai-codex|xai>
llmgate auth status
llmgate auth logout <provider>
llmgate auth import openai-codex
llmgate models [--remote]
llmgate doctor
```

## Docker

The container binds beyond loopback, so it requires a client key:

```bash
export LLMGATE_API_KEY=$(openssl rand -hex 32)
docker compose up --build
```

OAuth login inside a container has caveats (Codex uses a device code; Grok needs a
browser loopback). The simplest path is to run `llmgate auth login` on your host and
mount `~/.llmgate` into the container. See `PLAN.md` §13.

## Disclaimer

This is a personal-use tool for accessing **your own** subscriptions
programmatically. It is not affiliated with, endorsed by, or supported by OpenAI or
xAI. Subscription terms differ from platform/API terms and can change without notice;
xAI's programmatic access is tier-gated and may not be available on your account.
**You are responsible for ensuring your use complies with each provider's terms.**
Do not use llmgate for multi-tenant or resale scenarios.

## License

[Apache-2.0](./LICENSE)
