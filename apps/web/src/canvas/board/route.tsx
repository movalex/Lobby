/**
 * /b/:boardId on the Excalidraw engine (App.tsx renders this for every board; since wave 4 part 2 it is the
 * only board page: docs/EXCALIDRAW-CUTOVER.md G2, G10). Opens Lobby's board page (./LobbyBoardPage.tsx),
 * or spike B's board page (canvas/spike/board/SpikeBoardPage.tsx) while spike B still runs its acceptance
 * specs against it:
 *
 *  - `VITE_LOBBY_BOARD_PAGE=spike` at build time: /b/:boardId is the spike page (the spike B suite's
 *    build: a change request asks spike B's e2e/spike-b/playwright.config.ts to set it);
 *  - `?page=spike` on a board URL: the spike page for one visit (manual comparison).
 *
 * The spike page stays behind the local-dev guard (the Vite dev server, or a build with
 * VITE_DRAFTROOM_DEV_AUTH=1; src/lib/identity.ts): the production engine build carries only Lobby's page,
 * and `?page=spike` opens Lobby's page there. The test is inlined so the spike chunk folds out of that
 * build (an imported const does not fold).
 *
 * K1-1 (wave K): this module is part of the app's first bundle (App.tsx imports it), so a board goes
 * through ONE lazy step, the board page's chunk (lib/prefetch-board.ts `loadBoardCode`, which App.tsx
 * already started for a board address). Before, App lazily loaded this module and this module lazily
 * loaded the page, one after the other. K1-2: the board and its first ticket are asked for here, as soon
 * as the route renders with a session, while the code may still be on its way. K1-5: while the code
 * downloads, the board skeleton (./BoardSkeleton.tsx).
 */
import { lazy, Suspense, useRef } from 'react'
import { useSession } from '../../auth/session.tsx'
import { loadBoardCode, preloadBoardOpen } from '../../lib/prefetch-board.ts'
import { BoardSkeleton } from './BoardSkeleton.tsx'

const LobbyBoardPage = lazy(loadBoardCode)
const SpikeBoardPage =
  import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1'
    ? lazy(() => import('../spike/board/SpikeBoardPage.tsx'))
    : null

const env = import.meta.env as unknown as { VITE_LOBBY_BOARD_PAGE?: string }

/** Which board page /b/:boardId opens in this build and for this URL (`spikeAvailable`: the guard). */
export function boardPageFor(
  search: string,
  buildChoice = env.VITE_LOBBY_BOARD_PAGE,
  spikeAvailable = import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1',
): 'lobby' | 'spike' {
  if (!spikeAvailable) return 'lobby'
  if (buildChoice === 'spike') return 'spike'
  return new URLSearchParams(search).get('page') === 'spike' ? 'spike' : 'lobby'
}

export default function ExcalidrawBoardRoute({ boardId }: { boardId: string }) {
  const page = boardPageFor(location.search)
  const { state } = useSession()
  // K1-2: once per board this route shows (idempotent: React may render twice)
  const preloaded = useRef<string | null>(null)
  if (page === 'lobby' && preloaded.current !== boardId) {
    preloaded.current = boardId
    preloadBoardOpen(boardId)
  }
  const workspaces = state.status === 'signed-in' ? state.me.workspaces : undefined
  return (
    <Suspense fallback={<BoardSkeleton boardId={boardId} workspaces={workspaces} />}>
      {page === 'spike' && SpikeBoardPage ? (
        <SpikeBoardPage boardId={boardId} />
      ) : (
        <LobbyBoardPage boardId={boardId} />
      )}
    </Suspense>
  )
}
