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
 *    waits (at most UNSENT_WAIT_MS) for them before it reloads.
 *
 * Sources: Vite's `vite:preloadError` event (its preload helper dispatches it for a failed CSS preload and a
 * failed dynamic import), a stale chunk error that reaches `unhandledrejection`, and lazy components that
 * wrap their import in `recoverChunk` (React would otherwise unmount the page on the failed import).
 */

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
export const STALE_NOTICE_KEY = 'stale-chunk'
export const STALE_NOTICE_TEXT = 'Lobby has been updated. Reload to keep working with the new version.'

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
  reload(): void
  now(): number
  /** sessionStorage, or null where it cannot be used */
  storage(): Pick<Storage, 'getItem' | 'setItem'> | null
  setTimeout(fn: () => void, ms: number): unknown
}

const defaultEnv: Env = {
  reload: () => globalThis.location?.reload(),
  now: () => Date.now(),
  storage: () => {
    try {
      return globalThis.sessionStorage ?? null
    } catch {
      return null
    }
  },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
}

type Listener = () => void

/** The handler's state: one per page (`staleChunks`), or one per test. */
export function createStaleChunkHandler(env: Env = defaultEnv) {
  let board: StaleChunkBoard | null = null
  /** a notice outside a board (App.tsx draws it), or null */
  let notice: StaleNotice | null = null
  let reloading = false
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
      env.reload()
    }
    tryNow()
  }

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
      if (board) {
        board.notify(staleNotice())
        return 'notice'
      }
      const last = readGuard()
      const recent = last === 'blocked' || (last !== null && env.now() - last < RELOAD_GUARD_MS)
      if (!recent && writeGuard()) {
        reloading = true
        env.reload()
        return 'reload'
      }
      notice = staleNotice()
      emit()
      return 'notice'
    },
    /** A board is open (its notices, its unsent changes); returns the unregister. */
    registerBoard(b: StaleChunkBoard): () => void {
      board = b
      return () => {
        if (board === b) board = null
      }
    },
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
 */
export function recoverChunk<T>(
  load: () => Promise<T>,
  fallback: T,
  handler: Pick<StaleChunkHandler, 'report'> = staleChunks,
): () => Promise<T> {
  return () =>
    load().catch((e: unknown) => {
      if (!isStaleChunkError(e)) throw e
      handler.report(e)
      return fallback
    })
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
