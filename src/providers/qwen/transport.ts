import { classifyUpstreamStatus, createUpstreamClient } from '../../http/upstream-client'
import type { Transport } from '../types'

// Qwen portal inference (Chat Completions). Standard OpenAI-compatible body — no quirks to sanitize.
const QWEN_HOST = 'portal.qwen.ai'
const ENDPOINT = `https://${QWEN_HOST}/v1/chat/completions`

const client = createUpstreamClient([QWEN_HOST])

export const qwenTransport: Transport = {
  hosts: [QWEN_HOST],
  endpoint: () => ENDPOINT,

  headers(credential) {
    return {
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
  },

  client: () => client,

  classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'Qwen'),
}
