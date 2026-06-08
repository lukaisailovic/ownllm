import {
  type UpstreamClient,
  type UpstreamRequestInit,
  classifyUpstreamStatus,
} from '../../http/upstream-client'
import { logger } from '../../logger'
import { upstreamError } from '../../translate/errors'
import { errorMessage } from '../../util/errors'
import { asRecord, getString, parseJson } from '../../util/json'
import type { Transport } from '../types'
import { type CommandRunner, runCommand } from './cli'

const CLAUDE_HOST = 'claude.local'
const ENDPOINT = `https://${CLAUDE_HOST}/v1/messages`
const CHAT_SYSTEM_PROMPT =
  'You are Claude, a chat completion assistant. Answer directly from the conversation. Do not use Claude Code tools, commands, MCP servers, browser integrations, or external integrations.'

export class ClaudeCliClient implements UpstreamClient {
  constructor(private readonly runner: CommandRunner = runCommand) {}

  async fetch(url: string, init: UpstreamRequestInit): Promise<Response> {
    const { hostname } = new URL(url)
    if (hostname !== CLAUDE_HOST) {
      throw upstreamError(`refusing request to non-allowlisted host: ${hostname}`)
    }
    const body = asRecord(parseJson(init.body ?? '{}'))
    const prompt = getString(body, 'prompt')
    const model = getString(body, 'model')
    if (!prompt || !model) throw upstreamError('Claude provider received an invalid request body')

    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-turns',
      '2',
      '--model',
      model,
      '--system-prompt',
      CHAT_SYSTEM_PROMPT,
    ]
    logger.debug({ command: 'claude', args }, 'claude cli invoke')
    const result = await this.runner('claude', args, init.signal, prompt).catch((error) => {
      logger.error({ command: 'claude', args, err: errorMessage(error) }, 'claude cli spawn failed')
      throw upstreamError(`Claude Code CLI request failed: ${errorMessage(error)}`)
    })
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      logger.error(
        { command: 'claude', args, exitCode: result.exitCode, stderr: detail.slice(0, 500) },
        'claude cli exited non-zero',
      )
      const suffix = detail ? `: ${detail}` : ''
      throw upstreamError(
        `Claude Code CLI exited with status ${result.exitCode ?? 'unknown'}${suffix}`,
      )
    }
    logger.debug({ command: 'claude', args, exitCode: result.exitCode }, 'claude cli succeeded')

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
