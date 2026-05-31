import { createHash } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from '../types'
import { contentToText } from './request'

// Deterministic conversation id: sha256 over the instructions + every input item EXCEPT the latest
// user turn, formatted UUID-shaped (Codex's session-id may validate the form). Identical prefixes
// across turns map to the same id, so the upstream prompt cache hits instead of missing on a random
// id. Collisions are harmless (single tenant). (PLAN §10.)
export function deriveConversationId(request: ChatCompletionRequest): string {
  const instructions = request.messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => contentToText(m.content) ?? '')
    .join('\n\n')

  const conversational = request.messages.filter(
    (m) => m.role !== 'system' && m.role !== 'developer',
  )
  const prefix = dropLatestUserTurn(conversational)
  const hex = createHash('sha256')
    .update(JSON.stringify({ instructions, items: prefix }))
    .digest('hex')
  return formatUuid(hex)
}

function dropLatestUserTurn(messages: ChatMessage[]): ChatMessage[] {
  return messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages
}

function formatUuid(hex: string): string {
  const h = hex.padEnd(32, '0').slice(0, 32)
  // Stamp UUIDv4 version (4) and variant (8-b) nibbles so the value parses as a valid UUID.
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  const u = `${h.slice(0, 12)}4${h.slice(13, 16)}${variant}${h.slice(17, 32)}`
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`
}
