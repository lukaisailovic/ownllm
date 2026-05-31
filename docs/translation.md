# Translation: Chat Completions ⇄ OpenAI Responses

Codex and xAI both speak the OpenAI Responses API, so one translator
([`src/translate/responses`](../src/translate/responses/)) serves both. It implements the
format-agnostic `Translator` interface; the pieces are independently testable.

| File | Role |
|---|---|
| `request.ts` | CC request → Responses request (`toUpstream`) |
| `assemble.ts` | Buffer the SSE stream into a final response object |
| `response.ts` | Assembled response → one `chat.completion` (`fromUpstream`) |
| `stream.ts` | SSE events → `chat.completion.chunk` stream (`streamToChunks`) |
| `conv-id.ts` | Deterministic conversation id |
| `wire.ts` | Shared helpers (event parsing, finish_reason, usage, ids) |

## CC → Responses (`request.ts`)

This layer owns all provider-agnostic mapping:

- `messages` → `input[]`. String content → `input_text`; array parts: `{type:text}` → `input_text`,
  `{type:image_url}` → `input_image` (url or data URI); unknown parts are dropped + debug-logged.
- `system`/`developer` messages → top-level `instructions`, concatenated in order with `\n\n`.
- An assistant turn with content emits a `message`/`output_text` item, then one `function_call` item
  per `tool_calls[]` **preserving order** (parallel calls). A `tool` message → `function_call_output`.
- Tools are flattened to `{type:function, name, description, parameters}`. A named `tool_choice`
  `{type:function, function:{name}}` is flattened to Responses' `{type:function, name}`.
- `max_completion_tokens ?? max_tokens` → `max_output_tokens`; `response_format` → `text.format`;
  `reasoning_effort` (or the per-model config default) → `reasoning.effort`. `temperature`/`top_p`
  pass through. `stream` is always `true` upstream.

Provider quirks (e.g. `store:false`) are added afterward by `transport.sanitizeBody`, never here.

## Responses → CC

Both directions always read the upstream **stream**.

**Non-stream** (`assemble.ts` + `response.ts`): buffer every `response.output_item.done`; on
`response.completed`, walk its `output` (or, if empty, the buffer — the "empty-output patch"). Walk
items: `output_text` → `content`, `function_call` → `tool_calls`, `reasoning` → dropped. Wrap in one
`chatcmpl-…` envelope with `model` set to the **requested** name and `usage` mapped from
`input/output_tokens`.

**Streaming** (`stream.ts`):

- Always open with a role chunk: `delta:{role:"assistant", content:""}`.
- `response.output_text.delta` → `delta:{content}`.
- **Tool index discipline:** assign each tool an index by the **order of function_call items**, not
  Responses' `output_index` (which also counts reasoning/message items). Text deltas never bump the
  tool index. The first chunk for a tool carries `{index, id:call_id, type:"function",
  function:{name, arguments:""}}`; argument deltas carry `{index, function:{arguments}}`. A tool is
  deduped across `output_item.added`/`.done` by its stable `call_id`.
- Terminal sequence: content/tool deltas → one finish chunk `{delta:{}, finish_reason}` → (only if
  `include_usage`) a `{choices:[], usage}` chunk → exactly one `[DONE]` (emitted by the route).

**finish_reason:** any function_call present → `tool_calls` (overrides); incomplete
`max_output_tokens` → `length`; refusal/content filter → `content_filter`; otherwise `stop`.

**Invariants:** every stream — success or mid-stream failure — ends with exactly one `[DONE]`. A
failure after the first byte emits a finish chunk + `[DONE]` and is logged; no error object can be
injected post-200, and there is no retry.

## Conversation id

`deriveConversationId` hashes `instructions + every input item except the latest user turn` with
SHA-256 and formats it UUID-shaped (Codex's `session-id` may validate the form). The same prefix
across turns yields the same id, so the upstream prompt cache hits. Collisions are harmless under
single-tenant use.
