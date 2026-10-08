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
 *  - K1-2 `preloadBoardOpen(boardId)` / `takeBoardDetail` / `takeBoardTicket`: GET /api/boards/:id and the
 *    first POST /api/boards/:id/ticket together, as soon as the board route renders with a session (before
 *    the board code has arrived). The board page takes each answer once; a retry asks again.
 */
import type { BoardDetail, TicketResponse } from '@draftroom/contracts'
import { api } from '../api/client.ts'
import { matchRoute } from './routing.ts'

// ---- the board code (K1-1) ------------------------------------------------------------------------------

export interface BoardCode<T> {
  /** Downloads (once) and resolves the module. A failed download may be tried again. */
  load(): Promise<T>
  /** Whether a download was started (and has not failed). */
  readonly started: boolean
}

export function createBoardCode<T>(loader: () => Promise<T>): BoardCode<T> {
  let pending: Promise<T> | null = null
  const load = () => {
    if (!pending) {
      const p = loader()
      pending = p
      // a download that failed (a deploy removed the file, the network) may be asked for again
      p.catch(() => {
        if (pending === p) pending = null
      })
    }
    return pending
  }
  return {
    load,
    get started() {
      return pending !== null
    },
  }
}

/** The board page module (its default export is the page). */
export const importBoardPage = () => import('../canvas/board/LobbyBoardPage.tsx')
export type BoardPageModule = Awaited<ReturnType<typeof importBoardPage>>

const boardCode = createBoardCode(importBoardPage)

/** K1-1: the board page's code, downloaded once per tab (not speculative). */
export const loadBoardCode = (): Promise<BoardPageModule> => boardCode.load()

/**
 * K1-1: called once while App.tsx is evaluated, with `location.pathname`: on a board's address the board
 * code starts downloading now, alongside the sign-in check. Any other address downloads nothing.
 */
export function startBoardCodeFor(pathname: string, load: () => Promise<unknown> = loadBoardCode): boolean {
  if (matchRoute(pathname).name !== 'board') return false
  load().catch(() => {}) // the board route's own load reports a failure
  return true
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
