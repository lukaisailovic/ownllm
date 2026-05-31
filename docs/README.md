# llmgate documentation

llmgate is an OpenAI-compatible API server that runs on LLM **subscriptions** (ChatGPT/Codex,
xAI Grok) over OAuth instead of API keys, and does real per-request routing by the requested
`model`.

- [Architecture](./architecture.md) — layers, request flow, and the module map.
- [Adding a provider](./providers.md) — the extension contract (`ProviderModule`).
- [Translation](./translation.md) — Chat Completions ⇄ OpenAI Responses.
- [Authentication](./auth.md) — OAuth flows, the token store, and refresh lifecycle.
- [Configuration](./configuration.md) — the YAML config and environment variables.
- [HTTP API](./api.md) — endpoints and the error contract.

These docs track the implemented code. Milestones are in [`../PLAN.md`](../PLAN.md); the build
order is P0 scaffold → P1 auth → P2 server contract → P3 provider framework + Codex → P4 Grok →
P5 reliability → P6 tooling.
