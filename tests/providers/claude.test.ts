import { describe, expect, it } from 'vitest'
import type { AuthError } from '../../src/auth/errors'
import { parseSSE } from '../../src/http/sse'
import {
  ClaudeAuthProvider,
  type CommandRunner,
  MAX_COMMAND_OUTPUT_BYTES,
  runCommand,
} from '../../src/providers/claude/auth'
import { CLAUDE_MODELS } from '../../src/providers/claude/models'
import { claudeModule } from '../../src/providers/claude/module'
import { buildClaudePrompt, claudeTranslator } from '../../src/providers/claude/translator'
import {
  ClaudeCliClient,
  claudeOutputText,
  claudeTransport,
} from '../../src/providers/claude/transport'
import { getProvider } from '../../src/providers/registry'
import { resolveModel } from '../../src/router/resolve'
import type { ChatCompletionRequest, TranslateContext } from '../../src/translate/types'
import { testConfig } from '../support/app'

const CONFIG_YAML = `
server: { host: 127.0.0.1, api_key: test-key }
providers:
  claude: { enabled: true }
models:
  claude: { provider: claude, upstream: sonnet }
`

const request: ChatCompletionRequest = {
  model: 'claude',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'developer', content: 'Prefer TypeScript.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: 'Hi', tool_calls: [toolCall('call_1')] },
    { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
  ],
}

const ctx: TranslateContext = {
  requestedModel: 'claude',
  upstreamModel: 'sonnet',
  conversationId: 'conv',
  includeUsage: false,
}

describe('claude provider registration + models', () => {
  it('registers under id and alias and resolves through config', () => {
    expect(getProvider('claude')?.id).toBe('claude')
    expect(getProvider('claude-code')?.id).toBe('claude')
    expect(resolveModel(testConfig(CONFIG_YAML), 'claude')).toMatchObject({
      providerId: 'claude',
      upstreamModel: 'sonnet',
    })
  })

  it('advertises local-cli capabilities truthfully', async () => {
    expect(claudeModule.capabilities).toEqual({
      stream: true,
      tools: false,
      vision: false,
      reasoning: false,
    })
    expect(await claudeModule.listModels()).toBe(CLAUDE_MODELS)
  })
})

describe('claude auth', () => {
  it('stores a no-secret placeholder after CLI auth succeeds', async () => {
    const auth = new ClaudeAuthProvider(successRunner)
    const credential = await auth.login({ report: () => {}, prompt: async () => '' })
    expect(credential.accessToken).toBe('claude-code-local-auth')
    expect(credential.refreshToken).toBe('claude-code-local-auth')
    expect(auth.isExpired(credential)).toBe(false)
  })

  it('classifies failed CLI auth as a dead credential', async () => {
    const auth = new ClaudeAuthProvider(async () => ({ stdout: '', stderr: '', exitCode: 1 }))
    await expect(auth.login({ report: () => {}, prompt: async () => '' })).rejects.toMatchObject({
      code: 'credential_dead',
    } satisfies Partial<AuthError>)
  })

  it('passes USER env var to subprocess so claude can find its config without a login shell', async () => {
    const originalUser = process.env.USER
    process.env.USER = undefined
    try {
      const result = await runCommand(process.execPath, [
        '-e',
        'process.stdout.write(process.env.USER ?? "missing")',
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toBe('missing')
      expect(result.stdout.length).toBeGreaterThan(0)
    } finally {
      process.env.USER = originalUser
    }
  })

  it('bounds command stdout and stderr capture', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      `process.stdout.write('a'.repeat(${MAX_COMMAND_OUTPUT_BYTES + 10})); process.stderr.write('b'.repeat(${MAX_COMMAND_OUTPUT_BYTES + 10}))`,
    ])

    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })
})

describe('claude translator + transport', () => {
  it('builds a simple textual Claude prompt', () => {
    expect(buildClaudePrompt(request)).toContain('SYSTEM:\nBe concise.')
    expect(buildClaudePrompt(request)).toContain('DEVELOPER:\nPrefer TypeScript.')
    expect(buildClaudePrompt(request)).toContain('USER:\nHello')
    expect(buildClaudePrompt(request)).toContain('Tool call call_1: lookup({})')
    expect(buildClaudePrompt(request)).toContain('TOOL:\ntool result')
  })

  it('converts requests into a CLI body', () => {
    expect(claudeTranslator.toUpstream(request, ctx)).toEqual({
      model: 'sonnet',
      prompt: buildClaudePrompt(request),
    })
  })

  it('parses Claude JSON output without exposing raw credential files', () => {
    expect(claudeOutputText('{"type":"result","result":"hello"}')).toBe('hello')
    expect(
      claudeOutputText('{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}'),
    ).toBe('a\nb')
  })

  it('invokes claude -p safely over stdin and returns SSE chunks aggregatable as chat completion', async () => {
    const calls: { command: string; args: readonly string[]; stdin?: string }[] = []
    const client = new ClaudeCliClient(async (command, args, _signal, stdin) => {
      calls.push({ command, args, stdin })
      return { stdout: '{"result":"Hello from Claude"}', stderr: '', exitCode: 0 }
    })
    const response = await client.fetch(claudeTransport.endpoint(ctx), {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'sonnet', prompt: 'USER:\nHello' }),
    })

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(calls).toEqual([
      {
        command: 'claude',
        args: [
          '-p',
          '--output-format',
          'json',
          '--max-turns',
          '2',
          '--model',
          'sonnet',
          '--system-prompt',
          expect.stringContaining('Do not use Claude Code tools'),
        ],
        stdin: 'USER:\nHello',
      },
    ])
    expect(await claudeTranslator.fromUpstream(parseSSE(response.body!), ctx)).toMatchObject({
      object: 'chat.completion',
      model: 'claude',
      choices: [
        { message: { role: 'assistant', content: 'Hello from Claude' }, finish_reason: 'stop' },
      ],
    })
  })

  it('returns one content chunk plus a stop chunk for streaming clients', async () => {
    const response = await new ClaudeCliClient(successRunner).fetch(claudeTransport.endpoint(ctx), {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'sonnet', prompt: 'USER:\nHello' }),
    })
    const chunks = []
    for await (const chunk of claudeTranslator.streamToChunks(parseSSE(response.body!), ctx)) {
      chunks.push(chunk)
    }
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '')).toEqual(['ok', ''])
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop')
  })

  it('classifies transport errors with the shared status policy', () => {
    expect(claudeTransport.classifyError(401, new Headers(), '').code).toBe('credential_expired')
    expect(claudeTransport.classifyError(429, new Headers(), '').status).toBe(429)
  })

  it('includes stderr in the error message when exit code is non-zero', async () => {
    const client = new ClaudeCliClient(async () => ({
      stdout: '',
      stderr: 'Not logged in · Please run /login',
      exitCode: 1,
    }))
    await expect(
      client.fetch(claudeTransport.endpoint(ctx), {
        method: 'POST',
        headers: {},
        body: JSON.stringify({ model: 'sonnet', prompt: 'USER:\nHello' }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Not logged in') })
  })
})

const successRunner: CommandRunner = async () => ({
  stdout: '{"result":"ok"}',
  stderr: '',
  exitCode: 0,
})

function toolCall(id: string) {
  return { id, type: 'function' as const, function: { name: 'lookup', arguments: '{}' } }
}
