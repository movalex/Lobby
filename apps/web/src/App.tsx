import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react'
import { SignInPage } from './auth/SignInPage.tsx'
import { SessionProvider, useSession } from './auth/session.tsx'
import { createSignOutPurge } from './canvas/sync/adapter/offline-idb.ts'
import { DashboardPage } from './dashboard/DashboardPage.tsx'
import { landingWorkspace } from './dashboard/model.ts'
import { FeedbackHost } from './features/feedback/FeedbackHost.tsx'
import { GuestEndedScreen } from './invite/GuestEndedScreen.tsx'
import { GuestKindProvider, wasGuestTab } from './invite/guest.tsx'
import { InvitePage } from './invite/InvitePage.tsx'
import { DEV_AUTH_ENABLED } from './lib/identity.ts'
import { matchRoute, navigate, signInPath, useLocationKey, workspacePath } from './lib/routing.ts'
import { readLastWorkspace } from './lib/storage.ts'
import { LoadingScreen, MessageScreen, NoWorkspaceScreen, UnreachableScreen } from './ui/screens.tsx'

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

// Wave J5: the feedback inbox at /feedback (its readers only; the api answers 404 to everybody else, and the
// page then shows the unknown-address screen). A small page, loaded when it is opened.
const FeedbackRoute = lazy(() => import('./features/feedback/FeedbackPage.tsx'))

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
      <PurgeOfflineOnSignOut />
      {/* Wave J5: the Send feedback dialog, opened by the board's menu and the account menu */}
      <FeedbackHost />
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
    case 'feedback':
      return (
        <RequireSession>
          <Suspense fallback={<LoadingScreen label="Loading feedback…" testId="feedback-loading" />}>
            <FeedbackRoute />
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

/**
 * CRIT-18: when the person signed in here signs out themselves (Sign out, Switch user, Sign out
 * everywhere), the board edits they had queued offline in this browser (IndexedDB,
 * canvas/sync/adapter/offline-idb.ts) are deleted, so a shared machine does not keep them readable. A
 * session that merely ended (a 401: expired, revoked, signed out in another tab) deletes nothing: those
 * edits are unsent work, kept for the same user's next session (the queue is per user).
 */
function PurgeOfflineOnSignOut() {
  const { state } = useSession()
  const [observe] = useState(() => createSignOutPurge())
  const uid = state.status === 'signed-in' ? state.me.user.id : null
  const explicit = state.status === 'signed-out' && state.explicit === true
  useEffect(() => observe({ status: state.status, uid, explicit }), [observe, state.status, uid, explicit])
  return null
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
  const { state } = useSession()
  const me = state.status === 'signed-in' ? state.me : null
  const target = me ? landingWorkspace(me.workspaces, readLastWorkspace()) : null
  const targetId = target?.id
  useEffect(() => {
    if (targetId) navigate(workspacePath(targetId), { replace: true })
  }, [targetId])
  // Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §9): an outside account gets only what it is invited to,
  // so with nothing shared yet it lands here and is told why (K4-4: ui/screens.tsx says which address is
  // signed in, what to do and how to switch account, on a phone too).
  if (me && !target) return <NoWorkspaceScreen />
  return <LoadingScreen />
}
