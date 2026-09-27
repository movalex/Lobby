import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FileAction, FilesDeps } from './deps.ts'

/** A request failure whose `message` is safe to show users: never paths, stack traces or tool output. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export const notFound = (headers?: Record<string, string>) =>
  new HttpError(404, 'NOT_FOUND', 'Not found.', headers)

/**
 * Runs the API core's authorization for `boardId` and returns the acting user's id. A caller who cannot
 * view the board gets the same 404 as a missing asset, so a denial never reveals that the board exists.
 */
export async function requireAccess(
  deps: FilesDeps,
  request: FastifyRequest,
  boardId: string,
  action: FileAction,
  headers?: Record<string, string>,
): Promise<string> {
  const auth = await deps.authorize(request, boardId, action)
  if (auth.ok === true) return auth.userId
  if (auth.status === 401) throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign-in required.', headers)
  if (auth.status === 403) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to add files to this board.', headers)
  }
  throw notFound(headers) // 404, and anything unexpected: fail closed
}

export function sendJson(
  reply: FastifyReply,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FastifyReply {
  return reply
    .code(status)
    .headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    .send(JSON.stringify(body))
}

// Fastify's own 4xx (e.g. a Content-Type it cannot parse) carry messages we did not write: replace them.
const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  413: { code: 'TOO_LARGE', message: 'The request is too large.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The Content-Type header is malformed.' },
}

function clientErrorStatus(err: unknown): number | null {
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null
}

/** The file routes' error handler: every failure is a JSON `{ error: { code, message } }`. */
export function fileErrorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  let e: HttpError
  const clientStatus = clientErrorStatus(err)
  if (err instanceof HttpError) e = err
  else if (clientStatus !== null) {
    const known = CLIENT_ERRORS[clientStatus] ?? { code: 'BAD_REQUEST', message: 'Bad request.' }
    e = new HttpError(clientStatus, known.code, known.message)
  } else {
    // The route pattern, never request.url: query strings are not logged.
    request.log.error({ err, route: request.routeOptions.url }, 'file route failed')
    e = new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.')
  }
  const headers = { ...e.headers }
  // An unread request body must not be drained just to keep the connection alive.
  if (!request.raw.complete) headers.Connection = 'close'
  return sendJson(reply, e.status, { error: { code: e.code, message: e.message } }, headers)
}
