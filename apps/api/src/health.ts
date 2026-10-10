// Health that means something (wave M, M5-6; CAP-ALERTS, S8). GET /healthz stays a liveness answer (Render's
// healthCheckPath: a failing database must never restart the api). GET /healthz/deep is for an outside monitor:
//
//   200 'ok'                         nothing is wrong
//   503 '<code>[,<code>...]'         what is wrong, as fixed reason codes:
//     db    SELECT 1 did not answer within DB_PROBE_TIMEOUT_MS (or failed)
//     5xx   more than SERVER_ERRORS_MAX 5xx answers within SERVER_ERRORS_WINDOW_MS
//     ai    more than half of the AI provider calls within AI_WINDOW_MS failed (at least AI_MIN_CALLS calls)
//
// Public and without data: the body is the codes only (no counts, no messages, no ids), so it tells a stranger
// nothing a status page would not. The database probe is single-flight and its answer is kept for
// DB_PROBE_CACHE_MS, so hammering the route costs at most one query per window and never piles up queries on a
// database that hangs. The counters live in memory (this process, since it started); nothing is stored or logged.
//
// What counts as an AI provider call is read from the AI routes' answers (app.ts's onResponse), without touching
// the AI feature: a 2xx of a provider-calling route is a call that worked, a 502 or 504 one that failed (the AI
// feature answers 502 AI_UPSTREAM / AI_BAD_OUTPUT and 504 for the provider's failures and nothing else); a refusal
// before the provider is asked (403, 429, a 503 budget or switch) is no call at all.

import type { Queryable } from '@draftroom/db'

export const HEALTH_DEEP_ROUTE = '/healthz/deep'

export const DB_PROBE_TIMEOUT_MS = 2_000
export const DB_PROBE_CACHE_MS = 5_000
export const SERVER_ERRORS_MAX = 5
export const SERVER_ERRORS_WINDOW_MS = 5 * 60_000
export const AI_WINDOW_MS = 15 * 60_000
export const AI_MIN_CALLS = 3
/** The routes that call the AI provider (POST): a board's AI run, and asking across boards (wave M, W8). */
export const AI_PROVIDER_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/boards/:bid/ai/run',
  'POST /api/workspaces/:wid/ai/ask',
])

export type HealthReason = 'db' | '5xx' | 'ai'

export interface HealthOptions {
  dbTimeoutMs: number
  dbCacheMs: number
  serverErrorsMax: number
  serverErrorsWindowMs: number
  aiWindowMs: number
  aiMinCalls: number
}

export const DEFAULT_HEALTH: HealthOptions = {
  dbTimeoutMs: DB_PROBE_TIMEOUT_MS,
  dbCacheMs: DB_PROBE_CACHE_MS,
  serverErrorsMax: SERVER_ERRORS_MAX,
  serverErrorsWindowMs: SERVER_ERRORS_WINDOW_MS,
  aiWindowMs: AI_WINDOW_MS,
  aiMinCalls: AI_MIN_CALLS,
}

export interface Health {
  /** One answer of the api (its matched route pattern, or undefined for no route). */
  record(method: string, route: string | undefined, status: number): void
  /** What is wrong now, in a fixed order (db, 5xx, ai); empty when nothing is. */
  reasons(): Promise<HealthReason[]>
}

/** Timestamps (ms) within a sliding window; old ones are dropped as new ones come and on every read. */
class Window {
  private readonly at: number[] = []
  private readonly ms: number
  constructor(ms: number) {
    this.ms = ms
  }
  add(t: number) {
    this.at.push(t)
    this.prune(t)
  }
  count(t: number): number {
    this.prune(t)
    return this.at.length
  }
  private prune(t: number) {
    const from = t - this.ms
    let drop = 0
    while (drop < this.at.length && (this.at[drop] as number) <= from) drop++
    if (drop) this.at.splice(0, drop)
    // a burst never grows without bound: past this many the window's verdict is the same anyway
    if (this.at.length > 10_000) this.at.splice(0, this.at.length - 10_000)
  }
}

export function createHealth(deps: {
  db: Pick<Queryable, 'query'>
  now?: () => number
  options?: Partial<HealthOptions>
}): Health {
  const o: HealthOptions = { ...DEFAULT_HEALTH, ...deps.options }
  const now = deps.now ?? Date.now
  const serverErrors = new Window(o.serverErrorsWindowMs)
  const aiOk = new Window(o.aiWindowMs)
  const aiFailed = new Window(o.aiWindowMs)
  let probe: Promise<boolean> | null = null
  let probed: { at: number; ok: boolean } | null = null

  const probeDb = (): Promise<boolean> => {
    if (probed && now() - probed.at < o.dbCacheMs) return Promise.resolve(probed.ok)
    if (probe) return probe
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), o.dbTimeoutMs)
      timer.unref?.()
    })
    const query = deps.db.query('SELECT 1 AS ok').then(
      () => true,
      () => false,
    )
    const p = Promise.race([query, timeout]).then((ok) => {
      clearTimeout(timer)
      probed = { at: now(), ok }
      return ok
    })
    probe = p
    // a hung query stays the one in flight until it settles (single flight), however often the route is asked
    void query.finally(() => {
      if (probe === p) probe = null
    })
    return p
  }

  return {
    record(method, route, status) {
      if (route === HEALTH_DEEP_ROUTE) return // the monitor's own 503s say nothing new
      const t = now()
      if (status >= 500) serverErrors.add(t)
      if (route !== undefined && AI_PROVIDER_ROUTES.has(`${method} ${route}`)) {
        if (status >= 200 && status < 300) aiOk.add(t)
        else if (status === 502 || status === 504) aiFailed.add(t)
      }
    },
    async reasons() {
      const out: HealthReason[] = []
      if (!(await probeDb())) out.push('db')
      const t = now()
      if (serverErrors.count(t) > o.serverErrorsMax) out.push('5xx')
      const failed = aiFailed.count(t)
      const calls = failed + aiOk.count(t)
      if (calls >= o.aiMinCalls && failed * 2 > calls) out.push('ai')
      return out
    },
  }
}
