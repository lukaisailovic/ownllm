# HTTP API

llmgate exposes an OpenAI-compatible surface. Point any OpenAI client at `http://<host>:<port>/v1`
with `server.api_key` as the API key.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness; `200 {"status":"ok"}` while serving. |
| `GET` | `/ready` | `200` if config is valid and ≥1 enabled provider has a credential, else `503`. |
| `GET` | `/v1/models` | Lists configured model keys (OpenAI list shape). |
| `POST` | `/v1/chat/completions` | Chat Completions; streaming and non-streaming. |

`/v1/*` requires the client api key (unless loopback-only); `/health` and `/ready` do not. Every
response carries an `x-request-id` header (minted, or echoed from the request).

### `GET /v1/models`

```json
{ "object": "list", "data": [
  { "id": "gpt-5", "object": "model", "created": 1700000000, "owned_by": "openai-codex" }
] }
```

`id` is the config model key; `owned_by` is the provider id; `created` is the server start time.

### `POST /v1/chat/completions`

Standard request. Streaming (`stream:true`) returns `text/event-stream` of
`chat.completion.chunk` objects terminated by exactly one `data: [DONE]`. With
`stream_options.include_usage`, a final `{choices:[], usage}` chunk precedes `[DONE]`.

## Parameter policy

Default (`strict_params:false`):

- **Mapped/forwarded:** `temperature`, `top_p`, `max_tokens`|`max_completion_tokens`,
  `response_format`, `reasoning_effort`, `tools`, `tool_choice`, `stream`,
  `stream_options.include_usage`.
- **Ignored + debug-logged:** `presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `stop`,
  `logprobs`, `top_logprobs`, `user`.
- **`n>1`** → 400.

`strict_params:true` turns the ignored set into 400s.

## Error contract

All non-2xx responses are `{"error":{"message","type","param"?,"code"?}}` with an `x-request-id`
header.

| Condition | HTTP | type | code |
|---|---|---|---|
| model not in config | 404 | invalid_request_error | model_not_found |
| body / zod invalid | 400 | invalid_request_error | — |
| client auth missing/bad | 401 | invalid_request_error | invalid_api_key |
| `n>1` / ignored param under strict | 400 | invalid_request_error | unsupported_parameter |
| credential dead / 401 after refresh | 401 | invalid_request_error | credential_expired |
| xAI tier denied (403) | 403 | permission_error | xai_tier_denied |
| Codex Cloudflare block (403 HTML) | 502 | api_error | codex_cloudflare_blocked |
| upstream 429 | 429 | rate_limit_error | rate_limit_exceeded |
| upstream 5xx / translate fault | 502 | api_error | — |

The model-not-found message mirrors OpenAI (`The model 'X' does not exist or you do not have access
to it.`) and does not enumerate models — use `llmgate models`. A 429 passes through `Retry-After`
and rate-limit headers; llmgate never refreshes or retries on a 429.

The factory for these lives in [`src/translate/errors.ts`](../src/translate/errors.ts).
