# llmgate

llmgate is an OpenAI-compatible API server that runs on your LLM **subscriptions** instead of API
keys. Point any OpenAI client at it, and it routes each request by the requested `model` to a
backend you've logged into over OAuth:

- **ChatGPT / Codex** (`openai-codex`)
- **xAI Grok Build / SuperGrok** (`xai`)

Both providers actually speak the OpenAI Responses API, so llmgate translates between Chat
Completions and Responses for you. Your existing tooling keeps working, streaming and tool calls
included, and token usage passes straight through.

## Why this exists

Key-based gateways like LiteLLM can't touch a ChatGPT or SuperGrok subscription, because those are
OAuth logins, not API keys. The gateways that *do* speak that OAuth (Hermes, for example) pin a
single model per server, so the request's `model` field is cosmetic.

llmgate routes per request. A YAML table maps each model name you expose to a `{provider, upstream}`
pair, and a model that isn't in the table gets a normal OpenAI `model_not_found` 404. So one server
can serve `gpt-5` and `grok` side by side.

## Requirements

- Node.js 22 or newer
- pnpm (run `corepack enable` if you don't have it)

## Install

```bash
git clone <this-repo> && cd llmgate
pnpm install
pnpm build          # builds dist/main.js, the `llmgate` CLI
```

The examples below assume an alias:

```bash
alias llmgate="node $(pwd)/dist/main.js"
```

(Or `pnpm link --global` to put `llmgate` on your PATH. While hacking on the code, `pnpm dev -- serve`
runs the CLI through `tsx` with no build step.)

## Quickstart

```bash
llmgate config init                 # writes ~/.llmgate/config.yaml
llmgate auth login openai-codex     # device code; prints a URL to open
llmgate auth login xai              # opens a browser for the loopback flow
llmgate doctor                      # checks token health + reachability before you rely on it
llmgate serve                       # binds 127.0.0.1:8787; no client key needed on loopback
```

Now call it like any OpenAI endpoint:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI

# Loopback needs no key, but the SDK insists on a non-empty string.
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
reply = client.chat.completions.create(
    model="grok",
    messages=[{"role": "user", "content": "hi"}],
)
print(reply.choices[0].message.content)
```

`gpt-5` and `grok` here are names from your routing table, not upstream model ids. Rename them,
point them wherever you want, and run `llmgate models` to see the table. Add `--remote` to fetch the
live upstream names (Grok Build's churn often, so it's worth checking).

## Configuration

The config lives at `~/.llmgate/config.yaml`. Override the directory with `LLMGATE_HOME`, or pass
`serve --config <path>`. There's a commented reference in
[`config.example.yaml`](./config.example.yaml), and more detail in
[docs/configuration.md](./docs/configuration.md).

```yaml
server:
  host: 127.0.0.1            # a non-loopback host requires api_key, or the server won't start
  port: 8787
  # api_key: ${LLMGATE_API_KEY}   # client auth (timing-safe); uncomment to require it
  request_timeout_ms: 600000
  strict_params: false        # true rejects unsupported params with 400 instead of ignoring them
providers:
  openai-codex: { enabled: true }
  xai:          { enabled: true }
models:                       # the routing table: requested model -> upstream provider + model
  gpt-5:  { provider: openai-codex, upstream: gpt-5 }
  grok:   { provider: xai,          upstream: grok-build, reasoning_effort: medium }
```

The `models` table is the whole point of llmgate. Model names are matched exactly and
case-sensitively. String values support `${ENV_VAR}` interpolation (resolved after the YAML parses,
so it's safe to use in comments), and a referenced variable that isn't set is a hard startup error.

### Going beyond localhost

On loopback the client key is optional. The moment you bind anywhere else it becomes mandatory, and
the server refuses to start without it. That's deliberate, so you can't accidentally expose an
unauthenticated proxy to your subscriptions.

```bash
export LLMGATE_API_KEY=$(openssl rand -hex 32)   # referenced as ${LLMGATE_API_KEY} in config
llmgate serve --host 0.0.0.0
# clients then send:  Authorization: Bearer $LLMGATE_API_KEY
```

## CLI

```
llmgate config init                       write a starter config
llmgate serve [--config p] [--host h] [--port n]
llmgate auth login <openai-codex|xai>     OAuth login, store the credential
llmgate auth status                       validity, identity, expiry (tokens redacted)
llmgate auth logout <provider>
llmgate auth import openai-codex          reuse the official Codex CLI login (~/.codex); see the warning it prints
llmgate models [--remote]                 print the routing table; --remote also lists upstream models
llmgate doctor                            token health + Codex Cloudflare probe + xAI tier check
```

## Docker

The container binds beyond loopback, so it needs a client key:

```bash
export LLMGATE_API_KEY=$(openssl rand -hex 32)
docker compose up --build
```

Logging in from inside a container is awkward: Codex prints a device code, but Grok wants a browser
on a loopback port. The path of least resistance is to run `llmgate auth login` on your host and
mount `~/.llmgate` into the container. See [docs/configuration.md](./docs/configuration.md).

## When something breaks

Start with `llmgate doctor`. The errors you're most likely to hit:

- **`codex_cloudflare_blocked` (502)**: `chatgpt.com` sits behind Cloudflare, and your request got
  challenged. This happens most on datacenter and Docker IPs; a residential or home-server IP
  usually sails through. It's a transport block, not a bad token.
- **`xai_tier_denied` (403)**: your xAI account isn't allowlisted for programmatic access. Logging
  in again won't change it; it's a tier gate on xAI's side.
- **`credential_expired` (401)**: run `llmgate auth login <provider>` again.
- **`model_not_found` (404)**: the model isn't in your `models` table. Check `llmgate models`.

## Documentation

The [`docs/`](./docs/) folder covers [architecture](./docs/architecture.md),
[adding a provider](./docs/providers.md), [translation](./docs/translation.md),
[authentication](./docs/auth.md), [configuration](./docs/configuration.md), and the
[HTTP API](./docs/api.md). Working on llmgate with an AI agent? Read [AGENTS.md](./AGENTS.md).

## Disclaimer

This is a personal-use tool for reaching **your own** subscriptions programmatically. It isn't
affiliated with or endorsed by OpenAI or xAI. Subscription terms aren't the same as platform or API
terms and can change without notice, and xAI gates programmatic access by tier, so it may not work
on your account at all. Complying with each provider's terms is on you. Don't run llmgate as a
multi-tenant service or resell access to it.

## License

[Apache-2.0](./LICENSE)
