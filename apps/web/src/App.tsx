import { lazy, type ReactNode, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { SignInPage } from './auth/SignInPage.tsx'
import { SessionProvider, useSession } from './auth/session.tsx'
import { NoticeRegion } from './board/Notices.tsx'
import { BoardSkeleton } from './canvas/board/BoardSkeleton.tsx'
import BoardRoute from './canvas/board/route.tsx'
import { createSignOutPurge } from './canvas/sync/adapter/offline-idb.ts'
import { DashboardPage } from './dashboard/DashboardPage.tsx'
import { landingWorkspace } from './dashboard/model.ts'
import { FeedbackHost } from './features/feedback/FeedbackHost.tsx'
import { formatsEnabled, formatsFlags } from './features/formats/flags.ts'
import { liveFlags } from './features/live/flags.ts'
import { GuestEndedScreen } from './invite/GuestEndedScreen.tsx'
import { GuestKindProvider, wasGuestTab } from './invite/guest.tsx'
import { InvitePage } from './invite/InvitePage.tsx'
import { DEV_AUTH_ENABLED } from './lib/identity.ts'
import {
  installBoardPrefetch,
  isBoardCodePrefetch,
  noteSessionUser,
  prefetchBoardCodeWhenIdle,
  returnsToBoard,
  startBoardCodeFor,
} from './lib/prefetch-board.ts'
import { matchRoute, navigate, signInPath, useLocationKey, workspacePath } from './lib/routing.ts'
import { useValue } from './lib/signals.ts'
import { installStaleChunkRecovery, recoverChunk, reloadWhenOnline, staleChunks } from './lib/stale-chunk.ts'
import { readLastWorkspace } from './lib/storage.ts'
import { installVersionCheck } from './lib/version-check.ts'
import { LoadingScreen, MessageScreen, NoWorkspaceScreen, UnreachableScreen } from './ui/screens.tsx'

// K1 (wave K), once per page, while this module is evaluated (before the session check answers):
//  - K1-1: on a board's address, the board page's code starts downloading now, alongside GET /api/auth/me
//    (it waited for that answer and then went through two lazy steps: about 1.1 s of serial download at 4G);
//  - K1-3: a pointer over, a focus on or a press of a link to a board downloads it ahead of the click;
//  - K1-7: a lazy chunk a deploy removed reloads the page once (or, on a board, offers a reload); a failed
//    speculative prefetch is left to the real load, so a hover or an idle moment never reloads the page;
//  - M3-5 (wave M): a tab learns about a new build without a chunk failing first (lib/version-check.ts: /version.json
//    while the tab is visible; a notice on a board, a silent reload outside one while the tab is hidden).
if (typeof window !== 'undefined') {
  startBoardCodeFor(location.pathname)
  installBoardPrefetch()
  installStaleChunkRecovery(window, staleChunks, isBoardCodePrefetch)
  installVersionCheck()
}

// Spike A (docs/EXCALIDRAW-MIGRATION.md §8): dev-only /spike/:name engine pages, outside the session.
// The dev-auth test is inlined (same as DEV_AUTH_ENABLED) so it folds at build time: the imported const
// alone does not, and the spike chunks would ship, unreachable, in the production build.
const SpikeRoute =
  (import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1') && DEV_AUTH_ENABLED
    ? lazy(() => import('./canvas/spike/SpikeRoute.tsx'))
    : null
// /b/:boardId is Lobby's board page on the Excalidraw engine (canvas/board/route.tsx; docs/EXCALIDRAW-
// MIGRATION.md §7.2; since wave 4 part 2 the only board page: docs/EXCALIDRAW-CUTOVER.md G2, G10). The
// board pulls in the engine (about 1 MB), which the dashboard and sign-in should not have to download: the
// route module itself is small and in this bundle, and it loads the board page's chunk (K1-1: one lazy step).
// Spike B's board page behind ?page=spike stays under the dev-auth guard (route.tsx).

/** A stale feedback-page chunk (K1-7): the page reloads; meanwhile, this. */
function FeedbackCodeUpdated() {
  return <LoadingScreen label="Lobby has been updated: reloading…" testId="feedback-code-updated" />
}

/** Round 2 refix: the feedback page's code failed while offline (not a deploy): it reloads once back online. */
function FeedbackCodeOffline() {
  useEffect(() => reloadWhenOnline(), [])
  return (
    <MessageScreen
      testId="feedback-code-offline"
      title="You are offline"
      body="This page could not load while you are offline. It opens by itself once you are back online."
    />
  )
}

// Wave J5: the feedback inbox at /feedback (its readers only; the api answers 404 to everybody else, and the
// page then shows the unknown-address screen). A small page, loaded when it is opened.
const FeedbackRoute = lazy(
  recoverChunk(
    () => import('./features/feedback/FeedbackPage.tsx'),
    { default: FeedbackCodeUpdated } as unknown as typeof import('./features/feedback/FeedbackPage.tsx'),
    staleChunks,
    { default: FeedbackCodeOffline } as unknown as typeof import('./features/feedback/FeedbackPage.tsx'),
  ),
)

// Wave V (WS3): the /j/:code page (a join code from the QR on the join card), outside the session: someone joining
// from a phone has none yet. A small page, loaded when opened, and only while LIVE_FLAGS.joinCodes is on (otherwise
// /j/... is the unknown-address screen, as before wave V).
const JoinRoute = lazy(() => import('./features/join/JoinPage.tsx'))

// Wave W (WS5): the workspace admin page /w/:wid/admin, inside the session, loaded when opened and only while
// FORMATS_FLAGS.admin is on AND the api offers it (otherwise /w/:wid/admin is the unknown-address screen, as before
// wave W). The api answers its routes 404 for anyone but the workspace's owners and admins.
const AdminRoute = lazy(() => import('./features/workspace-admin/AdminPage.tsx'))

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
      {/* K1-7: outside a board, the notice of a stale chunk that could not reload the page by itself */}
      <StaleChunkNotice />
    </SessionProvider>
  )
}

