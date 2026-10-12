/**
 * K1-7 (wave K): a tab that loaded before a deploy asks for a lazy chunk the new deploy no longer has
 * (Render serves only the new build's hashed files, and colleagues keep tabs open for hours). Before this,
 * nothing handled it: the import failed, and whatever needed the chunk (a panel, an export, the board page
 * itself) broke. Now:
 *
 *  - outside a board (the dashboard, sign-in, the feedback page, opening a board whose code is missing), the
 *    page reloads once, which loads the new build. A guard in sessionStorage (RELOAD_GUARD_MS) stops a
 *    reload loop: a second failure soon after a reload shows a notice with a Reload button instead. Storage
 *    that is blocked or throws counts as a guard that cannot be read: the notice, never a loop;
 *  - on a board, the page never reloads by itself (it would drop the open panel, the camera, a text being
 *    typed and, for a guest, changes not yet sent): the board shows a notice with a Reload button
 *    (`registerStaleChunkBoard`). While the sync adapter reports changes not yet acknowledged, the button
 *    waits (at most UNSENT_WAIT_MS) for them before it reloads. A browser that is offline (wave K round 1
 *    refix) gets a connection notice instead, with no Reload: a reload then would land on the browser's
 *    offline page, with changes the sync server cannot acknowledge yet;
 *  - offline, on a board or not (round 2 refix: the board route itself is "not on a board" while its code
 *    loads), the failure is the network's, not a deploy's: the connection notice, no Reload, no reload, and
 *    never "Lobby has been updated". A lazy page that passes an offline fallback to `recoverChunk` draws it
 *    (the board route's waits for the connection, then reloads once: `reloadWhenOnline`).
 *
 * Wave M (M3-5, S2): a tab also learns about a new build without failing to load a chunk first (lib/version-check.ts
 * asks /version.json while the tab is visible). `newVersion` is its entry: on a board the same notice (the Reload button
 * waits for unsent changes as above); outside a board a silent reload while the tab is hidden, under the same guard
 * as a stale chunk's and one more that stops a reload for a build the page already reloaded for (a cache that keeps
 * serving the old page would otherwise reload it every minute); when a guard says no, the notice with its button. A
 * board opened after the new version was seen shows the notice when it registers. Wave N1 (wave M follow-up 3): not while
 * the page holds words typed into a dialog's field or a form's (`domHasTypedWork`; a form's since the
 * wave N.1 review: the sidebar's New project name): the person left the tab with something half written, and a
 * silent reload would lose it; they get the notice with its button when they come back. Counted (lib/usage.ts, the
 * contract's fixed events): `stalechunk.notice` (a chunk failed), `version.notice` (a newer build was seen), and
 * `stalechunk.reload` for every reload this handler makes or the Reload button makes, whatever the cause.
 *
 * Sources: Vite's `vite:preloadError` event (its preload helper dispatches it for a failed CSS preload and a
 * failed dynamic import), a stale chunk error that reaches `unhandledrejection`, and lazy components that
 * wrap their import in `recoverChunk` (React would otherwise unmount the page on the failed import).
 */

import type { UsageEvent } from '@draftroom/contracts'
import { countUsage } from './usage.ts'

/** A failed dynamic import or chunk preload, as Chrome, Firefox, Safari and Vite word it. */
export function isStaleChunkError(e: unknown): boolean {
  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : ((e as { message?: unknown })?.message ?? '')
  if (typeof message !== 'string') return false
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(
    message,
  )
}

/** A reload within this long of the last automatic one is not made again (a loop guard). */
export const RELOAD_GUARD_MS = 60_000
/** Longest the board's Reload button waits for changes not yet acknowledged. */
export const UNSENT_WAIT_MS = 5_000
export const RELOAD_KEY = 'lobby:stale-chunk-reload'
/** M3-5: the build a version-driven reload was made for, and when (sessionStorage): the same build is not reloaded for twice in a row. */
export const VERSION_RELOAD_KEY = 'lobby:version-reload'
export const VERSION_RELOAD_GUARD_MS = 30 * 60_000
export const STALE_NOTICE_KEY = 'stale-chunk'
export const STALE_NOTICE_TEXT = 'Lobby has been updated. Reload to keep working with the new version.'
export const OFFLINE_CHUNK_TEXT =
  'This part of Lobby could not load while you are offline. Reload the page once you are back online to use it.'

