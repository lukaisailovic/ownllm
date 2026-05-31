import { Credential } from '../../src/auth/credential'
import { type UpstreamClient, classifyUpstreamStatus } from '../../src/http/upstream-client'
import type { AuthProvider, ProviderModule } from '../../src/providers/types'
import { responsesTranslator } from '../../src/translate/responses'

export const testCredential = new Credential({
  type: 'oauth',
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: 9_999_999_999,
})

const stubAuth: AuthProvider = {
  id: 'openai-codex',
  login: async () => {
    throw new Error('unused')
  },
  refresh: async () => {
    throw new Error('unused')
  },
  isExpired: () => false,
}

export function sseResponse(sse: string, status = 200): Response {
  return new Response(sse, { status, headers: { 'content-type': 'text/event-stream' } })
}

// A provider module with the REAL Responses translator + shared error classifier, but a fake
// upstream client so a test fully controls the upstream's responses.
export function fakeModule(fetch: UpstreamClient['fetch']): ProviderModule {
  return {
    id: 'openai-codex',
    auth: stubAuth,
    translator: responsesTranslator,
    transport: {
      hosts: ['test.local'],
      endpoint: () => 'https://test.local/responses',
      headers: () => ({}),
      client: () => ({ fetch }),
      classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'test'),
    },
    capabilities: { stream: true, tools: true, vision: true, reasoning: true },
    listModels: async () => [],
  }
}
