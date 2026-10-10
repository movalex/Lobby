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
 * downloads, the board skeleton (./BoardSkeleton.tsx). K1-7: a board chunk that no longer exists (a tab
 * from before a deploy) reloads the page once (lib/stale-chunk.ts) instead of breaking it; one that failed
 * while offline waits for the connection instead (round 2 refix).
 *
 * M6 (wave M, PWR-4): with the board and its ticket, this user's copy of the board in this browser is read
 * (canvas/sync/adapter/board-cache-db.ts `preloadBoardCache`; the light half of the cache, no canvas-schema), so
 * the board page can paint it the moment its canvas exists.
 */
import { lazy, Suspense, useEffect, useRef } from 'react'
import { useSession } from '../../auth/session.tsx'
import { type BoardPageModule, loadBoardCode, preloadBoardOpen } from '../../lib/prefetch-board.ts'
import { recoverChunk, reloadWhenOnline, staleChunks } from '../../lib/stale-chunk.ts'
import { MessageScreen } from '../../ui/screens.tsx'
import { preloadBoardCache } from '../sync/adapter/board-cache-db.ts'
import { BoardSkeleton } from './BoardSkeleton.tsx'

/** What a board shows while a stale board chunk reloads the page (or, after a reload loop, asks to). */
function BoardCodeUpdated() {
  return (
    <MessageScreen
      testId="board-code-updated"
      title="Lobby has been updated"
      body="Reloading to open this board with the new version…"
      actions={
        <button type="button" className="dr-btn dr-btn--primary" onClick={() => location.reload()}>
          Reload
        </button>
      }
    />
  )
}

/**
 * Round 2 refix: the board code failed while the browser is offline (the network's failure, not a deploy's):
 * no "Lobby has been updated", and no Reload, which would land on the browser's offline page. No board has
 * opened, so once the connection is back the page reloads once and opens it (React.lazy would keep this
 * screen for every board opened in this tab).
 */
function BoardCodeOffline() {
  useEffect(() => reloadWhenOnline(), [])
  return (
    <MessageScreen
      testId="board-code-offline"
      title="You are offline"
      body="This board could not load while you are offline. It opens by itself once you are back online."
    />
  )
}

const UPDATED: BoardPageModule = { default: BoardCodeUpdated } as unknown as BoardPageModule
const OFFLINE: BoardPageModule = { default: BoardCodeOffline } as unknown as BoardPageModule
const LobbyBoardPage = lazy(recoverChunk(loadBoardCode, UPDATED, staleChunks, OFFLINE))
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
  const uid = state.status === 'signed-in' ? state.me.user.id : null
  // K1-2: once per board this route shows (idempotent: React may render twice)
  const preloaded = useRef<string | null>(null)
  if (page === 'lobby' && preloaded.current !== boardId) {
    preloaded.current = boardId
    preloadBoardOpen(boardId)
  }
  // M6: and this user's cached copy, once per board and user (a guest has none: nothing is ever written for one)
  const cacheRead = useRef<string | null>(null)
  if (page === 'lobby' && uid && cacheRead.current !== `${boardId}|${uid}`) {
    cacheRead.current = `${boardId}|${uid}`
    preloadBoardCache(boardId, uid)
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