export interface StaleNotice {
  key: string
  text: string
  tone?: 'info' | 'error'
  testId?: string
  timeoutMs?: number | null
  action?: { label: string; onClick(): void; testId?: string }
}

/** What a mounted board tells the handler (LobbyBoardPage registers it while a session is open). */
export interface StaleChunkBoard {
  /** changes this tab made that the sync server has not acknowledged yet (or uploads on their way) */
  unsent(): boolean
  notify(n: StaleNotice): void
}

interface Env {
  /** counts a usage event (lib/usage.ts by default) */
  count?(event: UsageEvent): void
  reload(): void
  now(): number
  /** `navigator.onLine`: a chunk that failed while offline is the network's failure, not a deploy's */
  online(): boolean
  /** sessionStorage, or null where it cannot be used */
  storage(): Pick<Storage, 'getItem' | 'setItem'> | null
  /** the page holds words typed into a field that a reload would lose (default: `domHasTypedWork` of the document) */
  typedWork?(): boolean
  setTimeout(fn: () => void, ms: number): unknown
}

/** What a field looks like to the scan below (an input or a textarea). */
interface FieldLike {
  readonly type?: string | null
  readonly value?: unknown
  closest?(selector: string): unknown
}

/** An open dialog: any field in it with words is typed work (a reload closes the dialog and loses them). */
const TYPED_WORK_DIALOG = 'dialog[open], [role="dialog"], [aria-modal="true"]'
/** A search landmark: a query typed into it is no typed work outside a dialog (see below). */
const SEARCH_LANDMARK = '[role="search"], search'
/** Inputs that hold no words (their value is a state or a choice, not text a person wrote). */
const NO_WORDS = new Set([
  'checkbox',
  'radio',
  'file',
  'hidden',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'image',
])

/**
 * Whether the page holds words a reload would lose: a text field, search field or textarea with something in
 * it, in an open dialog (New board's title, a rename, an invitation's address, the feedback dialog), or a text
 * field or textarea in a form (the sidebar's New project name, the feedback page). Not a search box outside a
 * dialog (the dashboard's search; a search field, or a form that is a search landmark): a query is typed again in
 * a moment, and a box left with one must not keep an old build open for hours. A pre-filled field counts too:
 * asking the person is cheap, losing a message is not. Never throws.
 */
export function domHasTypedWork(
  doc: { querySelectorAll(selector: string): ArrayLike<unknown> } | undefined = globalThis.document,
): boolean {
  try {
    if (!doc) return false
    for (const el of Array.from(doc.querySelectorAll('input, textarea')) as FieldLike[]) {
      const type = String(el.type ?? '').toLowerCase()
      if (NO_WORDS.has(type) || typeof el.value !== 'string' || el.value.trim() === '') continue
      if (el.closest?.(TYPED_WORK_DIALOG)) return true
      if (type === 'search' || el.closest?.(SEARCH_LANDMARK)) continue
      if (el.closest?.('form')) return true
    }
  } catch {
    // a page that cannot be read holds nothing we know of
  }
  return false
}

