import { describe, expect, it } from 'vitest'
import { buildGeminiRequest } from '../../src/translate/gemini/request'
import { geminiToCompletion } from '../../src/translate/gemini/response'
import { geminiToChunks } from '../../src/translate/gemini/stream'
import type { ChatCompletionChunk, ChatCompletionRequest } from '../../src/translate/types'
import { ctx, eventStream } from '../support/responses'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'gemini',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as ChatCompletionRequest
}

// Cloud Code wraps each streamed payload in a `response` envelope.
function wrap(payload: Record<string, unknown>): Record<string, unknown> {
  return { response: payload }
}

describe('buildGeminiRequest', () => {
  it('builds the {model, user_prompt_id, request} envelope and lifts system to systemInstruction', () => {
    const body = buildGeminiRequest(
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      }),
      ctx({ upstreamModel: 'gemini-2.5-pro' }),
    )
    expect(body.model).toBe('gemini-2.5-pro')
    expect(typeof body.user_prompt_id).toBe('string')
    expect(body.project).toBeUndefined() // injected later by the transport from the credential
    const inner = body.request as Record<string, unknown>
    expect(inner.systemInstruction).toEqual({ role: 'system', parts: [{ text: 'sys' }] })
    expect(inner.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('maps assistant tool calls (with the thought-signature sentinel) and matching tool results', () => {
    const body = buildGeminiRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: '72F' },
        ],
      }),
      ctx(),
    )
    const contents = (body.request as { contents: unknown[] }).contents
    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'get_weather', args: { city: 'SF' } },
            thoughtSignature: 'skip_thought_signature_validator',
          },
        ],
      },
      // tool result resolves its function name from the call id and wraps non-JSON as {output}
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { output: '72F' } } }],
      },
    ])
  })

  it('strips disallowed JSON-schema keywords from tool parameters', () => {
    const body = buildGeminiRequest(
      request({
        tools: [
          {
            type: 'function',
            function: {
              name: 'f',
              parameters: {
                type: 'object',
                $schema: 'http://json-schema.org/draft-07/schema#',
                additionalProperties: false,
                properties: { city: { type: 'string', additionalProperties: false } },
                required: ['city'],
              },
            },
          },
        ],
      }),
      ctx(),
    )
    const decl = (body.request as { tools: { functionDeclarations: Record<string, unknown>[] }[] })
      .tools[0]?.functionDeclarations[0]
    expect(decl?.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    })
  })

  it('maps tool_choice to functionCallingConfig and carries generationConfig', () => {
    const body = buildGeminiRequest(
      request({
        temperature: 0.5,
        max_tokens: 256,
        tool_choice: { type: 'function', function: { name: 'f' } },
      }),
      ctx(),
    )
    const inner = body.request as Record<string, unknown>
    expect(inner.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] },
    })
    expect(inner.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 256 })
  })

  it('encodes a data-URL image as inlineData', () => {
    const body = buildGeminiRequest(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
          },
        ],
      }),
      ctx(),
    )
    expect((body.request as { contents: { parts: unknown[] }[] }).contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
    ])
  })
})

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('geminiToChunks', () => {
  it('streams text and maps STOP, emitting usage when requested', async () => {
    const chunks = await collect(
      geminiToChunks(
        eventStream([
          wrap({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }),
          wrap({
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
        ]),
        ctx({ includeUsage: true }),
      ),
    )
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(['Hi'])
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe('stop')
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
  })

  it('emits a whole function call as a tool_call and finishes with tool_calls', async () => {
    const chunks = await collect(
      geminiToChunks(
        eventStream([
          wrap({
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
                },
              },
            ],
          }),
          wrap({ candidates: [{ finishReason: 'STOP' }] }),
        ]),
        ctx(),
      ),
    )
    const call = chunks.find((c) => c.choices[0]?.delta.tool_calls)?.choices[0]?.delta
      .tool_calls?.[0]
    expect(call).toMatchObject({
      index: 0,
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    })
    expect(call?.id).toMatch(/^call_/)
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
      'tool_calls',
    )
  })
})

describe('geminiToCompletion', () => {
  it('aggregates text and usage', async () => {
    const response = await geminiToCompletion(
      eventStream([
        wrap({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] }),
        wrap({ candidates: [{ content: { parts: [{ text: 'world' }] } }] }),
        wrap({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
        }),
      ]),
      ctx({ requestedModel: 'gemini' }),
    )
    expect(response.choices[0]?.message.content).toBe('Hello world')
    expect(response.choices[0]?.finish_reason).toBe('stop')
    expect(response.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  })

  it('drops thought parts from the aggregated content', async () => {
    const response = await geminiToCompletion(
      eventStream([
        wrap({
          candidates: [
            { content: { parts: [{ thought: true, text: 'reasoning' }, { text: 'answer' }] } },
          ],
        }),
      ]),
      ctx(),
    )
    expect(response.choices[0]?.message.content).toBe('answer')
  })
})
