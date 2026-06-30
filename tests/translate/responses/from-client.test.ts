import { describe, expect, it } from 'vitest'
import { responsesRequestToCompletion } from '../../../src/translate/responses/from-client'
import { buildResponsesRequest } from '../../../src/translate/responses/request'
import { ctx } from '../../support/responses'

function parse(overrides: Record<string, unknown>): Record<string, unknown> {
  return responsesRequestToCompletion({
    model: 'gpt-5',
    input: 'hi',
    ...overrides,
  }) as unknown as Record<string, unknown>
}

describe('responsesRequestToCompletion', () => {
  it('turns a string input into a single user message', () => {
    const request = parse({ input: 'hello there' })
    expect(request.model).toBe('gpt-5')
    expect(request.messages).toEqual([{ role: 'user', content: 'hello there' }])
  })

  it('prepends instructions as a leading system message', () => {
    const request = parse({ instructions: 'Be terse.', input: 'hi' })
    expect(request.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('maps multimodal user content to CC text and image_url parts', () => {
    const request = parse({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this' },
            { type: 'input_image', image_url: 'https://img/x.png' },
          ],
        },
      ],
    })
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'https://img/x.png' } },
        ],
      },
    ])
  })

  it('reads input_image from a nested {url} object too', () => {
    const request = parse({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: { url: 'https://img/y.png' } }],
        },
      ],
    })
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://img/y.png' } }] },
    ])
  })

  it('groups an assistant message and its trailing function_calls into one CC message', () => {
    const request = parse({
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
        { type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' },
        { type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{"x":1}' },
      ],
    })
    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
        ],
      },
    ])
  })

  it('emits a tool message with the call id for function_call_output', () => {
    const request = parse({
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'sunny' }],
    })
    expect(request.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'sunny' }])
  })

  it('JSON-stringifies a non-string function_call_output', () => {
    const request = parse({
      input: [{ type: 'function_call_output', call_id: 'call_1', output: { temp: 20 } }],
    })
    expect(request.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
    ])
  })

  it('emits an assistant message with null content when only function_calls follow', () => {
    const request = parse({
      input: [{ type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' }],
    })
    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
    ])
  })

  it('nests a flat function tool and drops built-in tools', () => {
    const request = parse({
      tools: [
        { type: 'function', name: 'a', description: 'd', parameters: { type: 'object' } },
        { type: 'web_search' },
      ],
    })
    expect(request.tools).toEqual([
      {
        type: 'function',
        function: { name: 'a', description: 'd', parameters: { type: 'object' } },
      },
    ])
  })

  it('leaves tools undefined when no function tools remain', () => {
    const request = parse({ tools: [{ type: 'web_search' }] })
    expect(request.tools).toBeUndefined()
  })

  it('nests a flat named tool_choice', () => {
    const request = parse({ tool_choice: { type: 'function', name: 'a' } })
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'a' } })
  })

  it('passes through string tool_choice and drops hosted-tool choices', () => {
    expect(parse({ tool_choice: 'required' }).tool_choice).toBe('required')
    expect(parse({ tool_choice: { type: 'file_search' } }).tool_choice).toBeUndefined()
  })

  it('maps sampling, reasoning, and response_format fields', () => {
    const request = parse({
      max_output_tokens: 256,
      temperature: 0.5,
      top_p: 0.9,
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_object' } },
    })
    expect(request.max_tokens).toBe(256)
    expect(request.temperature).toBe(0.5)
    expect(request.top_p).toBe(0.9)
    expect(request.reasoning_effort).toBe('high')
    expect(request.response_format).toEqual({ type: 'json_object' })
  })

  it('drops an out-of-range reasoning effort', () => {
    const request = parse({ reasoning: { effort: 'extreme' } })
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('passes stream through and always forces include_usage', () => {
    expect(parse({ stream: true }).stream).toBe(true)
    expect(parse({ stream: false }).stream).toBe(false)
    expect(parse({}).stream_options).toEqual({ include_usage: true })
  })

  it('maps parallel_tool_calls and ignores store/metadata/include', () => {
    const request = parse({
      parallel_tool_calls: false,
      store: true,
      metadata: { k: 'v' },
      include: ['reasoning.encrypted_content'],
    })
    expect(request.parallel_tool_calls).toBe(false)
    expect(request.store).toBeUndefined()
    expect(request.metadata).toBeUndefined()
    expect(request.include).toBeUndefined()
  })

  it('rejects previous_response_id as unsupported', () => {
    try {
      parse({ previous_response_id: 'resp_1' })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as { status: number }).status).toBe(400)
      expect((error as { code: string }).code).toBe('unsupported_parameter')
      expect((error as { param: string }).param).toBe('previous_response_id')
    }
  })

  it('rejects background mode as unsupported', () => {
    try {
      parse({ background: true })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as { status: number }).status).toBe(400)
      expect((error as { code: string }).code).toBe('unsupported_parameter')
      expect((error as { param: string }).param).toBe('background')
    }
  })

  it('rejects a missing model', () => {
    try {
      responsesRequestToCompletion({ input: 'hi' })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as { status: number }).status).toBe(400)
      expect((error as { type: string }).type).toBe('invalid_request_error')
    }
  })

  it('rejects a missing input', () => {
    try {
      responsesRequestToCompletion({ model: 'gpt-5' })
      throw new Error('expected throw')
    } catch (error) {
      expect((error as { status: number }).status).toBe(400)
      expect((error as { type: string }).type).toBe('invalid_request_error')
    }
  })

  it('round-trips through buildResponsesRequest', () => {
    const original = {
      model: 'gpt-5',
      instructions: 'Be terse.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'weather?' },
            { type: 'input_image', image_url: 'https://img/x.png' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"SF"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'lookup',
          parameters: { type: 'object' },
        },
      ],
    }

    const cc = responsesRequestToCompletion(original)
    const rebuilt = buildResponsesRequest(cc, ctx({ upstreamModel: 'gpt-5' }))

    expect(rebuilt.instructions).toBe(original.instructions)
    expect(rebuilt.input).toEqual(original.input)
    expect(rebuilt.tools).toEqual(original.tools)
  })
})
