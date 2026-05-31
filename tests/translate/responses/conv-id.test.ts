import { describe, expect, it } from 'vitest'
import { deriveConversationId } from '../../../src/translate/responses'
import type { ChatCompletionRequest } from '../../../src/translate/types'

function request(messages: ChatCompletionRequest['messages']): ChatCompletionRequest {
  return { model: 'gpt-5', messages }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('deriveConversationId', () => {
  it('produces a UUID-shaped, deterministic id', () => {
    const messages = request([{ role: 'user', content: 'hello' }]).messages
    const a = deriveConversationId(request(messages))
    const b = deriveConversationId(request(messages))
    expect(a).toMatch(UUID)
    expect(a).toBe(b)
  })

  it('is stable across turns: same prefix, different latest user turn -> same id', () => {
    const prefix: ChatCompletionRequest['messages'] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
    ]
    const first = deriveConversationId(request([...prefix, { role: 'user', content: 'turn 2' }]))
    const second = deriveConversationId(
      request([...prefix, { role: 'user', content: 'DIFFERENT' }]),
    )
    expect(first).toBe(second)
  })

  it('changes when the conversation prefix changes', () => {
    const a = deriveConversationId(
      request([
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'reply A' },
        { role: 'user', content: 'turn 2' },
      ]),
    )
    const b = deriveConversationId(
      request([
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'reply B' },
        { role: 'user', content: 'turn 2' },
      ]),
    )
    expect(a).not.toBe(b)
  })
})
