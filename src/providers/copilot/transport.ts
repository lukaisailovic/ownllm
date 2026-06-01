import { classifyUpstreamStatus, createUpstreamClient } from '../../http/upstream-client'
import type { Transport } from '../types'

// GitHub Copilot inference (Chat Completions). The Editor-Version + Copilot-Integration-Id headers
// gate access to the endpoint; the bearer is the short-lived Copilot API token minted at
// login/refresh. The body is standard Chat Completions, so there are no body quirks to sanitize.
const COPILOT_HOST = 'api.githubcopilot.com'
const ENDPOINT = `https://${COPILOT_HOST}/chat/completions`
const EDITOR_VERSION = 'vscode/1.104.1'

const client = createUpstreamClient([COPILOT_HOST])

export const copilotTransport: Transport = {
  hosts: [COPILOT_HOST],
  endpoint: () => ENDPOINT,

  headers(credential) {
    return {
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'editor-version': EDITOR_VERSION,
      'copilot-integration-id': 'vscode-chat',
      'openai-intent': 'conversation-edits',
      'x-initiator': 'agent',
      'user-agent': 'GitHubCopilotChat/0.26.7',
    }
  },

  client: () => client,

  classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'Copilot'),
}
