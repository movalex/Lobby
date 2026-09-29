import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import type { RunAllReport } from '../backup/run-all.ts'
import { type BackupService, handleBackupStatus } from '../backup/service.ts'
import { BoardOpenRefused, NEW_CANVAS_ERROR_CODE } from '../r0/pre-open.ts'
import { handleAssetRefs } from './asset-refs.ts'
import { handleBoardText } from './board-text.ts'
import { readJson } from './body.ts'
import {
  handleAccessChanged,
  handleListDeleted,
  handleRestoreDeleted,
  handleSeed,
  handleSnapshot,
  type InternalDeps,
} from './internal.ts'
import { handlePlaceNotes } from './place-notes.ts'
import { HttpError, notFound, sendError, sendJson } from './respond.ts'

export interface RouterDeps extends InternalDeps {
  internalSecret: string
  /** Offsite backup status (absent = off). */
  backups?: Pick<BackupService, 'status'>
  /**
   * Maintenance mode (bridge release R0, app.ts): `set(true)` lets the pushes that reached the server
   * commit, closes every socket with 4099 MAINTENANCE and refuses new ones. Absent: the routes answer 404.
   */
  maintenance?: MaintenanceControl
  /** POST /internal/backups/run-all (backup/run-all.ts). Absent: 404. */
  runAll?: () => Promise<RunAllReport>
}

export interface MaintenanceControl {
  on(): boolean
  set(on: boolean): { maintenance: boolean; closedSockets: number }
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RouterDeps, seg: string[]) => unknown

/** While maintenance is on, the internal routes that WRITE a board answer this (reads keep working). */
const inMaintenance = () =>
  new HttpError(503, 'MAINTENANCE', 'Lobby is updating. Board changes are paused for a few minutes.')

/** Wraps a board-writing handler: refused while maintenance is on, so no edit reaches a board file. */
const writing =
  (handle: Handler): Handler =>
  (req, res, deps, seg) => {
    if (deps.maintenance?.on()) throw inMaintenance()
    return handle(req, res, deps, seg)
  }

const MAINTENANCE_LIMIT_BYTES = 1024

async function handleMaintenance(req: IncomingMessage, res: ServerResponse, deps: RouterDeps) {
  const control = deps.maintenance
  if (!control) throw notFound()
  if (req.method === 'GET') return sendJson(res, 200, { maintenance: control.on() })
  const body = (await readJson(req, MAINTENANCE_LIMIT_BYTES)) as { on?: unknown } | null
  if (typeof body?.on !== 'boolean' || Object.keys(body).length !== 1)
    throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"on": true} or {"on": false}.')
  sendJson(res, 200, control.set(body.on))
}

async function handleRunAll(res: ServerResponse, deps: RouterDeps) {
  if (!deps.runAll) throw notFound()
  if (!deps.registry.backupsDir())
    throw new HttpError(409, 'BACKUPS_OFF', 'Local backups are off on this server.')
  sendJson(res, 200, await deps.runAll())
}

// Captures are raw (still percent-encoded) path segments; board ids are checked against a strict
// pattern before use, so an encoded '/' or '..' can only ever fail that check.
const INTERNAL_ROUTES: Array<{ re: RegExp; methods: string[]; handle: Handler }> = [
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
  // Bridge release R0: a fresh local + offsite backup of every board, for the cut-over runbook
  {
    re: /^\/internal\/backups\/run-all$/,
    methods: ['POST'],
    handle: (_req, res, deps) => handleRunAll(res, deps),
  },
  // Bridge release R0: maintenance mode (sockets closed and refused; internal reads keep working)
  {
    re: /^\/internal\/maintenance$/,
    methods: ['GET', 'POST'],
    handle: (req, res, deps) => handleMaintenance(req, res, deps),
  },
  {
    re: /^\/internal\/boards\/([^/]+)\/snapshot$/,
    methods: ['GET'],
    handle: (_req, res, deps, [board = '']) => handleSnapshot(res, deps, board),
  },
  {
    re: /^\/internal\/boards\/([^/]+)\/seed$/,
    methods: ['POST'],
    handle: writing((req, res, deps, [board = '']) => handleSeed(req, res, deps, board)),
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
    handle: writing((req, res, deps, [board = '']) => handleRestoreDeleted(req, res, deps, board)),
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
    handle: writing((req, res, deps, [board = '']) => handlePlaceNotes(req, res, deps, board)),
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
      // Bridge release R0: a board born on the new canvas (r0/pre-open.ts), refused before any room opened.
      else if (e instanceof BoardOpenRefused) err = new HttpError(409, NEW_CANVAS_ERROR_CODE, e.message)
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
