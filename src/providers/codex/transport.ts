import { arch } from 'node:os'
import { classifyUpstreamStatus, createCookieJarClient } from '../../http/upstream-client'
import { codexCloudflareBlocked } from '../../translate/errors'
import type { Transport } from '../types'

// Codex inference transport (PLAN §9a). The header set is what gets a valid token past Cloudflare:
// a first-party originator, a non-blank Codex User-Agent, and the account id — and NO OpenAI-Beta.
const CODEX_HOST = 'chatgpt.com'
const ENDPOINT = `https://${CODEX_HOST}/backend-api/codex/responses`
const ORIGINATOR = 'codex_cli_rs'
const CLI_VERSION = '0.20.0' // version-sensitive default
const USER_AGENT = `${ORIGINATOR}/${CLI_VERSION} (${process.platform}; ${arch()}) ownllm`

const client = createCookieJarClient([CODEX_HOST])

export const codexTransport: Transport = {
  hosts: [CODEX_HOST],
  endpoint: () => ENDPOINT,

  headers(credential, ctx) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.accessToken}`,
      originator: ORIGINATOR,
      'user-agent': USER_AGENT,
      'session-id': ctx.conversationId,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    }
    if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId
    return headers
  },

  sanitizeBody(body) {
    const { max_output_tokens: _maxOutputTokens, ...next } = body as Record<string, unknown>
    next.store = false
    if (!next.instructions) {
      next.instructions =
        'You are Codex, a chat completion assistant. Answer directly from the conversation.'
    }
    return next
  },

  client: () => client,

  classifyError(status, headers, body) {
    if (status === 403 && isCloudflareBlock(headers, body)) return codexCloudflareBlocked()
    return classifyUpstreamStatus(status, headers, 'Codex')
  },
}

// A 403 from chatgpt.com is a transport block (refresh cookies / use the escape hatch), NOT an auth
// failure, when it carries Cloudflare markers or an HTML challenge body. (PLAN risk A / §3D.)
function isCloudflareBlock(headers: Headers, body: string): boolean {
  if ((headers.get('server') ?? '').toLowerCase().includes('cloudflare')) return true
  if (headers.get('cf-ray') || headers.get('cf-mitigated')) return true
  const contentType = headers.get('content-type') ?? ''
  return (
    contentType.includes('text/html') && /cloudflare|just a moment|attention required/i.test(body)
  )
}
