/**
 * /b/:boardId on the Excalidraw engine (VITE_LOBBY_ENGINE=excalidraw with the dev-auth guard; App.tsx
 * loads this module only then). Opens Lobby's board page (./LobbyBoardPage.tsx), or spike B's board page
 * (canvas/spike/board/SpikeBoardPage.tsx) while spike B still runs its acceptance specs against it:
 *
 *  - `VITE_LOBBY_BOARD_PAGE=spike` at build time: /b/:boardId is the spike page (the spike B suite's
 *    build: a change request asks spike B's e2e/spike-b/playwright.config.ts to set it);
 *  - `?page=spike` on a board URL: the spike page for one visit (manual comparison).
 *
 * Both pages stay behind the same guard; the normal build contains neither.
 */
import { lazy, Suspense } from 'react'
import { LoadingScreen } from '../../ui/screens.tsx'

const LobbyBoardPage = lazy(() => import('./LobbyBoardPage.tsx'))
const SpikeBoardPage = lazy(() => import('../spike/board/SpikeBoardPage.tsx'))

const env = import.meta.env as unknown as { VITE_LOBBY_BOARD_PAGE?: string }

/** Which board page /b/:boardId opens in this build and for this URL. */
export function boardPageFor(search: string, buildChoice = env.VITE_LOBBY_BOARD_PAGE): 'lobby' | 'spike' {
  if (buildChoice === 'spike') return 'spike'
  return new URLSearchParams(search).get('page') === 'spike' ? 'spike' : 'lobby'
}

export default function ExcalidrawBoardRoute({ boardId }: { boardId: string }) {
  const page = boardPageFor(location.search)
  return (
    <Suspense fallback={<LoadingScreen label="Opening board…" testId="board-loading" />}>
      {page === 'spike' ? <SpikeBoardPage boardId={boardId} /> : <LobbyBoardPage boardId={boardId} />}
    </Suspense>
  )
}
