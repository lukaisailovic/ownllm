import type { SSEvent, TranslateContext } from '../../src/translate/types'

export function event(payload: Record<string, unknown>): SSEvent {
  return { data: JSON.stringify(payload) }
}

export async function* eventStream(payloads: Record<string, unknown>[]): AsyncGenerator<SSEvent> {
  for (const payload of payloads) yield event(payload)
}

// Raw SSE wire text for feeding the parser / a fake upstream Response.
export function sseText(payloads: Record<string, unknown>[]): string {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')
}

export function ctx(overrides: Partial<TranslateContext> = {}): TranslateContext {
  return {
    requestedModel: 'gpt-5',
    upstreamModel: 'gpt-5',
    conversationId: 'conv-test',
    includeUsage: false,
    ...overrides,
  }
}

// The hard case (PLAN §15): interleaved reasoning + text + two parallel tool calls. Reasoning is
// dropped; tool indices follow function_call order (0,1), not Responses output_index (2,3).
export const INTERLEAVED_EVENTS: Record<string, unknown>[] = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Let me ' },
  { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'check.' },
  {
    type: 'response.output_item.added',
    output_index: 2,
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' },
  },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' },
  {
    type: 'response.output_item.added',
    output_index: 3,
    item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_time' },
  },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"SF"}' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"tz":"PT"}' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } },
  {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      id: 'msg_1',
      content: [{ type: 'output_text', text: 'Let me check.' }],
    },
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
    },
  },
  {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"tz":"PT"}' },
  },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"SF"}',
        },
        { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"tz":"PT"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  },
]