function Routes() {
  useLocationKey() // re-render on navigation
  const route = matchRoute(location.pathname)
  switch (route.name) {
    case 'signin':
      return (
        <>
          {/* K1-3: signing in to open a board (a shared link): its code downloads meanwhile */}
          {returnsToBoard(location.search) && <PrefetchBoardCodeWhenIdle />}
          <SignInPage />
        </>
      )
    case 'invite':
      return (
        <>
          {/* K1-3: an invitation (a client's review link, most often) leads to a board */}
          <PrefetchBoardCodeWhenIdle />
          <InvitePage token={route.token} />
        </>
      )
    case 'root':
      return (
        <RequireSession>
          <RootRedirect />
        </RequireSession>
      )
    case 'workspace':
      return (
        <RequireSession>
          <PrefetchBoardCodeWhenIdle />
          <DashboardPage workspaceId={route.workspaceId} section={route.section} />
        </RequireSession>
      )
    case 'board':
      return (
        // K1-5: the board skeleton from the first frame, the session check included
        <RequireSession loading={<BoardSkeleton boardId={route.boardId} />}>
          <BoardRoute boardId={route.boardId} />
        </RequireSession>
      )
    case 'join':
      if (!liveFlags().joinCodes)
        return <MessageScreen title="Page not found" body="There is nothing at this address." />
      return (
        <>
          {/* K1-3: a join code leads to a board */}
          <PrefetchBoardCodeWhenIdle />
          <Suspense fallback={<LoadingScreen testId="join-loading" />}>
            <JoinRoute code={route.code} />
          </Suspense>
        </>
      )
    case 'workspace-admin':
      if (!formatsFlags().admin)
        return <MessageScreen title="Page not found" body="There is nothing at this address." />
      return (
        <RequireSession>
          <AdminGate>
            <Suspense fallback={<LoadingScreen label="Loading…" testId="workspace-admin-loading" />}>
              <AdminRoute workspaceId={route.workspaceId} />
            </Suspense>
          </AdminGate>
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
          testId="board-not-found"
          title="This board doesn't exist or was deleted"
          body="That link isn't one of Lobby's board links. Board links look like /b/b-3k9x0q2m7a: check that you copied the whole link."
        />
      )
    default:
      return <MessageScreen title="Page not found" body="There is nothing at this address." />
  }
}

/**
 * Wave W: the admin page is drawn only while the api offers it (AuthConfig.formats.admin, DRAFTROOM_WORKSPACE_ADMIN);
 * otherwise this address is the unknown-address screen. A signal: the page appears when the config's answer arrives.
 */
function AdminGate({ children }: { children: ReactNode }) {
  const { configStatus, retryConfig } = useSession()
  const offered = useValue('lobby-admin-offered', () => formatsEnabled('admin'), [])
  // The api's offer arrives with GET /api/auth/config: until then the page is neither offered nor refused, so an
  // owner never sees "Page not found" first (the wave W integration's fix of WS5's gate).
  if (configStatus === 'loading') return <LoadingScreen label="Loading…" testId="workspace-admin-loading" />
  if (configStatus === 'error')
    return <UnreachableScreen message="Lobby's settings could not be loaded." onRetry={retryConfig} />
  if (!offered) return <MessageScreen title="Page not found" body="There is nothing at this address." />
  return <>{children}</>
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
  // K1-5 (the K1 review): another person in this tab never sees the previous one's board titles in the skeleton
  const sessionUser = state.status === 'signed-in' ? uid : state.status === 'signed-out' ? null : undefined
  useEffect(() => noteSessionUser(sessionUser), [sessionUser])
  return null
}

/**
 * K1-3: while a dashboard is shown (or the sign-in page on the way to a board, or an invitation), the board
 * page's code downloads once the page is idle (skipped on Save-Data and on a 2G connection;
 * lib/prefetch-board.ts), so the first board opened from it does not wait for the engine.
 */
function PrefetchBoardCodeWhenIdle() {
  useEffect(() => prefetchBoardCodeWhenIdle(), [])
  return null
}

/** K1-7: the stale-chunk notice outside a board (on a board, the board's own notices show it). */
function StaleChunkNotice() {
  const notice = useSyncExternalStore(
    (l) => staleChunks.subscribe(l),
    () => staleChunks.notice(),
    () => null,
  )
  if (!notice) return null
  return (
    <NoticeRegion
      notices={[
        {
          key: notice.key,
          text: notice.text,
          tone: notice.tone ?? 'info',
          testId: notice.testId ?? 'app-toast',
          timeoutMs: null,
          action: notice.action ?? null,
          seq: 1,
        },
      ]}
      onDismiss={() => staleChunks.dismiss()}
    />
  )
}

/** Renders children only with a session; otherwise sends the user to sign in and back here after. */
function RequireSession({ children, loading }: { children: ReactNode; loading?: ReactNode }) {
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
  return loading ?? <LoadingScreen testId="session-loading" />
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
