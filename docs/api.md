# HTTP API

ownllm speaks the OpenAI API. Point any OpenAI-compatible client at `http://<host>:<port>/v1` and
use your `server.api_key` as the API key. On loopback no key is required, but most SDKs insist on a
non-empty string anyway, so pass any placeholder.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OWNLLM_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"grok","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(
    client.chat.completions.create(
        model="gpt-5",
        messages=[{"role": "user", "content": "hi"}],
    ).choices[0].message.content
)
```

`model` is a name from your [models table](./configuration.md#the-models-table), not an upstream id.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat Completions, streaming or not. |
| `GET` | `/v1/models` | Lists the model names you've configured. |
| `GET` | `/health` | Liveness: `200 {"status":"ok"}` while the server is up. |
| `GET` | `/ready` | `200` once config is valid and at least one provider has a credential, else `503`. |

Everything under `/v1` needs the API key unless you're bound to loopback; `/health` and `/ready`
never do. Every response carries an `x-request-id` header — quote it if you report a problem.

## Chat completions

A standard OpenAI request. Set `stream: true` for a `text/event-stream` of `chat.completion.chunk`
events that ends in a single `data: [DONE]`; add `stream_options: {include_usage: true}` and a final
usage chunk arrives just before `[DONE]`. Token counts pass straight through from the provider.

### Which parameters are honored

By default, ownllm forwards what the upstreams understand and quietly drops the rest:

- Honored: `temperature`, `top_p`, `max_tokens` / `max_completion_tokens`, `response_format`,
  `reasoning_effort`, `tools`, `tool_choice`, `stream`, `stream_options.include_usage`.
- Dropped: `presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `stop`, `logprobs`,
  `top_logprobs`, `user`. They're logged at `debug` so you can see what got dropped.
- `n > 1` is rejected with a 400.

Set `server.strict_params: true` to turn that dropped list into 400s instead. Reach for it when you'd
rather hear that a parameter isn't taking effect than have it silently ignored.

### GET /v1/models

```json
{ "object": "list", "data": [
  { "id": "gpt-5", "object": "model", "created": 1700000000, "owned_by": "openai-codex" }
] }
```

`id` is your configured name; `owned_by` is the provider behind it.

## Errors

Errors use the OpenAI envelope, `{"error": {"message", "type", "param"?, "code"?}}`, with the
`x-request-id` header set.

| Situation | HTTP | code |
|---|---|---|
| Model isn't in your config | 404 | `model_not_found` |
| Malformed request body | 400 | (none) |
| Missing or wrong API key | 401 | `invalid_api_key` |
| `n > 1`, or a dropped param under `strict_params` | 400 | `unsupported_parameter` |
| Credential expired and couldn't refresh | 401 | `credential_expired` |
| xAI account not entitled | 403 | `xai_tier_denied` |
| Codex blocked by Cloudflare | 502 | `codex_cloudflare_blocked` |
| Upstream rate limit | 429 | `rate_limit_exceeded` |
| Upstream 5xx, or a translation fault | 502 | (none) |

A `model_not_found` reply mirrors OpenAI's wording and doesn't list your models — run `ownllm
models` for that. On a 429, ownllm passes the upstream's `Retry-After` straight through and never
retries for you. For what these mean when you're logging in, see
[Authentication](./auth.md#troubleshooting).
