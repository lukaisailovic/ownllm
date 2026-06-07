import { spawn } from 'node:child_process'
import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import type { AuthProvider, LoginContext } from '../types'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  stdin?: string,
) => Promise<CommandResult>

const PLACEHOLDER = 'claude-code-local-auth'
const TTL_SECONDS = 90 * 24 * 60 * 60
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024

// The claude CLI requires USER to be set in order to locate its auth config (~/.claude.json).
// When ownllm runs as a LaunchAgent the plist env may omit USER, so we inject it explicitly,
// deriving it from HOME if necessary (e.g. HOME=/Users/alice → USER=alice).
function claudeEnv(): NodeJS.ProcessEnv {
  if (process.env.USER) return process.env
  const home = process.env.HOME ?? ''
  const derived = home.split('/').at(-1) ?? ''
  return derived ? { ...process.env, USER: derived } : process.env
}

export const runCommand: CommandRunner = (command, args, signal, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv() })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0

    const abort = () => child.kill('SIGTERM')
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })

    child.stdin.end(stdin ?? '')

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      ;[stdout, stdoutBytes] = appendBoundedOutput(stdout, stdoutBytes, chunk)
    })
    child.stderr.on('data', (chunk) => {
      ;[stderr, stderrBytes] = appendBoundedOutput(stderr, stderrBytes, chunk)
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      signal?.removeEventListener('abort', abort)
      resolve({ stdout, stderr, exitCode })
    })
  })

function appendBoundedOutput(
  current: string,
  capturedBytes: number,
  chunk: string,
): [string, number] {
  const availableBytes = MAX_COMMAND_OUTPUT_BYTES - capturedBytes
  if (availableBytes <= 0) return [current, capturedBytes]

  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (chunkBytes <= availableBytes) return [current + chunk, capturedBytes + chunkBytes]

  return [
    current + Buffer.from(chunk, 'utf8').subarray(0, availableBytes).toString('utf8'),
    MAX_COMMAND_OUTPUT_BYTES,
  ]
}

export class ClaudeAuthProvider implements AuthProvider {
  readonly id = 'claude'

  constructor(private readonly runner: CommandRunner = runCommand) {}

  isExpired(_credential: Credential): boolean {
    return false
  }

  async login(ctx: LoginContext): Promise<Credential> {
    await this.verifyCliAuth(ctx.signal)
    ctx.report('Claude Code CLI authentication is available; stored local-auth placeholder.')
    return placeholderCredential()
  }

  async refresh(): Promise<Credential> {
    await this.verifyCliAuth()
    return placeholderCredential()
  }

  private async verifyCliAuth(signal?: AbortSignal): Promise<void> {
    const result = await this.runner('claude', ['auth', 'status', '--text'], signal).catch(
      (error) => {
        throw new AuthError('login_failed', `Claude Code CLI check failed: ${errorMessage(error)}`)
      },
    )
    if (result.exitCode === 0) return
    throw new AuthError(
      'credential_dead',
      'Claude Code CLI is not authenticated; run `claude auth login` then `ownllm auth login claude`.',
    )
  }
}

function placeholderCredential(): Credential {
  return new Credential({
    type: 'oauth',
    access_token: PLACEHOLDER,
    refresh_token: PLACEHOLDER,
    expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    last_refresh: new Date().toISOString(),
    auth_mode: 'local_cli',
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const claudeAuthProvider = new ClaudeAuthProvider()
