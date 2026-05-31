// OpenAI-compatible error object + the PLAN §11 status/type/code/param map. Every non-2xx response
// is one of these, carrying an x-request-id header. Throw a OwnllmError anywhere; the server's
// onError handler renders it.
export interface OpenAIErrorObject {
  message: string
  type: string
  param?: string
  code?: string
}

interface OwnllmErrorArgs {
  status: number
  type: string
  message: string
  code?: string
  param?: string
  headers?: Record<string, string>
}

export class OwnllmError extends Error {
  readonly status: number
  readonly type: string
  readonly code?: string
  readonly param?: string
  readonly headers: Record<string, string>

  constructor(args: OwnllmErrorArgs) {
    super(args.message)
    this.name = 'OwnllmError'
    this.status = args.status
    this.type = args.type
    this.code = args.code
    this.param = args.param
    this.headers = args.headers ?? {}
  }

  toErrorObject(): OpenAIErrorObject {
    return { message: this.message, type: this.type, param: this.param, code: this.code }
  }

  toResponse(requestId: string): Response {
    return Response.json(
      { error: this.toErrorObject() },
      { status: this.status, headers: { 'x-request-id': requestId, ...this.headers } },
    )
  }
}

export function modelNotFound(model: string): OwnllmError {
  return new OwnllmError({
    status: 404,
    type: 'invalid_request_error',
    code: 'model_not_found',
    param: 'model',
    message: `The model '${model}' does not exist or you do not have access to it.`,
  })
}

export function invalidRequestBody(message: string, param?: string): OwnllmError {
  return new OwnllmError({ status: 400, type: 'invalid_request_error', message, param })
}

export function invalidApiKey(): OwnllmError {
  return new OwnllmError({
    status: 401,
    type: 'invalid_request_error',
    code: 'invalid_api_key',
    message: 'Incorrect API key provided.',
  })
}

export function unsupportedParameter(param: string): OwnllmError {
  return new OwnllmError({
    status: 400,
    type: 'invalid_request_error',
    code: 'unsupported_parameter',
    param,
    message: `Unsupported parameter: '${param}'.`,
  })
}

export function credentialExpired(): OwnllmError {
  return new OwnllmError({
    status: 401,
    type: 'invalid_request_error',
    code: 'credential_expired',
    message: 'The stored credential is no longer valid; run `ownllm auth login`.',
  })
}

export function xaiTierDenied(): OwnllmError {
  return new OwnllmError({
    status: 403,
    type: 'permission_error',
    code: 'xai_tier_denied',
    message: 'xAI denied programmatic access for this account (tier not entitled).',
  })
}

export function codexCloudflareBlocked(): OwnllmError {
  return new OwnllmError({
    status: 502,
    type: 'api_error',
    code: 'codex_cloudflare_blocked',
    message: 'The Codex upstream was blocked at the Cloudflare edge (see `ownllm doctor`).',
  })
}

export function rateLimited(headers?: Record<string, string>): OwnllmError {
  return new OwnllmError({
    status: 429,
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
    message: 'Rate limited by the upstream provider.',
    headers,
  })
}

export function upstreamError(message = 'The upstream provider returned an error.'): OwnllmError {
  return new OwnllmError({ status: 502, type: 'api_error', message })
}

export function internalError(): OwnllmError {
  return new OwnllmError({ status: 500, type: 'api_error', message: 'Internal server error.' })
}
