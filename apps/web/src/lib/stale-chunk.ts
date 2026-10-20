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
 *    loads), the failure is the network's, not a deploy's: no Reload, no reload, and never "Lobby has been
 *    updated". Outside a board the connection notice says so; on a board nothing is said (wave P, P-003: the
 *    board's own offline banner already says the changes are kept and will sync, and a chunk that failed in the
 *    background, an export or a level-of-detail render, was nobody's request). A part that failed offline and
 *    fails again once the browser is back online (a browser may keep a failed module import) gets the calm
 *    OFFLINE_RETURN_TEXT, with the Reload button. A lazy page that passes an offline fallback to `recoverChunk`
 *    draws it (the board route's waits for the connection, then reloads once: `reloadWhenOnline`);
 *  - wave P review: those offline words are kept for the file that failed offline (the browser keeps its failed
 *    import), not for the tab's lifetime: another file failing later (a deploy hours later) gets the update words,
 *    and a part that loads clears them (`loaded`). A lazy part a person opens (the board's Share dialog) uses
 *    `lazyRetrying`: React.lazy keeps a failed import for the tab's lifetime, so a Share clicked offline did nothing
 *    for the rest of the tab and its code was never asked for again; now the next open asks for it again;
 *  - P-003 (wave P): a board notice never interrupts typing: while a text editor is open on the board
 *    (`StaleChunkBoard.editing`) it waits, and shows once the editor has closed.
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
import { type ComponentType, createElement, lazy, useEffect, useState } from 'react'
import { countUsage } from './usage.ts'

/** A failed dynamic import or chunk preload, as Chrome, Firefox, Safari and Vite word it. */
export function isStaleChunkError(e: unknown): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(
    chunkKey(e),
  )
}

/** A failed chunk's words (Chrome and Firefox name its file; Safari does not), '' for none. */
export function chunkKey(e: unknown): string {
  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : ((e as { message?: unknown })?.message ?? '')
  return typeof message === 'string' ? message : ''
}
/** Whether a chunk's words (`chunkKey`) name its file. */
const namesFile = (key: string) => /\.(m?js|css)\b/i.test(key)

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
/** P-003: a part of Lobby that failed to load offline, failing again once the browser is back online. */
export const OFFLINE_RETURN_TEXT =
  'Part of Lobby did not finish loading while you were offline. Reload when you are ready to use it again.'
/** How often a board notice held back while someone types looks again (P-003). */
export const EDITING_RECHECK_MS = 500

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
  /** P-003: a text editor is open on the board (a notice waits until it closes). Default: never. */
  editing?(): boolean
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
  /**
   * P-003: the chunks that failed offline on a board (nothing was said then), by their error's words (`chunkKey`).
   * Wave P review: no longer one flag for the tab's lifetime. The same file failing again once back online is the
   * browser keeping its failed import (Chromium does): the offline words, again if asked again. Another file is a
   * deploy's. A failure that names no file (Safari's words) gets the offline words once. A part that loads clears all.
   */
  const failedOffline = new Set<string>()
  /** the failure last given the offline words: Vite reports one failure twice (its event, then the import) */
  let offlineWordsFor: unknown = null
  /** P-003: the board notice waiting for an open text editor to close (the latest one) */
  let held: { board: StaleChunkBoard; notice: StaleNotice } | null = null
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

  const staleNotice = (text: string = STALE_NOTICE_TEXT): StaleNotice => ({
    key: STALE_NOTICE_KEY,
    text,
    testId: 'stale-chunk-notice',
    timeoutMs: null,
    action: { label: 'Reload', testId: 'stale-chunk-reload', onClick: reloadWhenSent },
  })

  /** P-003: a board notice, once no text editor is open on that board (looked at again every EDITING_RECHECK_MS). */
  const notifyBoard = (b: StaleChunkBoard, n: StaleNotice) => {
    const waiting = held !== null
    held = { board: b, notice: n }
    if (waiting) return
    const tryNow = () => {
      const h = held
      if (!h) return
      if (board !== h.board) {
        held = null
        return
      }
      if (h.board.editing?.() === true) {
        env.setTimeout(tryNow, EDITING_RECHECK_MS)
        return
      }
      held = null
      h.board.notify(h.notice)
    }
    tryNow()
  }

  return {
    /** A chunk could not be loaded (see the header for what happens). Returns what was done. */
    report(error?: unknown): 'notice' | 'reload' | 'reloading' | 'quiet' {
      if (reloading) return 'reloading'
      const key = chunkKey(error)
      // offline (on a board or not): the network's failure; a reload would show the browser's offline page. On a
      // board nothing is said (P-003): its offline banner says the changes are kept and will sync
      if (!env.online()) {
        if (board) {
          failedOffline.add(key)
          return 'quiet'
        }
        notice = offlineNotice()
        emit()
        return 'notice'
      }
      if (board) {
        const offlineBefore =
          failedOffline.has(key) || (typeof error === 'object' && error !== null && error === offlineWordsFor)
        if (offlineBefore) {
          offlineWordsFor = error
          // words that name no file: said once (a later failure, a deploy hours later, is a deploy's)
          if (!namesFile(key)) failedOffline.delete(key)
        }
        count('stalechunk.notice')
        notifyBoard(board, staleNotice(offlineBefore ? OFFLINE_RETURN_TEXT : STALE_NOTICE_TEXT))
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
        notifyBoard(board, staleNotice())
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
          notifyBoard(b, staleNotice())
        }, 0)
      return () => {
        if (board === b) board = null
        if (held?.board === b) held = null
      }
    },
    /** A lazy part loaded (`recoverChunk`, `lazyRetrying`): an earlier offline failure is over. */
    loaded() {
      failedOffline.clear()
      offlineWordsFor = null
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
  handler: RecoverHandler = staleChunks,
  offline?: T,
): () => Promise<T> {
  return () =>
    load().then(
      (m) => {
        handler.loaded?.()
        return m
      },
      (e: unknown) => {
        if (!isStaleChunkError(e)) throw e
        handler.report(e)
        return offline !== undefined && handler.online?.() === false ? offline : fallback
      },
    )
}

/** What `recoverChunk` and `retryingImport` tell (the page's handler by default). */
type RecoverHandler = Pick<StaleChunkHandler, 'report'> &
  Partial<Pick<StaleChunkHandler, 'online' | 'loaded'>>

/** One try at a lazy part's import (`retryingImport`). */
export interface ImportAttempt<T> {
  /** the import, started on the first call (a stale chunk resolves to the fallback, reported) */
  result(): Promise<T>
  /** it failed with a stale chunk (the fallback was its result) */
  readonly failed: boolean
}

/**
 * Wave P review: the import behind `lazyRetrying`. One attempt at a time; a failed one (reported, resolved to
 * `fallback`) is kept until its fallback has been drawn (`shown`: the same mount drawing again after its suspense
 * imports nothing again), and the attempt after that imports again. A loaded attempt is kept. Other errors throw.
 */
export function retryingImport<T>(
  load: () => Promise<T>,
  fallback: T,
  handler: RecoverHandler = staleChunks,
) {
  let current: ImportAttempt<T> | null = null
  const start = (): ImportAttempt<T> => {
    let promise: Promise<T> | null = null
    let failed = false
    return {
      get failed() {
        return failed
      },
      result: () => {
        promise ??= load().then(
          (m) => {
            handler.loaded?.()
            return m
          },
          (e: unknown) => {
            if (!isStaleChunkError(e)) throw e
            failed = true
            handler.report(e)
            return fallback
          },
        )
        return promise
      },
    }
  }
  return {
    /** the attempt to draw now */
    attempt(): ImportAttempt<T> {
      current ??= start()
      return current
    },
    /** `a` has been drawn: if it failed, the next attempt imports again */
    shown(a: ImportAttempt<T>) {
      if (a.failed && current === a) current = null
    },
  }
}

/**
 * Wave P review: a lazy component whose import is tried again. React.lazy keeps what its import resolved to for the
 * page's lifetime, so a part that failed to load offline stayed its fallback for the rest of the tab. Here each mount
 * keeps one attempt (`retryingImport`); a failed one draws `Fallback` with the same props (the Share dialog's closes
 * itself), and the next mount (the next open) imports again. Drawn inside a Suspense.
 */
export function lazyRetrying<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P>,
  handler: RecoverHandler = staleChunks,
): ComponentType<P> {
  type Loaded = { default: ComponentType<P> }
  const imports = retryingImport<Loaded>(load, { default: Fallback }, handler)
  const lazies = new WeakMap<ImportAttempt<Loaded>, ComponentType<P>>()
  const lazyOf = (a: ImportAttempt<Loaded>): ComponentType<P> => {
    let c = lazies.get(a)
    if (!c) {
      c = lazy(a.result) as unknown as ComponentType<P>
      lazies.set(a, c)
    }
    return c
  }
  return function Retrying(props: P) {
    // a mount that suspends keeps no state: the initializer runs again and gets the same attempt until it was shown
    const [a] = useState(() => imports.attempt())
    useEffect(() => imports.shown(a), [a])
    return createElement(lazyOf(a), props)
  }
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
 * fix/firefox: lazy parts that say themselves what happens when their chunk is gone. The dashboard's dialogs (Share,
 * the command palette, the Miro import) sit in a LazyDialogBoundary: "… could not open", Reload, and the dashboard
 * stays (K4). Vite's preloadError reached the handler too, which outside a board reloads the page: the person who
 * chose Share saw the dashboard reload instead. Chromium hid it while a speculative board-code prefetch was under way
 * (its `ignore` takes every failure in that time), so whether a stale Share reloaded or said so depended on timing;
 * Firefox, whose prefetch was done by then, reloaded every time (the NAS cross-browser run).
 */
