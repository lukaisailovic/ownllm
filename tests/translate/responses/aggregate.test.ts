import { describe, expect, it } from 'vitest'
import { responsesTranslator } from '../../../src/translate/responses'
import { INTERLEAVED_EVENTS, ctx, eventStream } from '../../support/responses'

describe('fromUpstream (non-stream aggregate)', () => {
  it('aggregates interleaved reasoning + text + two parallel tool calls', async () => {
    const completion = await responsesTranslator.fromUpstream(
      eventStream(INTERLEAVED_EVENTS),
      ctx(),
    )
    const choice = completion.choices[0]

    expect(completion.object).toBe('chat.completion')
    expect(completion.model).toBe('gpt-5')
    expect(choice?.message.content).toBe('Let me check.')
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      },
      { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{"tz":"PT"}' } },
    ])
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
  })

  it('patches an empty completed.output from buffered output_item.done events', async () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]
    const completion = await responsesTranslator.fromUpstream(eventStream(events), ctx())
    expect(completion.choices[0]?.message.content).toBe('Hi')
    expect(completion.choices[0]?.finish_reason).toBe('stop')
  })

  it('maps incomplete max_output_tokens to finish_reason length', async () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text: 'partial' }] },
      },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        },
      },
    ]
    const completion = await responsesTranslator.fromUpstream(eventStream(events), ctx())
    expect(completion.choices[0]?.finish_reason).toBe('length')
  })

  it('returns null content when only tool calls are produced', async () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ]
    const completion = await responsesTranslator.fromUpstream(eventStream(events), ctx())
    expect(completion.choices[0]?.message.content).toBeNull()
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls')
  })
})
