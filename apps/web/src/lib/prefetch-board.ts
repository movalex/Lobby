/**
 * K1 (wave K): open a board fast. The board page's code and its first data are asked for as early as the
 * page can know it will need them, instead of one after the other.
 *
 * Measured before (docs/PROGRESS.md wave K, the speed scout at CPU 4x and Fast 4G): the board code
 * started only after GET /api/auth/me answered (about 1.1 s), then went through two lazy steps (route.js,
 * then LobbyBoardPage.js); the ticket waited for GET /api/boards/:id (one more round trip, 200-280 ms on
 * staging); and the first board opened from the dashboard waited for about 1 MB of engine code (3.7 s
 * against 2.5 s cached at 4G).
 *
 *  - K1-1 `loadBoardCode()`: the board page's code (LobbyBoardPage and, with it, the engine chunk), one
 *    download for the whole tab. `startBoardCodeFor(location.pathname)` runs when App.tsx is evaluated, so
 *    a board link opened cold downloads the code alongside the sign-in check. Not speculative: it is not
 *    skipped on Save-Data (the person is opening a board).
 *  - K1-3 `prefetchBoardCode()`: the same download, speculative: skipped when the browser asks to save
 *    data (`navigator.connection.saveData`), idempotent. `installBoardPrefetch()` (App.tsx, once) starts it
 *    when the pointer or the keyboard reaches a link to a board (/b/<id>, document-level delegation, so no
 *    dashboard component has to call it), and `prefetchBoardCodeWhenIdle()` (App.tsx, while a dashboard is
 *    shown) when the page has nothing else to do.
 *  - K1-2 `preloadBoardOpen(boardId)` / `takeBoardDetail` / `takeBoardTicket`: GET /api/boards/:id and the
 *    first POST /api/boards/:id/ticket together, as soon as the board route renders with a session (before
 *    the board code has arrived). The board page takes each answer once; a retry asks again.
 *  - K1-5 `boardTitleHint(boardId)`: the title (and workspace) of a board whose link was pointed at,
 *    focused or clicked, for the board skeleton's top bar before the board answers. In memory only.
 */
import type { BoardDetail, TicketResponse } from '@draftroom/contracts'
import { api } from '../api/client.ts'
import { matchRoute, safeReturnTo } from './routing.ts'

// ---- the board code (K1-1, K1-3) -----------------------------------------------------------------------

export interface BoardCode<T> {
  /** Downloads (once) and resolves the module. A failed download may be tried again. */
  load(): Promise<T>
  /** The same, unless the browser asks to save data. True when a download was started or is under way. */
  prefetch(): boolean
  /** Whether a download was started (and has not failed). */
  readonly started: boolean
  /**
   * Whether the download under way was started by a prefetch and nothing has asked for the module yet: its
   * failure is nobody's to report (lib/stale-chunk.ts ignores Vite's preloadError for it). A real load
   * meanwhile makes it its own.
   */
  readonly speculative: boolean
}

interface BoardCodeEnv {
  /** `navigator.connection.saveData` (Save-Data, Lite mode, data saver) */
  saveData(): boolean
}

const saveData = () => {
  try {
    const c = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)?.connection
    return c?.saveData === true
  } catch {
    return false
  }
}

export function createBoardCode<T>(loader: () => Promise<T>, env: BoardCodeEnv = { saveData }): BoardCode<T> {
  let pending: Promise<T> | null = null
  let speculative = false
  const start = () => {
    if (!pending) {
      const p = loader()
      pending = p
      // a download that failed (a deploy removed the file, the network) may be asked for again
      p.then(
        () => {
          speculative = false
        },
        () => {
          speculative = false
          if (pending === p) pending = null
        },
      )
    }
    return pending
  }
  return {
    load() {
      speculative = false
      return start()
    },
    prefetch() {
      if (pending) return true
      if (env.saveData()) return false
      speculative = true
      start().catch(() => {}) // a prefetch never reports: the real load does (lib/stale-chunk.ts)
      return true
    },
    get started() {
      return pending !== null
    },
    get speculative() {
      return speculative
    },
  }
}

/** The board page module (its default export is the page). */
export const importBoardPage = () => import('../canvas/board/LobbyBoardPage.tsx')
export type BoardPageModule = Awaited<ReturnType<typeof importBoardPage>>

const boardCode = createBoardCode(importBoardPage)

/** K1-1: the board page's code, downloaded once per tab (not speculative). */
export const loadBoardCode = (): Promise<BoardPageModule> => boardCode.load()

/** K1-3: downloads the board page's code ahead of a click (idempotent; skipped on Save-Data). */
export const prefetchBoardCode = (): boolean => boardCode.prefetch()

