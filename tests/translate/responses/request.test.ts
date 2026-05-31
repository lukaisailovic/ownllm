import { describe, expect, it } from 'vitest'
import { buildResponsesRequest } from '../../../src/translate/responses/request'
import type { ChatCompletionRequest } from '../../../src/translate/types'
import { ctx } from '../../support/responses'

function build(overrides: Partial<ChatCompletionRequest>): Record<string, unknown> {
  const request = {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
  return buildResponsesRequest(request, ctx({ upstreamModel: 'gpt-5-upstream' })) as Record<
    string,
    unknown
  >
}

describe('buildResponsesRequest', () => {
  it('targets the upstream model and always streams', () => {
    const body = build({})
    expect(body.model).toBe('gpt-5-upstream')
    expect(body.stream).toBe(true)
  })

  it('concatenates system + developer messages into instructions', () => {
    const body = build({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'developer', content: 'Use JSON.' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(body.instructions).toBe('Be terse.\n\nUse JSON.')
  })

  it('maps multimodal user content to input_text and input_image', () => {
    const body = build({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'https://img/x.png' } },
          ],
        },
      ],
    })
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: 'https://img/x.png' },
        ],
      },
    ])
  })

  it('emits an assistant message then ordered function_call items, then the tool output', () => {
    const body = build({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    })
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
      { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ])
  })

  it('applies max_tokens precedence, response_format, and reasoning_effort', () => {
    const body = build({
      max_tokens: 100,
      max_completion_tokens: 200,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
    })
    expect(body.max_output_tokens).toBe(200)
    expect(body.text).toEqual({ format: { type: 'json_object' } })
    expect(body.reasoning).toEqual({ effort: 'high' })
  })

  it('falls back to the configured reasoning effort', () => {
    const request = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    } as ChatCompletionRequest
    const body = buildResponsesRequest(request, ctx({ reasoningEffort: 'medium' })) as Record<
      string,
      unknown
    >
    expect(body.reasoning).toEqual({ effort: 'medium' })
  })

  it('flattens function tools and a named tool_choice', () => {
    const body = build({
      tools: [
        {
          type: 'function',
          function: { name: 'a', description: 'd', parameters: { type: 'object' } },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'a' } },
    })
    expect(body.tools).toEqual([
      { type: 'function', name: 'a', description: 'd', parameters: { type: 'object' } },
    ])
    expect(body.tool_choice).toEqual({ type: 'function', name: 'a' })
  })
})
