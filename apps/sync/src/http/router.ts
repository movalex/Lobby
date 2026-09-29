import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { type BackupService, handleBackupStatus } from '../backup/service.ts'
import { BoardOpenRefused, type InternalRoute } from '../engine-switch.ts'
import { handleAssetRefs } from './asset-refs.ts'
import { handleBoardText } from './board-text.ts'
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
  /** Offsite backup status (absent = off). */
  backups?: Pick<BackupService, 'status'>
  /**
   * Spike B (engine-switch.ts): routes of the running engine (the ElementRoom's board routes,
   * /internal/metrics, the test hooks), matched first. Behind the same secret check.
   */
  engineRoutes?: readonly InternalRoute[]
  /** false: the tldraw board routes are not mounted (DRAFTROOM_ENGINE=excalidraw). Default true. */
  tldrawBoardRoutes?: boolean
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RouterDeps, seg: string[]) => unknown
type Route = { re: RegExp; methods: string[]; handle: Handler }

// Captures are raw (still percent-encoded) path segments; board ids are checked against a strict
// pattern before use, so an encoded '/' or '..' can only ever fail that check.
// Engine-neutral routes: served whatever DRAFTROOM_ENGINE is.
const NEUTRAL_ROUTES: Route[] = [
  {
    re: /^\/internal\/access-changed$/,
    methods: ['POST'],
    handle: (req, res, deps) => handleAccessChanged(req, res, deps),
  },
  // Offsite backups (offsite-backups feature; handler in backup/service.ts)
  {
    re: /^\/internal\/backups\/status$/,
    methods: ['GET'],
    handle: (_req, res, deps) => handleBackupStatus(res, deps.backups),
  },
]
// The tldraw board routes open tldraw storage on the board file: only with the tldraw engine.
const TLDRAW_BOARD_ROUTES: Route[] = [
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
  // The api's asset collector: files the canvas and "Recently deleted" still reference (asset-refs.ts)
  {
    re: /^\/internal\/boards\/([^/]+)\/asset-refs$/,
    methods: ['GET'],
    handle: (_req, res, deps, [board = '']) => handleAssetRefs(res, deps, board),
  },
  // Private brainstorming: revealed drafts become notes (workshops private-notes; place-notes.ts)
  {
    re: /^\/internal\/boards\/([^/]+)\/place-notes$/,
    methods: ['POST'],
    handle: (req, res, deps, [board = '']) => handlePlaceNotes(req, res, deps, board),
  },
  // Search across boards: a board's searchable text for the API's index (search; board-text.ts)
  {
    re: /^\/internal\/boards\/([^/]+)\/text$/,
    methods: ['GET'],
    handle: (req, res, deps, [board = '']) => handleBoardText(req, res, deps, board),
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
    const engine: Route[] = (deps.engineRoutes ?? []).map((r) => ({
      re: r.path,
      methods: [r.method],
      handle: (req, res, _deps, seg) => r.handle(req, res, seg),
    }))
    const routes = [
      ...engine,
      ...NEUTRAL_ROUTES,
      ...(deps.tldrawBoardRoutes === false ? [] : TLDRAW_BOARD_ROUTES),
    ]
    for (const r of routes) {
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
      // The R0 stand-in refusing a board born on the new canvas (spike B, engine-switch.ts pre-open checks).
      else if (e instanceof BoardOpenRefused) err = new HttpError(409, 'new-canvas', e.message)
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