const defaultEnv: Env = {
  reload: () => globalThis.location?.reload(),
  now: () => Date.now(),
  online: () => (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false,
  storage: () => {
    try {
      return globalThis.sessionStorage ?? null
    } catch {
      return null
    }
  },
  typedWork: () => domHasTypedWork(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
}

type Listener = () => void

/** The handler's state: one per page (`staleChunks`), or one per test. */
export function createStaleChunkHandler(env: Env = defaultEnv) {
  let board: StaleChunkBoard | null = null
  /** a notice outside a board (App.tsx draws it), or null */
  let notice: StaleNotice | null = null
  let reloading = false
  /** M3-5: a newer build was seen (lib/version-check.ts); a board opened later shows the notice at once */
  let versionStale = false
  let versionNoticed = false
  const count = (event: UsageEvent) => (env.count ?? countUsage)(event)
  const listeners = new Set<Listener>()
  const emit = () => {
    for (const l of listeners) l()
  }

  const readGuard = (): number | null | 'blocked' => {
    try {
      const s = env.storage()
      if (!s) return 'blocked'
      const v = Number(s.getItem(RELOAD_KEY))
      return Number.isFinite(v) && v > 0 ? v : null
    } catch {
      return 'blocked'
    }
  }
  const writeGuard = (): boolean => {
    try {
      const s = env.storage()
      if (!s) return false
      s.setItem(RELOAD_KEY, String(env.now()))
      return true
    } catch {
      return false
    }
  }

  /** The person asked for it (the notice's button): after the board's unsent changes, bounded. */
  const reloadWhenSent = () => {
    if (reloading) return
    reloading = true
    const started = env.now()
    const tryNow = () => {
      if (board?.unsent() && env.now() - started < UNSENT_WAIT_MS) {
        env.setTimeout(tryNow, 100)
        return
      }
      count('stalechunk.reload')
      env.reload()
    }
    tryNow()
  }

  /** The version the page last reloaded for, with when: `served@time` (null: none, or storage cannot be read). */
  const readVersionReload = (): { served: string; at: number } | null => {
    try {
      const raw = env.storage()?.getItem(VERSION_RELOAD_KEY)
      const m = raw ? /^([0-9a-f]{7,40})@(\d+)$/i.exec(raw) : null
      return m ? { served: m[1] as string, at: Number(m[2]) } : null
    } catch {
      return null
    }
  }
  const writeVersionReload = (served: string): boolean => {
    try {
      const s = env.storage()
      if (!s) return false
      s.setItem(VERSION_RELOAD_KEY, `${served}@${env.now()}`)
      return true
    } catch {
      return false
    }
  }
  /** The version notice is counted once per page, however often the check sees the same newer build. */
  const countVersionNotice = () => {
    if (versionNoticed) return
    versionNoticed = true
    count('version.notice')
  }

  const offlineNotice = (): StaleNotice => ({
    key: STALE_NOTICE_KEY,
    text: OFFLINE_CHUNK_TEXT,
    testId: 'stale-chunk-offline-notice',
    timeoutMs: null,
  })

  const staleNotice = (): StaleNotice => ({
    key: STALE_NOTICE_KEY,
    text: STALE_NOTICE_TEXT,
    testId: 'stale-chunk-notice',
    timeoutMs: null,
    action: { label: 'Reload', testId: 'stale-chunk-reload', onClick: reloadWhenSent },
  })

  return {
    /** A chunk could not be loaded (see the header for what happens). Returns what was done. */
    report(_error?: unknown): 'notice' | 'reload' | 'reloading' {
      if (reloading) return 'reloading'
      // offline (on a board or not): the network's failure; a reload would show the browser's offline page
      if (!env.online()) {
        if (board) board.notify(offlineNotice())
        else {
          notice = offlineNotice()
          emit()
        }
        return 'notice'
      }
      if (board) {
        count('stalechunk.notice')
        board.notify(staleNotice())
        return 'notice'
      }
      const last = readGuard()
      const recent = last === 'blocked' || (last !== null && env.now() - last < RELOAD_GUARD_MS)
      if (!recent && writeGuard()) {
        reloading = true
        count('stalechunk.reload')
        env.reload()
        return 'reload'
      }
      count('stalechunk.notice')
      notice = staleNotice()
      emit()
      return 'notice'
    },
    /**
     * M3-5: a newer build than this page's is live (`served`: its commit, from /version.json). On a board: the notice
     * (nothing reloads by itself). Outside one: 'wait' while the tab is visible (a reload would drop what the person is
     * doing), and once it is hidden a reload nobody sees, unless a guard says no (a reload within RELOAD_GUARD_MS, or one
     * already made for this build within VERSION_RELOAD_GUARD_MS, or storage that cannot be read): then the notice, with
     * its button, for when they come back. Safe to call again for the same build.
     */
    newVersion(hidden: boolean, served: string): 'notice' | 'reload' | 'reloading' | 'wait' {
      if (reloading) return 'reloading'
      versionStale = true
      if (board) {
        countVersionNotice()
        board.notify(staleNotice())
        return 'notice'
      }
      if (!hidden) return 'wait'
      const last = readGuard()
      const recent = last === 'blocked' || (last !== null && env.now() - last < RELOAD_GUARD_MS)
      const again = readVersionReload()
      const reloadedFor =
        again !== null && again.served === served && env.now() - again.at < VERSION_RELOAD_GUARD_MS
      // N1: words typed into a dialog or a form: the notice, not a reload that would lose them
      const typing = env.typedWork?.() === true
      if (!recent && !reloadedFor && !typing && writeGuard() && writeVersionReload(served)) {
        reloading = true
        count('stalechunk.reload')
        env.reload()
        return 'reload'
      }
      countVersionNotice()
      notice = staleNotice()
      emit()
      return 'notice'
    },
    /** A board is open (its notices, its unsent changes); returns the unregister. */
    registerBoard(b: StaleChunkBoard): () => void {
      board = b
      // a newer build was seen before this board opened: say so once its page can draw the notice
      if (versionStale)
        env.setTimeout(() => {
          if (board !== b) return
          countVersionNotice()
          b.notify(staleNotice())
        }, 0)
      return () => {
        if (board === b) board = null
      }
    },
    /** Whether the browser says it is online (`recoverChunk` picks its offline fallback by it). */
    online: () => env.online(),
    /** The notice to draw outside a board (null: none). */
    notice: () => notice,
    dismiss() {
      notice = null
      emit()
    },
    subscribe(l: Listener): () => void {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export type StaleChunkHandler = ReturnType<typeof createStaleChunkHandler>

/** The page's handler. */
export const staleChunks: StaleChunkHandler = createStaleChunkHandler()

/** LobbyBoardPage, while a board session is open. */
export const registerStaleChunkBoard = (b: StaleChunkBoard) => staleChunks.registerBoard(b)

/**
 * Wraps a lazy component's import: a stale chunk is reported (above) and resolves to `fallback` (what to
 * draw meanwhile) instead of throwing into React, which would unmount the page. Other errors are thrown.
 * With `offline` (round 2 refix), a failure while the browser is offline resolves to that instead: the
 * network's failure, not a deploy's.
 */
export function recoverChunk<T>(
  load: () => Promise<T>,
  fallback: T,
  handler: Pick<StaleChunkHandler, 'report'> & Partial<Pick<StaleChunkHandler, 'online'>> = staleChunks,
  offline?: T,
): () => Promise<T> {
  return () =>
    load().catch((e: unknown) => {
      if (!isStaleChunkError(e)) throw e
      handler.report(e)
      return offline !== undefined && handler.online?.() === false ? offline : fallback
    })
}

/**
 * Round 2 refix: the board route's offline fallback (its code could not load while offline, so no board
 * opened and a reload loses nothing). Once the browser is back online, the page reloads once, which opens
 * the board (React.lazy would otherwise keep the fallback for the tab's lifetime). Already online: at once.
 * Returns the cancel (the fallback unmounted).
 */
export function reloadWhenOnline(
  win: ChunkWindow = globalThis as unknown as ChunkWindow,
  online: () => boolean = defaultEnv.online,
  reload: () => void = defaultEnv.reload,
): () => void {
  if (online()) {
    reload()
    return () => {}
  }
  const onOnline = () => {
    win.removeEventListener('online', onOnline)
    reload()
  }
  win.addEventListener('online', onOnline)
  return () => win.removeEventListener('online', onOnline)
}

interface ChunkWindow {
  addEventListener(type: string, fn: (e: Event) => void): void
  removeEventListener(type: string, fn: (e: Event) => void): void
}

/**
 * Listens once per page (App.tsx): Vite's `vite:preloadError` (unless `ignore` says it is nobody's: a
 * speculative prefetch), and a stale chunk error that nobody caught.
 * The event is not cancelled: the import still rejects, so the code that asked for the chunk handles it as
 * a failure (an export says it failed) rather than going on with nothing. Returns the uninstall.
 */
export function installStaleChunkRecovery(
  win: ChunkWindow | undefined = globalThis as unknown as ChunkWindow,
  handler: Pick<StaleChunkHandler, 'report'> = staleChunks,
  /** a failure that is nobody's to report (a speculative prefetch: lib/prefetch-board.ts) */
  ignore: (error: unknown) => boolean = () => false,
): () => void {
  if (!win || typeof win.addEventListener !== 'function') return () => {}
  const onPreload = (e: Event) => {
    const payload = (e as Event & { payload?: unknown }).payload
    if (!ignore(payload)) handler.report(payload)
  }
  const onRejection = (e: Event) => {
    const reason = (e as Event & { reason?: unknown }).reason
    if (!isStaleChunkError(reason)) return
    // reported, and not left as an uncaught error in the console
    e.preventDefault()
    handler.report(reason)
  }
  win.addEventListener('vite:preloadError', onPreload)
  win.addEventListener('unhandledrejection', onRejection)
  return () => {
    win.removeEventListener('vite:preloadError', onPreload)
    win.removeEventListener('unhandledrejection', onRejection)
  }
}
