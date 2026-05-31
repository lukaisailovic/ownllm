import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { AuthError } from '../../auth/errors'

// xAI's auth UI (https://accounts.x.ai) makes a cross-origin, private-network request to this
// loopback callback, so the preflight must grant CORS + Private Network Access (PLAN risk C).
const CORS_ORIGIN = 'https://accounts.x.ai'

export interface CallbackResult {
  code: string
  state: string
}

export interface LoopbackServer {
  waitForCallback(signal?: AbortSignal): Promise<CallbackResult>
  close(): void
}

export async function startLoopbackServer(
  port: number,
  callbackPath: string,
): Promise<LoopbackServer> {
  let resolve!: (result: CallbackResult) => void
  let reject!: (error: Error) => void
  const callback = new Promise<CallbackResult>((res, rej) => {
    resolve = res
    reject = rej
  })

  const server = createServer((req, res) => {
    handleRequest(req, res, callbackPath, resolve, reject)
  })

  await new Promise<void>((res, rej) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rej(
        error.code === 'EADDRINUSE'
          ? new AuthError('login_failed', `loopback port ${port} is in use; free it and retry`)
          : error,
      )
    })
    server.listen(port, '127.0.0.1', res)
  })

  return {
    waitForCallback(signal) {
      return signal ? Promise.race([callback, abortOn(signal)]) : callback
    },
    close() {
      server.close()
    },
  }
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  callbackPath: string,
  resolve: (result: CallbackResult) => void,
  reject: (error: Error) => void,
): void {
  setCorsHeaders(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== callbackPath) {
    res.writeHead(404)
    res.end()
    return
  }

  const error = url.searchParams.get('error')
  if (error) {
    respondHtml(res, 400, `Authorization failed: ${error}`)
    reject(new AuthError('login_failed', `authorization failed: ${error}`))
    return
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) {
    respondHtml(res, 400, 'Missing code or state in callback.')
    reject(new AuthError('login_failed', 'callback missing code or state'))
    return
  }

  respondHtml(
    res,
    200,
    'Authorization complete. You can close this tab and return to the terminal.',
  )
  resolve({ code, state })
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const requestedHeaders = req.headers['access-control-request-headers']
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', requestedHeaders ?? '*')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Access-Control-Max-Age', '600')
}

function respondHtml(res: ServerResponse, status: number, message: string): void {
  const body = `<body style="font-family:system-ui;padding:2rem"><p>${message}</p></body>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>ownllm</title>${body}`)
}

function abortOn(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new AuthError('login_cancelled', 'login cancelled'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}