export interface ChunkOwners {
  /** an owned import is under way */
  pending(): boolean
  /** this failure was an owned import's: its own part handles it */
  claimed(error: unknown): boolean
}

let ownedPending = 0
const claimedFailures = new WeakSet<object>()
export const chunkOwners: ChunkOwners = {
  pending: () => ownedPending > 0,
  claimed: (e) => typeof e === 'object' && e !== null && claimedFailures.has(e),
}

/**
 * An import whose failure its caller handles (see ChunkOwners): it rejects as before, and the page's handler leaves
 * that failure alone. Vite dispatches its preloadError before the import's promise rejects with the same error, so the
 * handler waits one task while an owned import is under way (`installStaleChunkRecovery`).
 */
export function ownedImport<T>(load: () => Promise<T>): () => Promise<T> {
  return () => {
    ownedPending++
    let p: Promise<T>
    try {
      p = load()
    } catch (e) {
      ownedPending--
      throw e
    }
    return p.then(
      (m) => {
        ownedPending--
        return m
      },
      (e: unknown) => {
        ownedPending--
        if (typeof e === 'object' && e !== null) claimedFailures.add(e)
        throw e
      },
    )
  }
}

/**
 * Listens once per page (App.tsx): Vite's `vite:preloadError` (unless `ignore` says it is nobody's: a
 * speculative prefetch, or an owned import claims it: `ownedImport`), and a stale chunk error that nobody caught.
 * The event is not cancelled: the import still rejects, so the code that asked for the chunk handles it as
 * a failure (an export says it failed) rather than going on with nothing. Returns the uninstall.
 */
export function installStaleChunkRecovery(
  win: ChunkWindow | undefined = globalThis as unknown as ChunkWindow,
  handler: Pick<StaleChunkHandler, 'report'> = staleChunks,
  /** a failure that is nobody's to report (a speculative prefetch: lib/prefetch-board.ts) */
  ignore: (error: unknown) => boolean = () => false,
  owners: ChunkOwners = chunkOwners,
  /** runs `fn` one task later (an owned import's rejection, a microtask after the event, has claimed it by then) */
  later: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0)
  },
): () => void {
  if (!win || typeof win.addEventListener !== 'function') return () => {}
  const onPreload = (e: Event) => {
    const payload = (e as Event & { payload?: unknown }).payload
    if (ignore(payload)) return
    if (!owners.pending()) {
      handler.report(payload)
      return
    }
    later(() => {
      if (!owners.claimed(payload)) handler.report(payload)
    })
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
