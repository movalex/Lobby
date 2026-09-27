// Error responses: `{ error: { code, message } }` (docs/M1-CONTRACTS.md §5). Messages are shown to
// users, so they never contain ids of things the caller cannot see, paths, SQL or stack traces.

import type { z } from 'zod'

export class ApiError extends Error {
  readonly status: number
  /** Same value as `status`, under the name Fastify and plugin error handlers look for. */
  readonly statusCode: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.statusCode = status
    this.code = code
  }
}

export const badRequest = (message = 'The request is not valid.') => new ApiError(400, 'BAD_REQUEST', message)
export const unauthenticated = () => new ApiError(401, 'NOT_AUTHENTICATED', 'Sign in to continue.')
export const forbidden = (message = "You don't have permission to do that.") =>
  new ApiError(403, 'FORBIDDEN', message)
/** Also used when the caller cannot view the thing: existence is never revealed. */
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found.')
export const conflict = (code: string, message: string) => new ApiError(409, code, message)
export const gone = (message = 'This invitation has expired or is no longer valid.') =>
  new ApiError(410, 'GONE', message)

/** Validates untrusted input with a contracts schema; failures become 400 with a short, safe reason. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
  throw badRequest(`${where}${issue?.message ?? 'invalid input'}`.slice(0, 200))
}

const STATUS_CODES: Record<number, [string, string]> = {
  400: ['BAD_REQUEST', 'The request is not valid.'],
  401: ['NOT_AUTHENTICATED', 'Sign in to continue.'],
  403: ['FORBIDDEN', "You don't have permission to do that."],
  404: ['NOT_FOUND', 'Not found.'],
  405: ['METHOD_NOT_ALLOWED', 'Method not allowed.'],
  411: ['LENGTH_REQUIRED', 'Content-Length is required.'],
  413: ['PAYLOAD_TOO_LARGE', 'The request body is too large.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Send a JSON body (application/json) or no body.'],
  429: ['RATE_LIMITED', 'Too many requests. Wait a moment and try again.'],
}

/** Maps anything thrown by a route, hook or plugin to a status and a user-safe body. */
export function toErrorResponse(err: unknown): {
  status: number
  body: { error: { code: string; message: string } }
} {
  if (err instanceof ApiError)
    return { status: err.status, body: { error: { code: err.code, message: err.message } } }
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Framework/plugin errors (bad JSON, unsupported media type, rate limit, …): generic wording, since
    // their own messages can echo request details.
    const [code, message] = STATUS_CODES[status] ?? ['BAD_REQUEST', 'The request is not valid.']
    return { status, body: { error: { code, message } } }
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' } } }
}
