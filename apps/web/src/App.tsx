import { lazy, Suspense } from 'react'
import { DevIdentityPicker, MessageScreen, SignInPlaceholder } from './home/DevIdentityPicker.tsx'
import { HomePage } from './home/HomePage.tsx'
import { DEV_AUTH_ENABLED, isBoardId, parseDevIdentity } from './lib/identity.ts'
import { matchRoute, useLocationKey } from './lib/routing.ts'

// The board pulls in tldraw (~2 MB); the home page should not have to download it.
const BoardPage = lazy(() => import('./board/BoardPage.tsx').then((m) => ({ default: m.BoardPage })))

export function App() {
  useLocationKey() // re-render on navigation
  if (!DEV_AUTH_ENABLED) return <SignInPlaceholder />

  const route = matchRoute(location.pathname, isBoardId)
  const identity = parseDevIdentity(location.search)
  switch (route.name) {
    case 'home':
      return <HomePage identity={identity} />
    case 'board':
      if (!identity) return <DevIdentityPicker boardId={route.boardId} />
      return (
        <Suspense
          fallback={
            <div className="dr-screen dr-screen--page" data-testid="board-loading">
              <span className="dr-spinner" aria-hidden="true" />
            </div>
          }
        >
          <BoardPage boardId={route.boardId} identity={identity} />
        </Suspense>
      )
    case 'invalid-board':
      return (
        <MessageScreen
          title="That board id isn't valid"
          body='Board ids are 3–64 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.'
        />
      )
    default:
      return <MessageScreen title="Page not found" body="There is nothing at this address." />
  }
}
