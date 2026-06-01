import { randomUUID } from 'node:crypto'

// Generic wire helpers shared by every translator (Responses, Chat Completions, Anthropic, Gemini).
// Format-specific event parsing stays in each format's own wire module.

export function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

export function completionId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, '')}`
}

export function epochSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
