import { classifyUpstreamStatus, createUpstreamClient } from '../../http/upstream-client'
import type { Transport } from '../types'

// MiniMax inference via its Anthropic Messages-compatible endpoint. The bearer overrides the usual
// x-api-key; anthropic-version is required by the wire format. The Anthropic translator owns the body.
const MINIMAX_HOST = 'api.minimax.io'
const ENDPOINT = `https://${MINIMAX_HOST}/anthropic/v1/messages`

const client = createUpstreamClient([MINIMAX_HOST])

export const minimaxTransport: Transport = {
  hosts: [MINIMAX_HOST],
  endpoint: () => ENDPOINT,

  headers(credential) {
    return {
      authorization: `Bearer ${credential.accessToken}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
  },

  client: () => client,

  classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'MiniMax'),
}