/**
 * K1-7: whether a failed chunk load is the board code's speculative prefetch (nobody asked for the module
 * yet): App.tsx tells lib/stale-chunk.ts to ignore it, so a hover or an idle moment never reloads the page;
 * the real load reports its own failure.
 */
export const isBoardCodePrefetch = (): boolean => boardCode.speculative

/**
 * K1-1: called once while App.tsx is evaluated, with `location.pathname`: on a board's address the board
 * code starts downloading now, alongside the sign-in check. Any other address downloads nothing.
 */
export function startBoardCodeFor(pathname: string, load: () => Promise<unknown> = loadBoardCode): boolean {
  if (matchRoute(pathname).name !== 'board') return false
  load().catch(() => {}) // the board route's own load reports a failure
  return true
}

// ---- prefetch on intent and when idle (K1-3) ------------------------------------------------------------

/** Whether the sign-in page (its `location.search`) will go on to a board once the person is signed in. */
export function returnsToBoard(search: string): boolean {
  const to = safeReturnTo(new URLSearchParams(search).get('returnTo'))
  return to !== null && matchRoute(new URL(to, 'http://lobby.invalid').pathname).name === 'board'
}

/** The board a link (or something inside one) points to, or null. */
export function boardOfLink(target: EventTarget | null, origin = globalThis.location?.origin): string | null {
  const el = target as { closest?: (sel: string) => Element | null } | null
  const a = el && typeof el.closest === 'function' ? el.closest('a[href]') : null
  const href = a?.getAttribute('href')
  if (!href || !origin) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const route = matchRoute(url.pathname)
  return route.name === 'board' ? route.boardId : null
}

/**
 * The board's title next to its link, for the skeleton: the link's `data-board-title`, or the title of
 * the board card around it (`[data-board-id]` with a `[data-board-title]` or `[data-testid=board-card-title]`
 * element: its `title` attribute, else its text).
 */
function titleNear(target: EventTarget | null, boardId: string): string | null {
  const el = target as { closest?: (sel: string) => Element | null } | null
  if (!el || typeof el.closest !== 'function') return null
  const a = el.closest('a[href]')
  const own = a?.getAttribute('data-board-title')
  if (own) return own
  const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
  const card = el.closest(`[data-board-id="${esc ? esc(boardId) : boardId}"]`)
  const t = card?.querySelector('[data-board-title], [data-testid="board-card-title"]')
  const title = t?.getAttribute('data-board-title') || t?.getAttribute('title') || t?.textContent
  return title?.trim() ? title.trim() : null
}

/**
 * K1-3 (and K1-5): document-level delegation, installed once. A pointer over, a focus on or a press of a
 * link to a board downloads the board code (`prefetchBoardCode`) and remembers the board's title for its
 * skeleton. Returns the uninstall.
 */
export function installBoardPrefetch(
  doc: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
  prefetch: () => boolean = prefetchBoardCode,
): () => void {
  const onIntent = (e: Event) => {
    const boardId = boardOfLink(e.target)
    if (!boardId) return
    const title = titleNear(e.target, boardId)
    if (title) rememberBoardTitle(boardId, title, workspaceOfPage())
    prefetch()
  }
  const opts = { capture: true, passive: true } as const
  const types = ['pointerover', 'focusin', 'pointerdown', 'click'] as const
  for (const t of types) doc.addEventListener(t, onIntent, opts)
  return () => {
    for (const t of types) doc.removeEventListener(t, onIntent, opts)
  }
}

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (id: never) => void
}

/** How long after the dashboard shows an idle prefetch waits at most (a busy page still gets it). */
export const IDLE_PREFETCH_TIMEOUT_MS = 4_000
/** Where there is no requestIdleCallback (Safari): a plain delay. */
export const IDLE_FALLBACK_MS = 1_500

/** Before the idle prefetch asks for idle time: the dashboard's own first requests go first. */
export const IDLE_DELAY_MS = 800

/** A 2G connection (`navigator.connection.effectiveType`): no speculative engine download while idle. */
const slowConnection = () => {
  try {
    const c = (globalThis.navigator as { connection?: { effectiveType?: string } } | undefined)?.connection
    return c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g'
  } catch {
    return false
  }
}

/**
 * K1-3: the board code once the page is idle (the dashboard: after its first requests). Not on a 2G
 * connection (a link the person reaches still prefetches), and never on Save-Data (`prefetchBoardCode`).
 * Returns the cancel (the dashboard left before it ran).
 */
