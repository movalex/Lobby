import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { SignInPage } from './auth/SignInPage.tsx'
import { SessionProvider, useSession } from './auth/session.tsx'
import { DashboardPage } from './dashboard/DashboardPage.tsx'
import { landingWorkspace } from './dashboard/model.ts'
import { GuestEndedScreen } from './invite/GuestEndedScreen.tsx'
import { GuestKindProvider, wasGuestTab } from './invite/guest.tsx'
import { InvitePage } from './invite/InvitePage.tsx'
import { matchRoute, navigate, signInPath, useLocationKey, workspacePath } from './lib/routing.ts'
import { readLastWorkspace } from './lib/storage.ts'
import { LoadingScreen, MessageScreen } from './ui/screens.tsx'

// The board pulls in tldraw (~2 MB); the dashboard and sign-in should not have to download it.
const BoardPage = lazy(() => import('./board/BoardPage.tsx').then((m) => ({ default: m.BoardPage })))

export function App() {
  return (
    <SessionProvider>
      {/* Wave 3: who is signed in, an account or a name-only guest (GET /api/me `kind`). */}
      <GuestKindProvider>
        <Routes />
      </GuestKindProvider>
    </SessionProvider>
  )
}

function Routes() {
  useLocationKey() // re-render on navigation
  const route = matchRoute(location.pathname)
  switch (route.name) {
    case 'signin':
      return <SignInPage />
    case 'invite':
      return <InvitePage token={route.token} />
    case 'root':
      return (
        <RequireSession>
          <RootRedirect />
        </RequireSession>
      )
    case 'workspace':
      return (
        <RequireSession>
          <DashboardPage workspaceId={route.workspaceId} section={route.section} />
        </RequireSession>
      )
    case 'board':
      return (
        <RequireSession>
          <Suspense fallback={<LoadingScreen label="Opening board…" testId="board-loading" />}>
            <BoardPage boardId={route.boardId} />
          </Suspense>
        </RequireSession>
      )
    case 'invalid-board':
      return (
        <MessageScreen
          title="That board link isn't valid"
          body="Board links look like /b/b-3k9x0q2m7a. Check that you copied the whole link."
        />
      )
    default:
      return <MessageScreen title="Page not found" body="There is nothing at this address." />
  }
}

/** Renders children only with a session; otherwise sends the user to sign in and back here after. */
function RequireSession({ children }: { children: ReactNode }) {
  const { state, refresh } = useSession()
  const signedOut = state.status === 'signed-out'
  // A guest has no account to sign in with: when their session ends (the link was revoked or
  // expired, they were removed), this tab says so instead of showing a sign-in form.
  const guestEnded = signedOut && wasGuestTab()
  useEffect(() => {
    if (signedOut && !guestEnded)
      navigate(signInPath(`${location.pathname}${location.search}`), { replace: true })
  }, [signedOut, guestEnded])

  if (guestEnded) return <GuestEndedScreen />
  if (state.status === 'signed-in') return <>{children}</>
  if (state.status === 'unreachable') {
    return (
      <MessageScreen
        testId="api-unreachable"
        title="Can't reach Lobby"
        body={state.message}
        actions={
          <button type="button" className="dr-btn dr-btn--primary" onClick={() => void refresh()}>
            Try again
          </button>
        }
      />
    )
  }
  return <LoadingScreen testId="session-loading" />
}

function RootRedirect() {
  const { state } = useSession()
  const me = state.status === 'signed-in' ? state.me : null
  const target = me ? landingWorkspace(me.workspaces, readLastWorkspace()) : null
  const targetId = target?.id
  useEffect(() => {
    if (targetId) navigate(workspacePath(targetId), { replace: true })
  }, [targetId])
  if (me && !target) {
    return (
      <MessageScreen
        testId="no-workspace"
        title="You're not in a workspace yet"
        body="Open an invite link from a teammate to join their workspace or board."
        actions={<span />}
      />
    )
  }
  return <LoadingScreen />
}
