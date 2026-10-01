import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { SignInPage } from './auth/SignInPage.tsx'
import { SessionProvider, useSession } from './auth/session.tsx'
import { DashboardPage } from './dashboard/DashboardPage.tsx'
import { landingWorkspace, noWorkspaceCopy } from './dashboard/model.ts'
import { GuestEndedScreen } from './invite/GuestEndedScreen.tsx'
import { GuestKindProvider, wasGuestTab } from './invite/guest.tsx'
import { InvitePage } from './invite/InvitePage.tsx'
import { DEV_AUTH_ENABLED } from './lib/identity.ts'
import { matchRoute, navigate, signInPath, useLocationKey, workspacePath } from './lib/routing.ts'
import { readLastWorkspace } from './lib/storage.ts'
import { LoadingScreen, MessageScreen, UnreachableScreen } from './ui/screens.tsx'

// Spike A (docs/EXCALIDRAW-MIGRATION.md §8): dev-only /spike/:name engine pages, outside the session.
// The dev-auth test is inlined (same as DEV_AUTH_ENABLED) so it folds at build time: the imported const
// alone does not, and the spike chunks would ship, unreachable, in the production build.
const SpikeRoute =
  (import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1') && DEV_AUTH_ENABLED
    ? lazy(() => import('./canvas/spike/SpikeRoute.tsx'))
    : null
// /b/:boardId is Lobby's board page on the Excalidraw engine (canvas/board/route.tsx; docs/EXCALIDRAW-
// MIGRATION.md §7.2; since wave 4 part 2 the only board page: docs/EXCALIDRAW-CUTOVER.md G2, G10). The
// board pulls in the engine (about 1 MB), which the dashboard and sign-in should not have to download.
// Spike B's board page behind ?page=spike stays under the dev-auth guard (route.tsx).
const BoardRoute = lazy(() => import('./canvas/board/route.tsx'))

export function App() {
  if (SpikeRoute && location.pathname.startsWith('/spike/')) {
    return (
      <Suspense fallback={null}>
        <SpikeRoute pathname={location.pathname} />
      </Suspense>
    )
  }
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
            <BoardRoute boardId={route.boardId} />
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
  if (state.status === 'unreachable')
    return <UnreachableScreen message={state.message} onRetry={() => void refresh()} />
  return <LoadingScreen testId="session-loading" />
}

function RootRedirect() {
  const { state, signOut, signingOut } = useSession()
  const me = state.status === 'signed-in' ? state.me : null
  const target = me ? landingWorkspace(me.workspaces, readLastWorkspace()) : null
  const targetId = target?.id
  useEffect(() => {
    if (targetId) navigate(workspacePath(targetId), { replace: true })
  }, [targetId])
  if (me && !target) {
    // Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9): an outside account gets only what it is
    // invited to, so with nothing shared yet it lands here and is told why.
    const copy = noWorkspaceCopy(me.access)
    return (
      <MessageScreen
        testId="no-workspace"
        reason={copy.reason}
        title={copy.title}
        body={copy.body.map((p, i) => (
          <p key={p} data-testid={i === 0 && copy.reason === 'outside' ? 'no-workspace-account' : undefined}>
            {p}
          </p>
        ))}
        actions={
          copy.action === 'switch-account' ? (
            <button
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="no-workspace-switch"
              disabled={signingOut}
              aria-busy={signingOut || undefined}
              onClick={() => void signOut()}
            >
              {signingOut ? 'Signing out…' : 'Sign in with a different account'}
            </button>
          ) : copy.action === 'reload' ? (
            <button
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="no-workspace-reload"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          ) : (
            <span />
          )
        }
      />
    )
  }
  return <LoadingScreen />
}
