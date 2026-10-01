/**
 * /b/:boardId on the Excalidraw engine (VITE_LOBBY_ENGINE=excalidraw; App.tsx loads this module only
 * then, in every such build since wave 4: docs/EXCALIDRAW-CUTOVER.md G2). Opens Lobby's board page
 * (./LobbyBoardPage.tsx), or spike B's board page (canvas/spike/board/SpikeBoardPage.tsx) while spike B
 * still runs its acceptance specs against it:
 *
 *  - `VITE_LOBBY_BOARD_PAGE=spike` at build time: /b/:boardId is the spike page (the spike B suite's
 *    build: a change request asks spike B's e2e/spike-b/playwright.config.ts to set it);
 *  - `?page=spike` on a board URL: the spike page for one visit (manual comparison).
 *
 * The spike page stays behind the local-dev guard (the Vite dev server, or a build with
 * VITE_DRAFTROOM_DEV_AUTH=1; src/lib/identity.ts): the production engine build carries only Lobby's page,
 * and `?page=spike` opens Lobby's page there. The test is inlined so the spike chunk folds out of that
 * build (an imported const does not fold). The normal (tldraw) build contains neither page.
 */
import { lazy, Suspense } from 'react'
import { LoadingScreen } from '../../ui/screens.tsx'

const LobbyBoardPage = lazy(() => import('./LobbyBoardPage.tsx'))
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
  return (
    <Suspense fallback={<LoadingScreen label="Opening board…" testId="board-loading" />}>
      {page === 'spike' && SpikeBoardPage ? (
        <SpikeBoardPage boardId={boardId} />
      ) : (
        <LobbyBoardPage boardId={boardId} />
      )}
    </Suspense>
  )
}
