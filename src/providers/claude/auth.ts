import { Credential } from '../../auth/credential'
import { AuthError } from '../../auth/errors'
import { errorMessage } from '../../util/errors'
import type { AuthProvider, LoginContext } from '../types'
import { type CommandRunner, runCommand } from './cli'

const PLACEHOLDER = 'claude-code-local-auth'
const TTL_SECONDS = 90 * 24 * 60 * 60

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

export const claudeAuthProvider = new ClaudeAuthProvider()
