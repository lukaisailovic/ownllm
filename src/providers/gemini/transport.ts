import { randomUUID } from 'node:crypto'
import { classifyUpstreamStatus, createUpstreamClient } from '../../http/upstream-client'
import type { Transport } from '../types'
import {
  GEMINI_CLI_USER_AGENT,
  GEMINI_CODE_ASSIST_HOST,
  GEMINI_GOOG_API_CLIENT,
} from './fingerprint'

// Gemini inference via Cloud Code Assist. We always stream, so we hit :streamGenerateContent, and
// present the gemini-cli Node-client fingerprint the backend expects.
const ENDPOINT = `https://${GEMINI_CODE_ASSIST_HOST}/v1internal:streamGenerateContent?alt=sse`

const client = createUpstreamClient([GEMINI_CODE_ASSIST_HOST])

export const geminiTransport: Transport = {
  hosts: [GEMINI_CODE_ASSIST_HOST],
  endpoint: () => ENDPOINT,

  headers(credential) {
    return {
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': GEMINI_CLI_USER_AGENT,
      'x-goog-api-client': GEMINI_GOOG_API_CLIENT,
      'x-activity-request-id': randomUUID(),
    }
  },

  // The translator emits {model, user_prompt_id, request}; the per-account project lives on the
  // credential, so this is the one place that can fold it into the top-level envelope.
  sanitizeBody(body, _ctx, credential) {
    return { ...(body as Record<string, unknown>), project: credential.projectId }
  },

  client: () => client,

  classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'Gemini'),
}
