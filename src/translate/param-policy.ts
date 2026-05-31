import { unsupportedParameter } from './errors'
import type { ChatCompletionRequest } from './types'

// Params we accept syntactically but do not forward upstream. Default: drop + debug-log. With
// server.strict_params they become 400s. (PLAN §11.)
export const IGNORED_PARAMS = [
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'seed',
  'stop',
  'logprobs',
  'top_logprobs',
  'user',
] as const satisfies readonly (keyof ChatCompletionRequest)[]

// Throws unsupported_parameter for n>1 (always) and, under strict mode, the first ignored param
// present. Returns the ignored params so the caller can debug-log what it dropped.
export function enforceParamPolicy(
  request: ChatCompletionRequest,
  strict: boolean,
): { ignored: string[] } {
  if (typeof request.n === 'number' && request.n > 1) throw unsupportedParameter('n')

  const ignored = IGNORED_PARAMS.filter((param) => request[param] !== undefined)
  const first = ignored[0]
  if (strict && first) throw unsupportedParameter(first)
  return { ignored }
}