export function prefetchBoardCodeWhenIdle(
  win: IdleWindow = globalThis as unknown as IdleWindow,
  prefetch: () => boolean = prefetchBoardCode,
  slow: () => boolean = slowConnection,
): () => void {
  if (slow()) return () => {}
  let idle: number | null = null
  let fallback: unknown = null
  const delay = win.setTimeout(() => {
    if (typeof win.requestIdleCallback === 'function')
      idle = win.requestIdleCallback(() => prefetch(), { timeout: IDLE_PREFETCH_TIMEOUT_MS })
    else fallback = win.setTimeout(() => prefetch(), IDLE_FALLBACK_MS)
  }, IDLE_DELAY_MS)
  return () => {
    win.clearTimeout(delay as never)
    if (idle !== null) win.cancelIdleCallback?.(idle)
    if (fallback !== null) win.clearTimeout(fallback as never)
  }
}

// ---- the board's first data (K1-2) ----------------------------------------------------------------------

interface BoardOpen {
  readonly boardId: string
  readonly at: number
  detail: Promise<BoardDetail> | null
  ticket: Promise<TicketResponse> | null
}

/** A preloaded answer older than this is not used (the ticket's own life is about a minute). */
export const OPEN_FRESH_MS = 20_000
let open: BoardOpen | null = null

interface OpenDeps {
  getBoard(boardId: string): Promise<BoardDetail>
  boardTicket(boardId: string): Promise<TicketResponse>
  now(): number
}
const defaultDeps: OpenDeps = {
  getBoard: (boardId) => api.getBoard(boardId),
  boardTicket: (boardId) => api.boardTicket(boardId),
  now: () => Date.now(),
}

/**
 * K1-2: GET /api/boards/:id and the first ticket, together, once per board open (idempotent while
 * fresh: the board route calls it on every render, and React may render twice). Only with a session
 * (the board route renders under RequireSession). Neither answer is reported here: the board page takes
 * them (`takeBoardDetail`, `takeBoardTicket`) and handles their errors as it handled its own requests'.
 */
export function preloadBoardOpen(boardId: string, deps: OpenDeps = defaultDeps): void {
  const now = deps.now()
  if (open && open.boardId === boardId && now - open.at < OPEN_FRESH_MS && (open.detail || open.ticket))
    return
  const detail = deps.getBoard(boardId)
  const ticket = deps.boardTicket(boardId)
  // nobody may take them (the person left, a 403 made the ticket moot): never an unhandled rejection
  detail.catch(() => {})
  ticket.catch(() => {})
  open = { boardId, at: now, detail, ticket }
}

function take<K extends 'detail' | 'ticket'>(key: K, boardId: string, now: number): BoardOpen[K] {
  if (!open || open.boardId !== boardId || now - open.at >= OPEN_FRESH_MS) return null
  const p = open[key]
  open[key] = null
  return p
}

/** The preloaded GET /api/boards/:id for `boardId`, once (null: ask now). */
export const takeBoardDetail = (boardId: string, now = Date.now()): Promise<BoardDetail> | null =>
  take('detail', boardId, now)

/** The preloaded first ticket for `boardId`, once (null: ask now). */
export const takeBoardTicket = (boardId: string, now = Date.now()): Promise<TicketResponse> | null =>
  take('ticket', boardId, now)

// ---- title hints for the skeleton (K1-5) ----------------------------------------------------------------

export interface BoardTitleHint {
  readonly title: string
  /** the workspace whose page the link was on (its name comes from the session) */
  readonly workspaceId: string | null
}

const hints = new Map<string, BoardTitleHint>()
const MAX_HINTS = 200

/** Remembers a board's title (a link the person reached, or the board itself once it answered). */
export function rememberBoardTitle(boardId: string, title: string, workspaceId: string | null = null): void {
  const t = title.trim()
  if (!t) return
  hints.delete(boardId)
  hints.set(boardId, { title: t.slice(0, 200), workspaceId })
  if (hints.size > MAX_HINTS) hints.delete(hints.keys().next().value as string)
}

/** The signed-in user the hints and the preloaded open belong to (null: nobody yet). */
let hintsUser: string | null = null

/**
 * Wave K integration (the K1 review): the session's user, from App.tsx (`null` once signed out; `undefined` while
 * the session is being checked, which changes nothing). When the user changes (Sign out on a shared computer,
 * another account in the same tab, no reload) the board titles remembered for the skeleton and an untaken
 * preloaded board answer are forgotten, so the next person never sees the previous one's board titles.
 */
export function noteSessionUser(uid: string | null | undefined): void {
  if (uid === undefined) return
  if (hintsUser !== null && uid !== hintsUser) {
    hints.clear()
    open = null
  }
  hintsUser = uid
}

/** What the skeleton may show for `boardId` before the board answers (null: a neutral placeholder). */
export const boardTitleHint = (boardId: string): BoardTitleHint | null => hints.get(boardId) ?? null

function workspaceOfPage(): string | null {
  const path = globalThis.location?.pathname
  if (!path) return null
  const route = matchRoute(path)
  return route.name === 'workspace' ? route.workspaceId : null
}
