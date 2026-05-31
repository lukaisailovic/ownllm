import { classifyUpstreamStatus, createUpstreamClient } from '../../http/upstream-client'
import { xaiTierDenied } from '../../translate/errors'
import type { Transport } from '../types'
import { sanitizeXaiResponsesBody } from './sanitize'

const XAI_HOST = 'api.x.ai'
const ENDPOINT = `https://${XAI_HOST}/v1/responses`

const client = createUpstreamClient([XAI_HOST])

export const xaiTransport: Transport = {
  hosts: [XAI_HOST],
  endpoint: () => ENDPOINT,

  headers(credential, ctx) {
    return {
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-grok-conv-id': ctx.conversationId,
    }
  },

  sanitizeBody: sanitizeXaiResponsesBody,

  client: () => client,

  // A 403 here means the account is not entitled to programmatic access — surface it, do not retry
  // or refresh-loop. (PLAN risk B / §3D.)
  classifyError(status, headers) {
    if (status === 403) return xaiTierDenied()
    return classifyUpstreamStatus(status, headers, 'xAI')
  },
}
