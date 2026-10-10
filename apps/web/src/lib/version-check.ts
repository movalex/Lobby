// OWNER: W3 (wave M, M3-5, S2). Open tabs learn about a new build. The one real tab ran wave J for 14 hours after wave K
// and kept its old behaviour (the notification poll was 74% of the api's requests), and stale tabs forced wave L's
// compatibility work. The build emits /version.json `{"commit": …}` (apps/web/vite.config.ts `versionJson`; render.yaml
// serves it with Cache-Control: no-store); this compares its commit with the one the page was built from (__LOBBY_COMMIT__).
//
// When it asks: when the tab becomes visible, when the window gets focus, and every 15 minutes while it is visible.
// Never while it is hidden (a background tab costs nothing), never the api, never twice within a minute, and after
// three failures in a row not again for an hour. A build the page cannot compare ('unknown', a body that is no commit)
// is no news.
//
// When the commit differs it tells the stale-chunk handler (./stale-chunk.ts `newVersion`): on a board the existing "Lobby
// has been updated" notice, whose Reload waits for changes not yet acknowledged; off a board a silent reload while the
// tab is hidden, under the K1-7 reload guard and one for the same build. The page can only ever reload itself outside a
// board, and only for a build it has not already reloaded for.
import { staleChunks } from './stale-chunk.ts'

/** Asked every this long while the tab is visible. */
export const VERSION_CHECK_MS = 15 * 60_000
/** Two asks are never closer than this (visibilitychange and focus arrive together). */
export const VERSION_MIN_GAP_MS = 60_000
/** After this many failures in a row it stops asking for VERSION_BACKOFF_MS. */
export const VERSION_FAIL_LIMIT = 3
export const VERSION_BACKOFF_MS = 60 * 60_000
export const VERSION_URL = '/version.json'

/** What the checker needs of the page (all of it replaceable in a test). */
export interface VersionEnv {
  /** the commit this page was built from (__LOBBY_COMMIT__) */
  readonly commit: string
  /** the served build's commit; rejects on any failure (network, status, a body that is not {commit}) */
  fetchCommit(signal: AbortSignal): Promise<string>
  /** whether the tab is shown now */
  visible(): boolean
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** listens to `visibilitychange` (document) and `focus` (window); returns the removal */
  listen(event: 'visibilitychange' | 'focus', fn: () => void): () => void
}

/** The part of the stale-chunk handler the checker uses. */
export interface VersionSink {
  newVersion(hidden: boolean, served: string): 'notice' | 'reload' | 'reloading' | 'wait'
}

/** A commit as /version.json states it: hexadecimal, 7 to 40 characters. */
const COMMIT = /^[0-9a-f]{7,40}$/i

/** Whether a served commit means this page is behind (a build that cannot be compared is not news). */
export function isNewerBuild(pageCommit: string, served: string): boolean {
  return COMMIT.test(pageCommit) && COMMIT.test(served) && pageCommit.toLowerCase() !== served.toLowerCase()
}

export interface VersionCheck {
  /** Asks now if the tab is visible and the rules allow it; resolves once the answer is handled. */
  check(): Promise<void>
  /** The newer commit that was seen, or null. */
  stale(): string | null
  stop(): void
}

/** Starts the checker; the returned object stops it. */
export function startVersionCheck(env: VersionEnv, sink: VersionSink = staleChunks): VersionCheck {
  let stopped = false
  let failures = 0
  let blockedUntil = 0
  let lastAsk = Number.NEGATIVE_INFINITY
  let inFlight: AbortController | null = null
  let timer: unknown = null
  let stale: string | null = null

  const cancelTimer = () => {
    if (timer !== null) env.clearTimeout(timer)
    timer = null
  }
  /** The next ask, in VERSION_CHECK_MS, only while the tab is visible. */
  const schedule = () => {
    cancelTimer()
    if (stopped || !env.visible()) return
    timer = env.setTimeout(() => {
      timer = null
      void run()
    }, VERSION_CHECK_MS)
  }
  /** An ask (when the rules allow one), then the next one in VERSION_CHECK_MS: a skipped ask keeps the cadence going too. */
  async function run(): Promise<void> {
    await check()
    schedule()
  }

  /** Tells the sink about a newer build; while the tab is hidden it may reload the page. */
  const tell = () => {
    if (stale !== null) sink.newVersion(!env.visible(), stale)
  }

  async function check(): Promise<void> {
    if (stopped || !env.visible() || inFlight) return
    const now = env.now()
    if (now < blockedUntil || now - lastAsk < VERSION_MIN_GAP_MS) return
    lastAsk = now
    const ctl = new AbortController()
    inFlight = ctl
    try {
      const served = await env.fetchCommit(ctl.signal)
      failures = 0
      if (stopped) return
      if (isNewerBuild(env.commit, served)) {
        stale = served
        tell()
      }
    } catch {
      if (stopped || ctl.signal.aborted) return
      failures++
      if (failures >= VERSION_FAIL_LIMIT) {
        blockedUntil = env.now() + VERSION_BACKOFF_MS
        failures = 0
      }
    } finally {
      if (inFlight === ctl) inFlight = null
    }
  }

  const onVisibility = () => {
    if (env.visible()) void run()
    else {
      // hidden: no timer and no new request (one already on its way may still land: it can reload the page unseen);
      // a build already seen may now be reloaded for
      cancelTimer()
      tell()
    }
  }
  const onFocus = () => void run()

  const offs = [env.listen('visibilitychange', onVisibility), env.listen('focus', onFocus)]
  schedule()
  return {
    check: run,
    stale: () => stale,
    stop() {
      stopped = true
      cancelTimer()
      inFlight?.abort()
      for (const off of offs) off()
    },
  }
}

/** The browser's: fetch /version.json (never cached), read {commit}. */
export function browserVersionEnv(commit: string): VersionEnv {
  return {
    commit,
    async fetchCommit(signal) {
      const res = await fetch(VERSION_URL, { signal, cache: 'no-store', credentials: 'omit' })
      if (!res.ok) throw new Error(`version.json: ${res.status}`)
      const body: unknown = await res.json()
      const served =
        typeof body === 'object' && body !== null ? (body as { commit?: unknown }).commit : undefined
      if (typeof served !== 'string') throw new Error('version.json: no commit')
      return served
    },
    visible: () => document.visibilityState === 'visible',
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    listen(event, fn) {
      const target: EventTarget = event === 'focus' ? window : document
      target.addEventListener(event, fn)
      return () => target.removeEventListener(event, fn)
    },
  }
}

declare const __LOBBY_COMMIT__: string | undefined

/**
 * Mounted once, in App.tsx. Production builds only: the dev server has no /version.json (it answers index.html, which is
 * no JSON), and a page without a git commit ('unknown') has nothing to compare. Returns the stop.
 */
export function installVersionCheck(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  if (import.meta.env.DEV) return () => {}
  const commit = typeof __LOBBY_COMMIT__ === 'string' ? __LOBBY_COMMIT__ : 'unknown'
  if (!COMMIT.test(commit)) return () => {}
  return startVersionCheck(browserVersionEnv(commit)).stop
}
