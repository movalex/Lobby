import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { RUN_ALL_ID_RE, type RunAll } from '../backup/run-all.ts'
import { type BackupService, handleBackupStatus } from '../backup/service.ts'
import type { InternalRoute } from '../engine-switch.ts'
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
  refuseInMaintenance,
} from './internal.ts'
import { handlePlaceNotes } from './place-notes.ts'
import { HttpError, notFound, sendError, sendJson } from './respond.ts'

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
  /**
   * Maintenance mode (bridge release R0, app.ts): `set(true)` lets the pushes that reached the server
   * commit, closes every socket with 4099 MAINTENANCE and refuses new ones. Absent: the routes answer 404.
   */
  maintenance?: MaintenanceControl
  /**
   * POST /internal/backups/run-all starts a run (202 with its id), GET …/run-all/<runId> reads it, with
   * its report once done, and GET …/run-all lists the runs (backup/run-all.ts). Absent: 404.
   */
  runAll?: Pick<RunAll, 'request' | 'get' | 'list'>
  /**
   * The canvas engine this server runs (DRAFTROOM_ENGINE), for GET /internal/canvas: the api reads it to
   * know whether the boards and checkpoints it makes are on the new canvas (bridge release R0's
   * `boards.new_canvas` and `board_snapshots.body_version`). Absent = tldraw.
   */
  engine?: 'tldraw' | 'excalidraw'
}

export interface MaintenanceControl {
  on(): boolean
  set(on: boolean): { maintenance: boolean; closedSockets: number }
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RouterDeps, seg: string[]) => unknown
type Route = { re: RegExp; methods: string[]; handle: Handler }

/**
 * Wraps a board-writing handler: refused while maintenance is on, so no edit reaches a board file. This
 * is the check on entry, before the body is read; each handler checks again after reading it
 * (refuseInMaintenance, internal.ts), because maintenance can go on while a body is still arriving.
 */
const writing =
  (handle: Handler): Handler =>
  (req, res, deps, seg) => {
    refuseInMaintenance(deps)
    return handle(req, res, deps, seg)
  }

const MAINTENANCE_LIMIT_BYTES = 1024

/** The engine POSTs maintenance does not refuse: the cut-over's conversion runs inside the window (§7.5 step 6). */
const MAINTENANCE_EXEMPT_ENGINE_POSTS = /^\/internal\/migrate\/convert-all(?:\?|$)/

async function handleMaintenance(req: IncomingMessage, res: ServerResponse, deps: RouterDeps) {
  const control = deps.maintenance
  if (!control) throw notFound()
  if (req.method === 'GET') return sendJson(res, 200, { maintenance: control.on() })
  const body = (await readJson(req, MAINTENANCE_LIMIT_BYTES)) as { on?: unknown } | null
  if (typeof body?.on !== 'boolean' || Object.keys(body).length !== 1)
    throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"on": true} or {"on": false}.')
  sendJson(res, 200, control.set(body.on))
}

/** Where a run is read (the POST's Location). */
export const runAllPath = (runId: string) => `/internal/backups/run-all/${runId}`

/**
 * POST: starts a run, or joins the one that will answer this call (backup/run-all.ts), and answers at
 * once with 202 and the run's id. The run goes on in the server; GET …/run-all/<runId> has its report
 * once it is done. No client waits on one request for a run that can take many minutes.
 */
function handleRunAllStart(res: ServerResponse, deps: RouterDeps) {
  if (!deps.runAll) throw notFound()
  if (!deps.registry.backupsDir())
    throw new HttpError(409, 'BACKUPS_OFF', 'Local backups are off on this server.')
  const run = deps.runAll.request()
  sendJson(res, 202, run, { Location: runAllPath(run.runId) })
}

function handleRunAllList(res: ServerResponse, deps: RouterDeps) {
  if (!deps.runAll) throw notFound()
  sendJson(res, 200, { runs: deps.runAll.list() })
}

function handleRunAllGet(res: ServerResponse, deps: RouterDeps, rawRunId: string) {
  if (!deps.runAll) throw notFound()
  const run = RUN_ALL_ID_RE.test(rawRunId) ? deps.runAll.get(rawRunId) : null
  if (!run)
    throw new HttpError(
      404,
      'RUN_NOT_FOUND',
      'This server has no run-all run with that id. Runs are kept until the sync server restarts, which also turns maintenance off.',
    )
  sendJson(res, 200, run)
}

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
  // Bridge release R0: a fresh local + offsite backup of every board, for the cut-over runbook. POST
  // starts a run (202), GET lists the runs, GET …/<runId> answers with the report once it is done.
  {
    re: /^\/internal\/backups\/run-all$/,
    methods: ['GET', 'POST'],
    handle: (req, res, deps) =>
      req.method === 'POST' ? handleRunAllStart(res, deps) : handleRunAllList(res, deps),
  },
  {
    re: /^\/internal\/backups\/run-all\/([^/]+)$/,
    methods: ['GET'],
    handle: (_req, res, deps, [runId = '']) => handleRunAllGet(res, deps, runId),
  },
  // Which canvas this server runs (R0's contracts: the api marks what it makes on the new canvas)
  {
    re: /^\/internal\/canvas$/,
    methods: ['GET'],
    handle: (_req, res, deps) => sendJson(res, 200, { engine: deps.engine ?? 'tldraw' }),
  },
  // Bridge release R0: maintenance mode (sockets closed and refused; internal reads keep working)
  {
    re: /^\/internal\/maintenance$/,
    methods: ['GET', 'POST'],
    handle: (req, res, deps) => handleMaintenance(req, res, deps),
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
    // The Excalidraw engine's routes: every POST writes a board (the room's workshop-state, the api's seed,
    // place-notes and deleted/restore, the test server-write and prepare) and is refused in maintenance
    // like the tldraw board routes above (DEPLOY.md: "no edit can reach a board file"), except the
    // cut-over's own `convert-all`, which the runbook runs INSIDE the maintenance window (§7.5 step 6).
    // Before, only TLDRAW_BOARD_ROUTES were wrapped, so on DRAFTROOM_ENGINE=excalidraw a restore, a seed
    // or an AI placement wrote the board file while files were being copied or converted (V2 P-M2, P-M4).
    const engine: Route[] = (deps.engineRoutes ?? []).map((r) => ({
      re: r.path,
      methods: [r.method],
      handle: (req, res, routerDeps, seg) => {
        if (r.method === 'POST' && !MAINTENANCE_EXEMPT_ENGINE_POSTS.test(req.url ?? ''))
          refuseInMaintenance(routerDeps)
        return r.handle(req, res, seg)
      },
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
