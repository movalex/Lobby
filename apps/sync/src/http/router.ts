import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkInternalSecret, INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { RecentHeldSetError, RUN_ALL_ID_RE, type RunAll } from '../backup/run-all.ts'
import { type BackupService, handleBackupStatus } from '../backup/service.ts'
import type { InternalRoute } from '../engine-switch.ts'
import { errorSummary } from '../log-error.ts'
import { readJson } from './body.ts'
import { handleAccessChanged, type InternalDeps, refuseInMaintenance } from './internal.ts'
import { HttpError, notFound, sendError, sendJson } from './respond.ts'

export interface RouterDeps extends InternalDeps {
  internalSecret: string
  /** Offsite backup status (absent = off). */
  backups?: Pick<BackupService, 'status'>
  /**
   * The engine's routes (the ElementRoom's board routes and its extensions', /internal/metrics, the test
   * hooks), matched first. Behind the same secret check.
   */
  engineRoutes?: readonly InternalRoute[]
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
  /** The local backups root (null: local backups are off, so run-all answers 409 BACKUPS_OFF). Absent: off. */
  backupsDir?: () => string | null
  /**
   * M7-6: GET /healthz/deep's reasons (health.ts deepHealthReasons; empty = healthy). Public, codes only. Absent:
   * the path is unknown (404).
   */
  deepHealth?: () => readonly string[]
}

export interface MaintenanceControl {
  on(): boolean
  set(on: boolean): { maintenance: boolean; closedSockets: number }
}

type Handler = (req: IncomingMessage, res: ServerResponse, deps: RouterDeps, seg: string[]) => unknown
type Route = { re: RegExp; methods: string[]; handle: Handler }

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

const RUN_ALL_BODY_LIMIT_BYTES = 1024

/**
 * Whether the request carries a body at all: the runbook command sends none without --force, and the
 * runbook's `int` helper sends a JSON content-type with an empty body, which is no body either.
 */
const hasBody = (req: IncomingMessage) =>
  Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined

/**
 * POST: starts a run, or joins the one that will answer this call (backup/run-all.ts), and answers at
 * once with 202 and the run's id. The run goes on in the server; GET …/run-all/<runId> has its report
 * once it is done. No client waits on one request for a run that can take many minutes. The body is
 * optional: `{"force": true}` writes a set although a recent held set exists (409 RECENT_HELD_SET
 * otherwise; security audit L6, the header of run-all.ts).
 */
async function handleRunAllStart(req: IncomingMessage, res: ServerResponse, deps: RouterDeps) {
  if (!deps.runAll) throw notFound()
  if (!deps.backupsDir?.()) throw new HttpError(409, 'BACKUPS_OFF', 'Local backups are off on this server.')
  let force = false
  if (hasBody(req)) {
    const body = (await readJson(req, RUN_ALL_BODY_LIMIT_BYTES)) as Record<string, unknown> | null
    if (body !== null && (typeof body !== 'object' || Array.isArray(body)))
      throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"force": true}, or empty.')
    for (const k of Object.keys(body ?? {}))
      if (k !== 'force')
        throw new HttpError(400, 'BAD_REQUEST', 'The body must be {"force": true}, or empty.')
    if (body?.force !== undefined && typeof body.force !== 'boolean')
      throw new HttpError(400, 'BAD_REQUEST', 'force must be a boolean.')
    force = body?.force === true
  }
  let run: ReturnType<RunAll['request']>
  try {
    run = deps.runAll.request({ force })
  } catch (e) {
    if (e instanceof RecentHeldSetError) throw new HttpError(409, 'RECENT_HELD_SET', e.message)
    throw e
  }
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
// The server's own routes; the board routes are the engine's (engineRoutes).
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
      req.method === 'POST' ? handleRunAllStart(req, res, deps) : handleRunAllList(res, deps),
  },
  {
    re: /^\/internal\/backups\/run-all\/([^/]+)$/,
    methods: ['GET'],
    handle: (_req, res, deps, [runId = '']) => handleRunAllGet(res, deps, runId),
  },
  // Which canvas this server runs (R0's contracts: the api marks what it makes on the new canvas; since
  // wave 4 part 2 this build has one answer, and R0's sync has no such route)
  {
    re: /^\/internal\/canvas$/,
    methods: ['GET'],
    handle: (_req, res) => sendJson(res, 200, { engine: 'excalidraw' }),
  },
  // Wave N.1 ("one clock"): this server's time, ms since the epoch. It stamps every element (`updated`, the creation
  // stamp), and the api stores visit times on it so "Since your last visit" compares times from one clock
  // (apps/api/src/sync-clock.ts measures the offset). An older sync has no such route (404: the api keeps its own).
  {
    re: /^\/internal\/clock$/,
    methods: ['GET'],
    handle: (_req, res) => sendJson(res, 200, { now: Date.now() }),
  },
  // Bridge release R0: maintenance mode (sockets closed and refused; internal reads keep working)
  {
    re: /^\/internal\/maintenance$/,
    methods: ['GET', 'POST'],
    handle: (req, res, deps) => handleMaintenance(req, res, deps),
  },
]

async function route(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouterDeps): Promise<void> {
  const p = url.pathname
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok')
    return
  }
  // M7-6 (CAP-ALERTS): the deep check for an external monitor (health.ts). Render's health check stays /healthz.
  if (p === '/healthz/deep' && deps.deepHealth) {
    const reasons = deps.deepHealth()
    res
      .writeHead(reasons.length ? 503 : 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end(reasons.length ? reasons.join(',') : 'ok')
    return
  }
  if (p === '/internal' || p.startsWith('/internal/')) {
    // Before routing: without the secret, the internal surface is indistinguishable from a wall.
    if (!checkInternalSecret(req.headers[INTERNAL_SECRET_HEADER], deps.internalSecret))
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid internal credentials.')
    // The engine's routes: every POST writes a board (the room's workshop-state, the api's seed,
    // place-notes and deleted/restore, the test server-write and prepare) and is refused in maintenance
    // (DEPLOY.md: "no edit can reach a board file"), except the cut-over's own `convert-all`, which the
    // runbook runs INSIDE the maintenance window (§7.5 step 6). (V2 P-M2, P-M4.)
    const engine: Route[] = (deps.engineRoutes ?? []).map((r) => ({
      re: r.path,
      methods: [r.method],
      handle: (req, res, routerDeps, seg) => {
        if (r.method === 'POST' && !MAINTENANCE_EXEMPT_ENGINE_POSTS.test(req.url ?? ''))
          refuseInMaintenance(routerDeps)
        return r.handle(req, res, seg)
      },
    }))
    const routes = [...engine, ...NEUTRAL_ROUTES]
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
      else {
        deps.log('[http error]', req.method, path, errorSummary(e))
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
