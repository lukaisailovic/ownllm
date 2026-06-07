import {
  type UpstreamClient,
  type UpstreamRequestInit,
  classifyUpstreamStatus,
} from '../../http/upstream-client'
import { upstreamError } from '../../translate/errors'
import { asRecord, getString } from '../../util/json'
import type { Transport } from '../types'
import { type CommandRunner, runCommand } from './auth'

const CLAUDE_HOST = 'claude.local'
const ENDPOINT = `https://${CLAUDE_HOST}/v1/messages`

export class ClaudeCliClient implements UpstreamClient {
  constructor(private readonly runner: CommandRunner = runCommand) {}

  async fetch(url: string, init: UpstreamRequestInit): Promise<Response> {
    if (new URL(url).hostname !== CLAUDE_HOST) {
      throw upstreamError(`refusing request to non-allowlisted host: ${new URL(url).hostname}`)
    }
    const body = asRecord(parseJson(init.body ?? '{}'))
    const prompt = getString(body, 'prompt')
    const model = getString(body, 'model')
    if (!prompt || !model) throw upstreamError('Claude provider received an invalid request body')

    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--model', model]
    const result = await this.runner('claude', args, init.signal, prompt).catch((error) => {
      throw upstreamError(`Claude Code CLI request failed: ${errorMessage(error)}`)
    })
    if (result.exitCode !== 0) {
      throw upstreamError(`Claude Code CLI exited with status ${result.exitCode ?? 'unknown'}`)
    }

    return new Response(sseText(claudeOutputText(result.stdout)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

const client = new ClaudeCliClient()

export const claudeTransport: Transport = {
  hosts: [CLAUDE_HOST],
  endpoint: () => ENDPOINT,
  headers: () => ({
    'content-type': 'application/json',
    accept: 'text/event-stream',
  }),
  client: () => client,
  classifyError: (status, headers) => classifyUpstreamStatus(status, headers, 'Claude'),
}

export function claudeOutputText(stdout: string): string {
  const trimmed = stdout.trim()
  const body = asRecord(parseJson(trimmed))
  if (!body) return trimmed

  const direct = getString(body, 'result') ?? getString(body, 'response') ?? getString(body, 'text')
  if (direct !== undefined) return direct

  const content = body.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part)
        return getString(record, 'text') ?? ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return trimmed
}

function sseText(text: string): string {
  const id = `chatcmpl-claude-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  return [
    event({
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'claude',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }),
    event({
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'claude',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
    'data: [DONE]\n\n',
  ].join('')
}

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
