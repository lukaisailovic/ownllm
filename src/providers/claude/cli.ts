import { spawn } from 'node:child_process'

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

export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024

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

    child.stdin.on('error', () => {})
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

export function appendBoundedOutput(
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

function claudeEnv(): NodeJS.ProcessEnv {
  if (process.env.USER) return process.env
  const home = process.env.HOME ?? ''
  const derived = home.split('/').at(-1) ?? ''
  return derived ? { ...process.env, USER: derived } : process.env
}
