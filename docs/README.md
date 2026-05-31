# ownllm documentation

ownllm is an OpenAI-compatible API server that runs on your LLM subscriptions (ChatGPT/Codex, xAI
Grok) over OAuth instead of API keys, routing each request to a backend by the model name you ask
for.

New here? Start with the [Quickstart](../README.md#quickstart), then read the guides.

## Guides

- [Authentication](./auth.md) — log in to each provider, including headless servers and Docker.
- [Configuration](./configuration.md) — the config file, the model routing table, and locking down
  the port.
- [HTTP API](./api.md) — the endpoints, calling them from any OpenAI client, and the errors you may
  hit.

## Internals and contributing

- [Architecture](./architecture.md) — layers, request flow, reliability, and security posture.
- [Adding a provider](./providers.md) — the provider extension contract.
- [Translation](./translation.md) — how Chat Completions maps onto the OpenAI Responses API.

Working on the code? [AGENTS.md](../AGENTS.md) is the contributor guide.
