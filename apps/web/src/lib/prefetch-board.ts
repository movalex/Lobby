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
 */
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
