import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  handleAccessChanged,
  handleListDeleted,
  handleRestoreDeleted,
  handleSeed,
  handleSnapshot,
  type InternalDeps,
} from './internal.ts'
import { handlePlaceNotes } from './place-notes.ts'
import { HttpError, notFound, sendError } from './respond.ts'

export interface RouterDeps extends InternalDeps {
  internalSecret: string
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RouterDeps, seg: string[]) => unknown

// Captures are raw (still percent-encoded) path segments; board ids are checked against a strict
// pattern before use, so an encoded '/' or '..' can only ever fail that check.
const INTERNAL_ROUTES: Array<{ re: RegExp; methods: string[]; handle: Handler }> = [
  {
    re: /^\/internal\/access-changed$/,
    methods: ['POST'],
    handle: (req, res, deps) => handleAccessChanged(req, res, deps),
  },
  {
    re: /^\/internal\/boards\/([^/]+)\/snapshot$/,
    methods: ['GET'],
    handle: (_req, res, deps, [board = '']) => handleSnapshot(res, deps, board),
  },
  {
    re: /^\/internal\/boards\/([^/]+)\/seed$/,
    methods: ['POST'],
    handle: (req, res, deps, [board = '']) => handleSeed(req, res, deps, board),
  },
  // "Recently deleted" (history feature; handlers in internal.ts)
  {
    re: /^\/internal\/boards\/([^/]+)\/deleted$/,
    methods: ['GET'],
    handle: (req, res, deps, [board = '']) => handleListDeleted(req, res, deps, board),
  },
  {
    re: /^\/internal\/boards\/([^/]+)\/deleted\/restore$/,
    methods: ['POST'],
    handle: (req, res, deps, [board = '']) => handleRestoreDeleted(req, res, deps, board),
  },
  // Private brainstorming: revealed drafts become notes (workshops private-notes; place-notes.ts)
  {
    re: /^\/internal\/boards\/([^/]+)\/place-notes$/,
    methods: ['POST'],
    handle: (req, res, deps, [board = '']) => handlePlaceNotes(req, res, deps, board),
  },
]

async function route(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouterDeps): Promise<void> {
  const p = url.pathname
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok')
    return
  }
  if (p === '/internal' || p.startsWith('/internal/')) {
    // Before routing: without the secret, the internal surface is indistinguishable from a wall.
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], deps.internalSecret))
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid internal credentials.')
    for (const r of INTERNAL_ROUTES) {
      const m = r.re.exec(p)
      if (!m) continue
      if (!r.methods.includes(req.method ?? '')) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: r.methods.join(', ') })
      }
      await r.handle(req, res, deps, m.slice(1))
      return
    }
  }
  throw notFound()
}

/** node:http request listener for everything that is not a WebSocket upgrade. */
export function createRequestHandler(deps: RouterDeps) {
  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now()
    let url: URL | null = null
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {}
    // Path only: query strings can carry tickets and identities.
    const path = (url?.pathname ?? '(unparseable)').slice(0, 256)
    res.once('close', () => {
      const status = res.headersSent ? String(res.statusCode) : '-'
      const ms = (performance.now() - started).toFixed(1)
      deps.log(
        `${req.method} ${path} ${status} ${ms}ms${res.writableFinished ? '' : ' (connection closed early)'}`,
      )
    })
    const handled = url
      ? route(req, res, url, deps)
      : Promise.reject(new HttpError(400, 'BAD_REQUEST', 'Malformed request URL.'))
    return handled.catch((e: unknown) => {
      let err: HttpError
      if (e instanceof HttpError) err = e
      else {
        deps.log('[http error]', req.method, path, e)
        err = new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.')
      }
      if (res.headersSent) return void res.destroy()
      if (res.destroyed) return
      // An unread request body must not be drained just to keep the connection alive.
      if (!req.complete) err.headers.Connection = 'close'
      sendError(res, err)
    })
  }
}
