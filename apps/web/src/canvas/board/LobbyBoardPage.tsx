/**
 * Lobby's board page on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.3, §7.2 wave 2C;
 * docs/EXCALIDRAW-CONTRACTS.md). /b/:boardId in every build (the one board page since wave 4 part 2),
 * inside the app's session: the same load, access and error screens the tldraw page had, the same top
 * bar, dock and notices, and the canvas: the Excalidraw host with
 * the board session (./session.ts), the overlay root and host slots (./chrome.tsx), and CANVAS_FEATURES
 * installed on the feature-facing canvas after the first welcome.
 *
 * Test ids: the tldraw page's where the job is the same (`board-load-error`, `topbar`,
 * `board-title`, `save-status`, `conn-status`, `presence-user`, `feature-dock`, `sync-loading`,
 * `sync-error`, `offline-banner`, `share-button`, `skip-to-canvas`), and `lobby-board` (data-phase,
 * data-engine="excalidraw"), `lease-notice`, `lease-status`, `typing-badge`, `cursor` for the canvas.
 *
 * Wave K (K1): the board and its first ticket are asked for together (K1-2: lib/prefetch-board.ts
 * `preloadBoardOpen`, started by ./route.tsx before this chunk arrives; taken here once each, and asked again
 * on a retry); every loading state is the board skeleton (K1-5: ./BoardSkeleton.tsx, `board-skeleton`), the
 * dock's column is kept before the features install, and the connecting cover is the skeleton's canvas, so
 * nothing moves when the board takes over; a chunk a deploy removed shows a notice with a Reload button
 * while the board is open (K1-7: lib/stale-chunk.ts).
 *
 * Wave M (W6, PWR-4): this device's last copy of the board (canvas/sync/adapter/snapshot-cache.ts) is painted
 * read-only the moment the canvas exists, once the board answered 200, with "Showing your last copy ·
 * connecting" (`cached-copy`) until the first welcome replaces it (M6-2); the board's answer 403/404, the event
 * stream's access-lost and a trashed board drop that copy. Offline (the board's request never got an answer), a
 * member's copy of at most 7 days opens read-only with "Offline · showing your copy from <time>"
 * (`offline-copy`, M6-4); anyone else gets the screen they got before.
 */
import '../engine/engineGlobals.ts'
import type { Board, BoardDetail, Me, TicketResponse } from '@draftroom/contracts'
import {
  type ComponentProps,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api, isApiError, isNoAccess } from '../../api/client.ts'
import { AssetMetaStore } from '../../assets/meta-store.ts'
import { useMe, useSession } from '../../auth/session.tsx'
import { AccessActorHint, blockedEditHint, isReadonlyRole, roleChangeNotice } from '../../board/access.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import { NoticeRegion, useNotices } from '../../board/Notices.tsx'
import { SyncErrorScreen } from '../../board/SyncErrorScreen.tsx'
import { BoardAccount, TopBarFrame } from '../../board/TopBarFrame.tsx'
import { firstTicketWhileStarting } from '../../board/ticket.ts'
import { CANVAS_FEATURES } from '../../features/canvas-registry.ts'
import { type BoardEvents, createBoardEvents } from '../../features/events.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import { rememberBoardTitle, takeBoardDetail, takeBoardTicket } from '../../lib/prefetch-board.ts'
import { boardPath, navigate, setLeaveGuard } from '../../lib/routing.ts'
import { lazyRetrying, registerStaleChunkBoard } from '../../lib/stale-chunk.ts'
import { useResource } from '../../lib/useResource.ts'
import { CachedCopy } from '../../sync-quality/CachedCopy.tsx'
import { cachedOfflineLabel } from '../../sync-quality/copy.ts'
import { useEngineSaveStatus } from '../../sync-quality/useEngineSaveStatus.ts'
import { useTheme } from '../../theme/useTheme.ts'
import { isFocusLost, isTextEntry } from '../../ui/focus.ts'
import { boardAreaName, SkipLink } from '../../ui/SkipLink.tsx'
import { LoadingScreen, MessageScreen, NoAccessScreen } from '../../ui/screens.tsx'
import {
  type CanvasFeatureContext,
  CanvasFeatureContextProvider,
  installCanvasFeatures,
} from '../api/feature.ts'
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import { ExcalidrawHost, type ExcalidrawHostProps, type HostWiring } from '../engine/ExcalidrawHost.tsx'
import type { LobbyRole } from '../engine/interaction.ts'
import { parseFileKey } from '../files/loader.ts'
import { createExcalidrawScene } from '../sync/adapter/excalidraw.ts'
import { guestQueueLeaver } from '../sync/adapter/offline-guest.ts'
import {
  CACHE_OFFLINE_MAX_AGE_MS,
  type CachedBoard,
  type CacheRead,
  purgeBoardCache,
  takeBoardCache,
} from '../sync/adapter/snapshot-cache.ts'
import { CHUNK_THRESHOLD } from '../sync/flags.ts'
import { timelineMark } from '../sync/timeline.ts'
import { BoardSkeleton, SkeletonToolbar } from './BoardSkeleton.tsx'
import { boardCacheAllowed } from './cache-access.ts'
import {
  BoardPeople,
  CanvasDock,
  featureHasPeople,
  HostSlots,
  LeaseNotice,
  OverlayRoot,
  PendingAffordance,
  topBarItems,
  useRegistries,
} from './chrome.tsx'
import { connWith, useSocketProbe } from './connection.ts'
import {
  type ClipboardElement,
  contentOf,
  dispatchContent,
  filesBoardCannotShow,
  filesLeftOutNotice,
  readOnlyDropNotice,
  withoutElements,
} from './content.ts'
import { installFeaturesAfterWelcome } from './features-install.ts'
import { CRASH_PROBE_FEATURE, PROBE_FEATURE } from './probe.tsx'
import { LobbyBoardSession } from './session.ts'
import { duplicateLobbyData } from './tx.ts'
import { onUploads, uploadsInFlight } from './uploads.ts'
import './board.css'

type ShareDialogProps = ComponentProps<typeof import('../../board/ShareDialog.tsx').ShareDialog>
/** A Share dialog whose code did not load: nothing drawn, and the dialog closes, so the next Share opens it again. */
function ShareDialogUnavailable({ onClose }: ShareDialogProps) {
  useEffect(() => onClose(), [onClose])
  return null
}
// K1-7: a stale chunk draws nothing here (the board's notice offers the reload) rather than unmounting the board;
// wave P review: and the next Share asks for the code again (one that failed offline opens once back online)
const ShareDialog = lazyRetrying<ShareDialogProps>(
  () => import('../../board/ShareDialog.tsx').then((m) => ({ default: m.ShareDialog })),
  ShareDialogUnavailable,
)

/** Longest an in-app navigation waits for this board's last changes to be acknowledged. */
const LEAVE_WAIT_MS = 5_000
/** wave N.1: a board of more elements than this installs its features after the welcome's frame (a large board) */
const FEATURES_LATER_ABOVE = CHUNK_THRESHOLD

/** /b/:bid — loads the board (and the caller's role) from the API, then opens the canvas. */
export function LobbyBoardPage({ boardId }: { boardId: string }) {
  const me = useMe()
  const uid = me.user.id
  // K1-2: the answer route.tsx asked for together with the ticket, once; a retry asks again
  const load = useCallback(
    (signal: AbortSignal) => takeBoardDetail(boardId) ?? api.getBoard(boardId, signal),
    [boardId],
  )
  const detail = useResource(load)
  // M6-1: no access (403/404), a trashed board, or no member of its workspace (a workspace guest: round 1 refix):
  // this person's copy of it goes, and is never painted
  const noAccess = detail.status === 'error' && isNoAccess(detail.error)
  const trashed = detail.status === 'ready' && detail.data.board.status === 'trashed'
  const outsider = detail.status === 'ready' && !boardCacheAllowed(detail.data.workspace)
  useEffect(() => {
    if (noAccess || trashed || outsider) void purgeBoardCache(boardId, uid)
  }, [noAccess, trashed, outsider, boardId, uid])
  if (detail.status === 'loading') return <BoardSkeleton boardId={boardId} />
  if (detail.status === 'error') {
    if (isNoAccess(detail.error)) return <NoAccessScreen />
    // M6-4: the request never got an answer (offline): a member's recent copy, read-only, else the screen below
    if (detail.error.kind === 'network')
      return (
        <OfflineBoardCopy boardId={boardId} uid={uid} failure={detail.error} onRetry={detail.reload}>
          <MessageScreen
            testId="board-load-error"
            title="This board could not be opened"
            body={detail.error.message}
            actions={
              <button type="button" className="dr-btn dr-btn--primary" onClick={detail.reload}>
                Try again
              </button>
            }
          />
        </OfflineBoardCopy>
      )
    // 401: the session guard is already switching to the sign-in page.
    if (detail.error.kind === 'unauthorized') return <LoadingScreen testId="board-loading" />
    return (
      <MessageScreen
        testId="board-load-error"
        title="This board could not be opened"
        body={detail.error.message}
        actions={
          <button type="button" className="dr-btn dr-btn--primary" onClick={detail.reload}>
            Try again
          </button>
        }
      />
    )
  }
  return <LobbyBoardShell key={boardId} initial={detail.data} />
}

export default LobbyBoardPage

function LobbyBoardShell({ initial }: { initial: BoardDetail }) {
  const me = useMe()
  const [board, setBoard] = useState<Board>(initial.board)
  const [role, setRole] = useState<BoardRole>(initial.role)
  const [accessLost, setAccessLost] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // E2 (the D2 review): stable, as FirstTicket's ticket effect once depended on it. An inline arrow was a new
  // function on every render of this shell (a rename, a role change), so each one fetched a new ticket and
  // started a new board session and socket on the same canvas.
  // M6-1: every access loss (a refused ticket, a FORBIDDEN close, the event stream's access-lost) drops this
  // person's copy of the board
  const lostBoard = initial.board.id
  const lostUid = me.user.id
  const onLost = useCallback(() => {
    setAccessLost(true)
    void purgeBoardCache(lostBoard, lostUid)
  }, [lostBoard, lostUid])

  useEffect(() => {
    document.title = `${board.title} · Lobby`
    return () => {
      document.title = 'Lobby'
    }
  }, [board.title])
  // K1-5: the skeleton of a later open of this board in this tab names it at once
  const workspaceId = initial.workspace.id
  useEffect(
    () => rememberBoardTitle(board.id, board.title, workspaceId),
    [board.id, board.title, workspaceId],
  )

  // I2 (wave I): the page left this board: a guest's page queue with nothing unsent goes with it
  // (canvas/sync/adapter/offline-guest.ts; one with an unsent edit stays for their return). Not on a Retry
  // or a role change: those keep this shell, and only the session under it restarts. The release is DEFERRED
  // (`releaseGuestQueueSoon`): React runs an unmounting tree's passive cleanups from the parent down, so this
  // cleanup comes before the session's `dispose` (LobbyBoardView), whose `persistNow()` makes one last save;
  // a release made here would drop the queue and that save would make it again. A mount before the timer
  // runs (StrictMode's simulated unmount and remount in `vite dev`) cancels it: that bookkeeping is
  // `guestQueueLeaver`'s, and is tested with it (offline-guest-release.test.ts).
  const boardId = board.id
  const uid = me.user.id
  const [leaver] = useState(guestQueueLeaver)
  useEffect(() => {
    leaver.arrive({ boardId, uid })
    return () => leaver.leave({ boardId, uid })
  }, [leaver, boardId, uid])

  if (accessLost) return <NoAccessScreen revoked previousRole={role} />
  // A fresh key = a fresh session (socket, engine core, canvas): the way out of a terminal close.
  return (
    <FirstTicket
      key={`${board.id}/${me.user.id}/${attempt}`}
      me={me}
      board={board}
      role={role}
      workspace={initial.workspace}
      onBoardChange={setBoard}
      onRole={setRole}
      onAccessLost={onLost}
      onRetry={retry}
    />
  )
}

interface SessionProps {
  me: Me
  board: Board
  role: BoardRole
  /** the board answer's workspace (its `role`: the caller's workspace role as it is now, the cache gate) */
  workspace: BoardDetail['workspace']
  onBoardChange(board: Board): void
  onRole(role: BoardRole): void
  onAccessLost(): void
  onRetry(): void
}

/** The first ticket says who this is to the board server (the lease and presence identity). */
function FirstTicket(props: SessionProps) {
  const { refresh } = useSession()
  const [first, setFirst] = useState<TicketResponse | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // read when the ticket is refused, not a dependency of the effect: a new callback is no reason to fetch
  // a new ticket (that started a new session; the shell's own is stable too)
  const onAccessLost = useRef(props.onAccessLost)
  onAccessLost.current = props.onAccessLost
  const boardId = props.board.id
  const uid = props.me.user.id
  useEffect(() => {
    const ac = new AbortController()
    // K1-2: the ticket asked for together with the board (once: a retry, a new key, asks again), if it is
    // this person's. K6-1: while the api is starting (503 CANVAS_STARTING) the first ticket is asked again
    // soon, quietly (the skeleton stays), instead of the error screen; the preloaded answer is the first try.
    let preloaded = takeBoardTicket(boardId)
    const ticket = firstTicketWhileStarting(
      (signal) => {
        const p = preloaded
        preloaded = null
        // (the W6 review: a preloaded ask that never got an answer, made while offline or as the network changed,
        // is asked again now rather than shown as an error: the board itself has just answered)
        return p
          ? p.then(
              (t) => (t.user.id === uid ? t : api.boardTicket(boardId, signal)),
              (e: unknown) =>
                isApiError(e) && e.kind === 'network' ? api.boardTicket(boardId, signal) : Promise.reject(e),
            )
          : api.boardTicket(boardId, signal)
      },
      { signal: ac.signal },
    )
    ticket.then(
      (t) => {
        if (!ac.signal.aborted) setFirst(t)
      },
      (e: unknown) => {
        if (ac.signal.aborted) return
        const kind = (e as { kind?: string }).kind
        if (kind === 'forbidden' || kind === 'not-found') onAccessLost.current()
        else if (kind === 'unauthorized') void refresh()
        else setFailed(isApiError(e) ? e.message : 'The board could not be opened.')
      },
    )
    return () => ac.abort()
  }, [boardId, uid, refresh])
  if (failed)
    return (
      <MessageScreen
        testId="board-load-error"
        title="This board could not be opened"
        body={failed}
        actions={
          <button type="button" className="dr-btn dr-btn--primary" onClick={props.onRetry}>
            Try again
          </button>
        }
      />
    )
  if (!first) return <OpeningSkeleton {...props} />
  return <LobbyBoardView {...props} first={first} />
}

/** K1-5: the skeleton once the board answered: its own title and workspace, the shape of its toolbar. */
function OpeningSkeleton({ board, role, workspace }: Pick<SessionProps, 'board' | 'role' | 'workspace'>) {
  return (
    <BoardSkeleton
      boardId={board.id}
      title={board.title}
      workspace={workspace}
      readonly={isReadonlyRole(role, board.status)}
    />
  )
}

const subscribeOnline = (l: () => void) => {
  window.addEventListener('online', l)
  window.addEventListener('offline', l)
  return () => {
    window.removeEventListener('online', l)
    window.removeEventListener('offline', l)
  }
}
/** Whether the browser says it is online (P-003). */
function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  )
}

/** P-003: the offline banner's words (calm: what happens to the changes, nothing to do). */
export const OFFLINE_BANNER_TEXT =
  'Offline – your changes are kept on this device and will sync when you are back online.'
export const OFFLINE_BANNER_GUEST_TEXT =
  'Offline – your changes are kept in this tab and will sync when you are back online. Keep this tab open until then.'

const RANK: Record<BoardRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }

function LobbyBoardView({
  board,
  first,
  onRole,
  onAccessLost,
  ...rest
}: SessionProps & { first: TicketResponse }) {
  const boardId = board.id
  const { refresh } = useSession()
  const noticeState = useNotices()
  const { notify, dismiss } = noticeState
  const handlers = useRef({ onRole, onAccessLost, refresh })
  handlers.current = { onRole, onAccessLost, refresh }
  const archived = useRef(board.status === 'archived')
  archived.current = board.status === 'archived'
  // M6: this open's read of the board cache, taken once (React StrictMode's second session gets the same one);
  // none for a trashed board, nor for anyone who is not a member of its workspace (no read: nothing painted, and
  // the session writes no copy without one)
  const [cache] = useState<CacheRead | null>(() =>
    board.status === 'trashed' || !boardCacheAllowed(rest.workspace)
      ? null
      : takeBoardCache(boardId, first.user.id),
  )

  // The session (its socket, engine core, lease, offline queue) is made by the effect that disposes it, not
  // in render. React StrictMode (`vite dev`) runs every effect's cleanup once right after mount and then the
  // effect again on the same component: a session made in render was disposed for good by that cleanup
  // (its transport closed with 0 attempts, the board stuck at "Connecting to board…"; LEAD-1), and
  // StrictMode's second call of a render-time initializer left a second, never-disposed session holding the
  // tab's offline-queue lock. Each effect run owns exactly one session, so a remount reconnects.
  const [session, setSession] = useState<LobbyBoardSession | null>(null)
  useEffect(() => {
    const s = new LobbyBoardSession({
      boardId,
      first,
      archived: archived.current,
      notices: { notify, dismiss },
      onTicket: (t) => handlers.current.onRole(t.role),
      onAccessLost: () => handlers.current.onAccessLost(),
      onSignedOut: () => void handlers.current.refresh(),
      cache,
    })
    setSession(s)
    return () => {
      s.dispose()
      setSession((current) => (current === s ? null : current))
    }
  }, [boardId, first, notify, dismiss, cache])

  if (!session) return <OpeningSkeleton board={board} role={rest.role} workspace={rest.workspace} />
  return (
    <LobbyBoardScreen
      {...rest}
      board={board}
      first={first}
      onRole={onRole}
      onAccessLost={onAccessLost}
      session={session}
      noticeState={noticeState}
    />
  )
}

/** The board page proper, on one live session (the page's state, the canvas, the chrome). */
function LobbyBoardScreen({
  me,
  board,
  role,
  workspace,
  onBoardChange,
  onRole,
  onAccessLost,
  onRetry,
  session,
  noticeState,
}: SessionProps & {
  first: TicketResponse
  session: LobbyBoardSession
  noticeState: ReturnType<typeof useNotices>
}) {
  const boardId = board.id
  const { refresh } = useSession()
  const { notices, notify, dismiss } = noticeState
  const [sharing, setSharing] = useState<false | 'default' | 'request'>(false)
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const handlers = useRef({ onRole, onAccessLost, refresh })
  handlers.current = { onRole, onAccessLost, refresh }

  const snap = useSyncExternalStore(
    (l) => session.subscribe(l),
    () => session.snapshot,
  )
  const browserOnline = useBrowserOnline()
  useRegistries(session.registries)
  // A feature whose dock tabs depend on state the page cannot see (workshops: a guest sees Voting and
  // Private notes only while a session runs) says so with this window event: the dock is drawn again.
  const [, setPanelsTick] = useState(0)
  useEffect(() => {
    const bump = () => setPanelsTick((n) => n + 1)
    window.addEventListener('lobby:panels-changed', bump)
    return () => window.removeEventListener('lobby:panels-changed', bump)
  }, [])
  const settings = useSyncExternalStore(
    (l) => session.settings.subscribe(l),
    () => session.settings.get(),
  )
  const { colorMode } = useTheme()
  useEffect(() => session.setTheme(colorMode), [session, colorMode])

  // The sharing badge (features/sharing) opens the Share dialog through this window event.
  useEffect(() => {
    const open = () => setSharing('default')
    window.addEventListener('draftroom:open-share', open)
    return () => window.removeEventListener('draftroom:open-share', open)
  }, [])

  // One server-sent event stream per mounted board session, shared by all features.
  const [events, setEvents] = useState<BoardEvents | null>(null)
  useEffect(() => {
    const stream = createBoardEvents(boardId)
    const offLost = stream.onAccessLost(() => handlers.current.onAccessLost())
    setEvents(stream)
    return () => {
      offLost()
      stream.close()
      setEvents((current) => (current === stream ? null : current))
    }
  }, [boardId])

  const readonly = isReadonlyRole(role, board.status) || snap.readonly
  // M6-2: this device's copy is shown (read-only) until the first welcome
  const showingCache = !!snap.cached && !snap.welcomed
  const canvas = snap.attached ? session.canvas : null

  // The feature context: stable per canvas and event stream; what changes (the board, the role, the open
  // panel) is read live, so commands and onMount closures never see a stale value.
  const live = useRef({ board, role, activePanel })
  live.current = { board, role, activePanel }
  const ctx = useMemo<CanvasFeatureContext | null>(() => {
    if (!canvas || !events) return null
    return {
      canvas,
      registries: session.registries,
      get board() {
        return live.current.board
      },
      get role() {
        return live.current.role
      },
      me,
      workspace,
      api,
      events,
      notify: (n: NoticeInput) => notify(n),
      dismiss: (key: string) => dismiss(key),
      openPanel: (id: string | null) => setActivePanel(id),
      get activePanel() {
        return live.current.activePanel
      },
    }
  }, [canvas, events, session, me, workspace, notify, dismiss])

  // CANVAS_FEATURES, once per canvas, after the first welcome (docs/EXCALIDRAW-CONTRACTS.md §4)
  const welcomed = snap.welcomed
  // (wave N.1: on a large board a frame and a task after it; ./features-install.ts)
  useEffect(() => {
    if (!ctx || !welcomed) return
    return installFeaturesAfterWelcome(ctx.canvas, FEATURES_LATER_ABOVE, () => {
      // wave N (the N1 specs): the features' install on the page's timeline
      timelineMark('lobby.features.start')
      const uninstall = installCanvasFeatures(CANVAS_FEATURES, ctx)
      timelineMark('lobby.features.end')
      return uninstall
    })
  }, [ctx, welcomed])
  // a feature tool's onExit when another tool takes over (Escape, a toolbar button, setTool)
  useEffect(() => {
    if (!ctx) return
    let previous = ctx.canvas.tool()
    return ctx.canvas.on('toolChanged', (tool) => {
      const left = previous ? ctx.registries.tools.get(previous) : undefined
      previous = tool
      if (left?.onExit && left.id !== tool) left.onExit(ctx)
    })
  }, [ctx])

  // dev-auth builds: the board page's own e2e checks install a probe feature through the debug handle
  useEffect(() => {
    if (!ctx || !welcomed || !DEV_AUTH_ENABLED) return
    const handle = (window as unknown as { __lobbyBoard?: Record<string, unknown> }).__lobbyBoard
    if (!handle) return
    let uninstall: (() => void) | null = null
    let uninstallCrash: (() => void) | null = null
    handle.installProbe = () => {
      uninstall ??= installCanvasFeatures([PROBE_FEATURE], ctx)
    }
    handle.uninstallProbe = () => {
      uninstall?.()
      uninstall = null
    }
    // H1 (M1-2): a feature that throws, for m1-boundary.spec.ts
    handle.installCrashProbe = () => {
      uninstallCrash ??= installCanvasFeatures([CRASH_PROBE_FEATURE], ctx)
    }
    return () => {
      uninstall?.()
      uninstallCrash?.()
      delete handle.installProbe
      delete handle.uninstallProbe
      delete handle.installCrashProbe
    }
  }, [ctx, welcomed])

  // uploads of this tab still on their way (3g's files.insert tracks them): never "Saved" before
  const uploading = useSyncExternalStore(
    (l) => onUploads(session.registries, l),
    () => uploadsInFlight(session.registries),
  )
  const save = useEngineSaveStatus({
    status: snap.save,
    welcomed: snap.welcomed,
    terminal: snap.phase === 'closed',
    readonly,
    guest: snap.guest,
    uploading,
    role,
    cached:
      showingCache && snap.cached
        ? { savedAt: snap.cached.savedAt, offline: snap.phase === 'offline' }
        : null,
  })

  // K1-7: while this board is open, a chunk a deploy removed shows a notice with a Reload button (never a
  // reload by itself), and the button waits for this tab's changes not yet acknowledged
  useEffect(
    () =>
      registerStaleChunkBoard({
        unsent: () => session.snapshot.save.pending > 0 || uploadsInFlight(session.registries) > 0,
        // P-003: a "Lobby has been updated" notice never lands while someone is typing
        editing: () => (session.snapshot.edit?.phase ?? 'idle') !== 'idle',
        notify,
      }),
    [session, notify],
  )

  // In-app navigation away from the board holds until this tab's last changes are acknowledged (bounded).
  useEffect(() => {
    const settling = () => session.snapshot.save.state === 'saving' || uploadsInFlight(session.registries) > 0
    return setLeaveGuard((to) => {
      if (new URL(to, location.origin).pathname === boardPath(boardId)) return
      if (!settling()) return
      return new Promise<void>((resolve) => {
        const started = performance.now()
        const poll = setInterval(() => {
          if (settling() && performance.now() - started < LEAVE_WAIT_MS) return
          clearInterval(poll)
          resolve()
        }, 50)
      })
    })
  }, [boardId, session])

  // A11Y2-09: the canvas is named after the board and takes the keyboard when the board opens, unless
  // something else already has it (the skip link, a dialog, a field).
  const rootRef = useRef<HTMLElement | null>(null)
  const setRoot = useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el
      session.setRoot(el)
    },
    [session],
  )
  useEffect(() => {
    // W5-57: the region is named apart from the board's application inside it (features/a11y)
    rootRef.current?.setAttribute('aria-label', boardAreaName(board.title))
  }, [board.title])
  // CRIT-38: the input layer takes a drop on the canvas from someone who cannot add to the board (a viewer,
  // a commenter, an archived board) and did nothing with it, silently: say why. Capture phase on the
  // region, so it runs before the input layer's own listener inside it; a field (a comment) keeps its drop.
  // (not while the cached copy is shown: the role's own answer comes with the welcome)
  const dropBlocked = useRef({ readonly: readonly && !showingCache, archived: board.status === 'archived' })
  dropBlocked.current = { readonly: readonly && !showingCache, archived: board.status === 'archived' }
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onDrop = (e: DragEvent) => {
      if (!dropBlocked.current.readonly || isTextEntry(e.target instanceof Element ? e.target : null)) return
      const content = contentOf(e.dataTransfer)
      if (!content) return
      notify({
        key: content.kind === 'files' ? 'readonly-upload' : 'readonly-drop',
        text: readOnlyDropNotice(content.kind, dropBlocked.current.archived),
        testId: 'readonly-drop-notice',
      })
    }
    root.addEventListener('drop', onDrop, true)
    return () => root.removeEventListener('drop', onDrop, true)
  }, [notify])
  useEffect(() => {
    if (!canvas || !welcomed) return
    const frame = requestAnimationFrame(() => {
      if (!isFocusLost() || document.querySelector('dialog[open]')) return
      canvas.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [canvas, welcomed])

  // PRI-09b: my role changed while the board is open; a sharing event re-reads it and applies a LOWER
  // one at once (a higher one waits for the socket to reconnect with it).
  // REVIEW-6: the server tells the person whose access changed who changed it; the toast names them.
  // The name comes with the access.changed event of every change that really changed access (a grant set or
  // removed, an approved request, a workspace role, an invite, a transfer; a change of the board's visibility
  // reaches everyone on the board but whoever made it); a request that changed nothing sends none. An event
  // that left my role here as it was (most of a visibility change's) is dropped as soon as the role read below
  // agrees with what is on screen, so it cannot name someone on a later change of someone else's
  // (AccessActorHint).
  const announcedRole = useRef(role)
  const accessActor = useMemo(() => new AccessActorHint(), [])
  const roleNow = useRef(role)
  roleNow.current = role
  // Reads my role from the server: a LOWER one is applied at once (the sync server closes the session when
  // it matters), a higher one waits for the socket to reconnect with it; only the latest read counts.
  const roleRead = useRef(0)
  const readRole = useCallback(() => {
    const mine = ++roleRead.current
    const upTo = accessActor.mark
    api.boardTicket(boardId).then(
      (t) => {
        if (mine !== roleRead.current) return
        accessActor.settle(upTo, roleNow.current, t.role)
        if (RANK[t.role] < RANK[roleNow.current]) handlers.current.onRole(t.role)
      },
      () => {}, // no access any more: the sync server closes the session and says so
    )
  }, [boardId, accessActor])
  useEffect(() => {
    if (!events) return
    return events.on('access.changed', (data) => {
      accessActor.record(data, Date.now())
      readRole()
    })
  }, [events, accessActor, readRole])
  useEffect(() => {
    const text = roleChangeNotice(announcedRole.current, role, accessActor.fresh(Date.now()))
    announcedRole.current = role
    if (text) {
      accessActor.clear()
      notify({ key: 'role-changed', text, testId: 'role-change-toast', timeoutMs: 8000 })
    }
  }, [role, notify, accessActor])
  useEffect(() => {
    if (!events) return
    return events.on('sharing.changed', readRole)
  }, [events, readRole])

  // PRI-08: on a read-only board, the first edit someone tries (dragging, double-clicking or deleting)
  // explains why nothing happened, once, with a way to ask for more.
  useBlockedEditHint(
    canvas,
    readonly && !showingCache && board.status === 'active',
    boardId,
    me.user.id,
    role,
    notify,
    () => setSharing('request'),
  )

  const rename = useCallback(
    async (title: string) => {
      const previous = board
      onBoardChange({ ...board, title })
      try {
        onBoardChange(await api.patchBoard(boardId, { title }))
      } catch (e) {
        onBoardChange(previous)
        notify({
          key: 'rename',
          text: isApiError(e) ? e.message : 'The board could not be renamed.',
          tone: 'error',
        })
      }
    },
    [board, boardId, notify, onBoardChange],
  )

  const wiring = useMemo<readonly HostWiring[]>(() => [session.attach], [session])

  // paste and drop go to the features' content handlers first (docs/EXCALIDRAW-CONTRACTS.md §3)
  useEffect(() => {
    if (!ctx) return
    session.setContentSink((content, at, source) =>
      dispatchContent(ctx.registries.contentHandlers.list(), content, ctx, at, source),
    )
    return () => session.setContentSink(null)
  }, [ctx, session])
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const onPaste = useCallback<NonNullable<ExcalidrawHostProps['onPaste']>>(async (data, event) => {
    // Excalidraw's own clipboard (elements copied on a board) is Excalidraw's to paste, without the files
    // this board cannot show (CRIT-38)
    if (data.elements?.length) {
      const c = ctxRef.current
      return c ? pasteOnlyFilesThisBoardShows(data, c) : true
    }
    const c = ctxRef.current
    const content = contentOf(event?.clipboardData)
    if (c && content) {
      const p = c.canvas.pointer()
      const at = p?.overCanvas ? p.scene : null
      if (await dispatchContent(c.registries.contentHandlers.list(), content, c, at, 'paste')) return false
    }
    // Excalidraw's own paste path never takes files (its base64 copies, §2.10.1): Lobby's upload path does
    return !(data.files && Object.keys(data.files).length) && !event?.clipboardData?.files.length
  }, [])
  const onDuplicate = useCallback<NonNullable<ExcalidrawHostProps['onDuplicate']>>(
    (next, _prev, data) => {
      const handlers = session.registries.customData.list()
      let changed = false
      const out = next.map((el) => {
        if (!data.duplicateElements.has(el.id)) return el
        const cd = el.customData as { lobby?: Record<string, unknown> } | undefined
        if (!cd?.lobby) return el
        changed = true
        const lobby = duplicateLobbyData(cd.lobby, data.origIdToDuplicateId, handlers)
        const rest = { ...cd }
        if (lobby) rest.lobby = lobby
        else delete rest.lobby
        return { ...el, customData: Object.keys(rest).length ? rest : undefined }
      })
      return changed ? (out as never) : undefined
    },
    [session],
  )

  const focusMode = settings.focusMode
  // wave P review: the browser's offline signal is checked against a live socket (connection.ts)
  const probeSocket = useCallback((ms: number) => session.transport.probe(ms), [session])
  const socketProbe = useSocketProbe(probeSocket, browserOnline, snap.phase)
  const conn = connWith(snap, browserOnline, socketProbe)
  const closed = snap.phase === 'closed'
  const closeReason = snap.closeReason
  const terminalShown = closed && closeReason !== 'FORBIDDEN' && closeReason !== 'NOT_FOUND'

  const board_ = (
    <div
      className="dr-board"
      data-board-id={boardId}
      data-role={role}
      data-testid="lobby-board"
      data-engine="excalidraw"
      data-phase={snap.phase}
      data-focus-mode={focusMode || undefined}
    >
      <SkipLink label="Skip to canvas" testId="skip-to-canvas" onSkip={() => canvas?.focus()} />
      {!focusMode && (
        <TopBarFrame
          board={board}
          role={role}
          workspace={workspace}
          conn={conn}
          save={save.view}
          onRename={(t) => void rename(t)}
          onShare={() => setSharing('default')}
          onRequestAccess={() => setSharing('request')}
          // nothing when the people feature has its own chip, and when nobody else is here (the phone
          // menu then has no "On this board" row: W5-50)
          people={(max) =>
            featureHasPeople(session.registries) || !snap.roster.some((r) => r.uid !== me.user.id) ? null : (
              <BoardPeople roster={snap.roster} selfUserId={me.user.id} max={max} />
            )
          }
          items={(mode) => topBarItems(ctx, mode)}
        />
      )}
      {!focusMode && <BoardAccount />}
      {conn === 'offline' && (
        <div
          className="dr-banner"
          data-testid="offline-banner"
          role="status"
          data-cached={showingCache || undefined}
        >
          {showingCache && snap.cached
            ? // M6-4: the copy on screen is this device's, read-only until the connection returns
              `${cachedOfflineLabel(snap.cached.savedAt, undefined, snap.save.offlineChanges)}${snap.cached.exact ? '' : ' (links and web addresses are not kept in it)'}. You can edit once you are back online.`
            : snap.guest
              ? OFFLINE_BANNER_GUEST_TEXT
              : OFFLINE_BANNER_TEXT}
        </div>
      )}
      <div className="dr-board__body">
        {ctx && !focusMode ? <CanvasDock ctx={ctx} /> : null}
        {/* K1-5: the dock's column until the features install, so the canvas keeps its width */}
        {!ctx && !focusMode ? (
          <div className="dr-dock lobby-dock-placeholder" data-open="false" aria-hidden="true">
            <div className="dr-dock__rail" />
          </div>
        ) : null}
        <main className="dr-board__canvas" aria-label="Board canvas">
          <div className="dr-board__editor">
            <section ref={setRoot} className="lobby-board-canvas" data-lobby-board-canvas="">
              <ExcalidrawHost
                role={snap.role}
                theme={colorMode}
                wiring={wiring}
                onPaste={onPaste}
                onDuplicate={onDuplicate}
                onLinkOpen={onLinkOpen}
                gridModeEnabled={settings.grid}
                objectsSnapModeEnabled={settings.snap}
              />
              {ctx ? <OverlayRoot ctx={ctx} session={session} focusMode={focusMode} /> : null}
              {ctx ? <HostSlots ctx={ctx} focusMode={focusMode} /> : null}
              <PendingAffordance edit={snap.edit} />
            </section>
          </div>
          {showingCache && snap.cached && !closed && (
            // M6-2: the cached copy is on the canvas (read-only); the skeleton's toolbar keeps its place
            <CachedCopy
              savedAt={snap.cached.savedAt}
              offline={snap.phase === 'offline'}
              changes={snap.save.offlineChanges}
            >
              <SkeletonToolbar readonly={readonly} />
            </CachedCopy>
          )}
          {/* N1-4 (wave N): a chunked cold open shows its chunks as they come, read-only (no skeleton); one the
              socket cut short is covered again until the next welcome (part of a board is never shown as the board) */}
          {(!snap.welcomed || snap.partial) && !snap.applying && !showingCache && !closed && (
            // K1-5: the skeleton's canvas (shimmer, greyed toolbar) until the first welcome
            <div
              className="dr-screen dr-screen--overlay lobby-canvas-screen lobby-canvas-screen--skeleton"
              data-testid="sync-loading"
            >
              <div className="lobby-skeleton__shimmer" aria-hidden="true" />
              <p role="status">
                {snap.phase === 'preparing'
                  ? 'Preparing this board…'
                  : snap.partial
                    ? 'Reconnecting to board…'
                    : 'Connecting to board…'}
              </p>
              <SkeletonToolbar readonly={readonly} />
            </div>
          )}
          {terminalShown && closeReason !== 'NOT_AUTHENTICATED' && (
            <SyncErrorScreen reason={closeReason ?? 'UNKNOWN_ERROR'} onRetry={onRetry} />
          )}
        </main>
      </div>
      <LeaseNotice notice={snap.notice} onDismiss={() => session.dismissNotice()} />
      <NoticeRegion notices={notices} onDismiss={dismiss} />
      {sharing && (
        <Suspense fallback={null}>
          <ShareDialog
            board={board}
            role={role}
            workspace={workspace}
            selfUserId={me.user.id}
            focus={sharing === 'request' ? 'request' : undefined}
            onClose={() => setSharing(false)}
            onBoardChange={onBoardChange}
          />
        </Suspense>
      )}
    </div>
  )
  // always the same tree (a provider that appears later would remount the canvas)
  return <CanvasFeatureContextProvider value={ctx}>{board_}</CanvasFeatureContextProvider>
}

/**
 * M6-4 (wave M): the board's request never got an answer (the network is down). A member whose device kept a copy
 * of this board at most CACHE_OFFLINE_MAX_AGE_MS (7 days) ago sees it, read-only (the viewer's interaction, no
 * socket, nothing pushed, the offline queue untouched), with "Offline · showing your copy from <time>"; images
 * show their placeholder (no file is fetched). Back online (or Try again), the board opens as usual. Anyone else
 * (a guest, who never has a copy; an older copy; none) gets `children`: the screen this case showed before.
 *
 * Back online, the board is asked for again, and (the W6 review) up to ONLINE_RETRIES more times, a moment after
 * each failed try: a request made right at the switch can fail (the network still changing), which left the person
 * on this screen.
 */
function OfflineBoardCopy({
  boardId,
  uid,
  failure,
  onRetry,
  children,
}: {
  boardId: string
  uid: string
  /** the board request's failure (a new one per failed try) */
  failure: unknown
  onRetry(): void
  children: ReactNode
}) {
  const [read] = useState(() => (knownUserKind(uid) === 'guest' ? null : takeBoardCache(boardId, uid)))
  const [record, setRecord] = useState<CachedBoard | null | undefined>(() => (read ? read.value : null))
  useEffect(() => {
    if (!read) return
    let live = true
    // (also when the read answered between the render and this effect)
    void read.done.then((r) => {
      if (live) setRecord(r)
    })
    return () => {
      live = false
    }
  }, [read])
  // back online: the board's own open
  const retry = useRef(onRetry)
  retry.current = onRetry
  const retriesLeft = useRef(0)
  useEffect(() => {
    const online = () => {
      retriesLeft.current = ONLINE_RETRIES
      retry.current()
    }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [])
  // each try that failed after the connection came back: another one, a moment later
  useEffect(() => {
    void failure
    if (retriesLeft.current <= 0) return
    retriesLeft.current--
    const t = setTimeout(() => retry.current(), ONLINE_RETRY_MS)
    return () => clearTimeout(t)
  }, [failure])
  if (record === undefined) return <BoardSkeleton boardId={boardId} />
  const fresh = record && Date.now() - record.savedAt <= CACHE_OFFLINE_MAX_AGE_MS
  if (!record || !fresh) return <>{children}</>
  return <OfflineCopyCanvas record={record} onRetry={onRetry} />
}

/** Back online: how many more times the board is asked for after a failed try, and how long after it. */
const ONLINE_RETRIES = 3
const ONLINE_RETRY_MS = 1_500

/** The offline copy's canvas role: read-only (pan, zoom, links). */
const OFFLINE_COPY_ROLE: LobbyRole = 'viewer'

function OfflineCopyCanvas({ record, onRetry }: { record: CachedBoard; onRetry(): void }) {
  const { colorMode } = useTheme()
  // through the sync adapter's apply (CaptureUpdateAction.NEVER), once; nothing listens to changes, nothing pushes
  const wiring = useMemo<readonly HostWiring[]>(
    () => [
      (_wrapper, api) => {
        createExcalidrawScene(api).apply(record.elements.map((el) => structuredClone(el)))
        if (DEV_AUTH_ENABLED)
          (window as unknown as { __lobbyOfflineCopy?: unknown }).__lobbyOfflineCopy = {
            api,
            savedAt: record.savedAt,
          }
        return () => {
          if (DEV_AUTH_ENABLED)
            delete (window as unknown as { __lobbyOfflineCopy?: unknown }).__lobbyOfflineCopy
        }
      },
    ],
    [record],
  )
  const label = cachedOfflineLabel(record.savedAt)
  return (
    <div className="dr-board" data-testid="offline-copy" data-board-id={record.boardId} data-phase="offline">
      <div className="dr-banner" data-testid="offline-copy-banner" role="status">
        {label}. It may be out of date
        {record.exact ? '' : ', and links and web addresses are not kept in it'}; you can edit once you are
        back online.{' '}
        <button
          type="button"
          className="dr-btn dr-btn--ghost"
          onClick={onRetry}
          data-testid="offline-copy-retry"
        >
          Try again
        </button>
      </div>
      <div className="dr-board__body">
        <main className="dr-board__canvas" aria-label="Board canvas (offline copy)">
          <div className="dr-board__editor">
            <section className="lobby-board-canvas" data-lobby-board-canvas="">
              <ExcalidrawHost role={OFFLINE_COPY_ROLE} theme={colorMode} wiring={wiring} />
              <CachedCopy savedAt={record.savedAt} offline />
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}

type PasteData = Parameters<NonNullable<ExcalidrawHostProps['onPaste']>>[0]

/** The meta route's answers for pasted files (versions are immutable: a terminal answer is kept). */
const pasteMeta = new AssetMetaStore()
/** Longest a paste waits to learn whether this board shows a pasted file (then the room decides). */
const PASTE_CHECK_MS = 3_000

/**
 * CRIT-38 (docs/EXCALIDRAW-MIGRATION.md §2.10.4): a paste of Excalidraw's own clipboard loses the file
 * elements this board cannot show (copied on another board, in this workspace or another, or from
 * another app), and says so, before anything is created: pasted as they were, the room refused them
 * and the paste ended in "Change not saved". Everything else is pasted as usual. Resolves false when
 * nothing is left to paste.
 */
async function pasteOnlyFilesThisBoardShows(data: PasteData, ctx: CanvasFeatureContext): Promise<boolean> {
  const elements = (data.elements ?? []) as unknown as readonly ClipboardElement[]
  if (!elements.some((el) => el.type === 'image')) return true
  const boardId = ctx.board.id
  const known = new Set<string>()
  for (const el of ctx.canvas.items()) {
    const fileId = (el as { fileId?: unknown }).fileId
    const key = el.type === 'image' && typeof fileId === 'string' ? parseFileKey(fileId) : null
    if (key) known.add(key.versionId)
  }
  const drop = await filesBoardCannotShow(elements, {
    known: (versionId) => known.has(versionId),
    servable: async ({ assetId, versionId }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const snap = await Promise.race([
        pasteMeta.load(boardId, assetId, versionId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PASTE_CHECK_MS)
        }),
      ]).finally(() => clearTimeout(timer))
      if (!snap) return null
      return snap.missing ? false : snap.meta ? true : null
    },
  })
  if (!drop.size) return true
  ctx.notify({
    key: 'paste-files-left-out',
    text: filesLeftOutNotice(drop.size),
    testId: 'paste-files-left-out',
    timeoutMs: 12_000,
  })
  const kept = withoutElements(elements, drop)
  if (!kept.length) return false
  // what Excalidraw pastes after this resolves (App.insertClipboardContent reads `data` then)
  data.elements = kept as unknown as PasteData['elements']
  if (data.files) {
    const used = new Set(kept.map((el) => el.fileId).filter(Boolean))
    const files = { ...data.files }
    for (const el of elements)
      if (drop.has(el.id) && el.fileId && !used.has(el.fileId)) delete files[el.fileId]
    data.files = files
  }
  return true
}

/**
 * An element's link (§2.3.2 onLinkOpen): Excalidraw never navigates by itself. A link into Lobby opens
 * in this tab through the app's router; an http(s) link opens in a new tab without an opener; anything
 * else (javascript:, data:, a file) is ignored.
 */
const onLinkOpen: ExcalidrawHostProps['onLinkOpen'] = (element, event) => {
  event.preventDefault()
  const raw = (element as { link?: string | null }).link
  if (!raw) return
  let url: URL
  try {
    url = new URL(raw, location.origin)
  } catch {
    return
  }
  if (url.origin === location.origin) navigate(`${url.pathname}${url.search}${url.hash}`)
  else if (url.protocol === 'https:' || url.protocol === 'http:')
    window.open(url.href, '_blank', 'noopener,noreferrer')
}

/** PRI-08 on the Excalidraw page: the read-only role's first blocked edit, explained once per tab. */
function useBlockedEditHint(
  canvas: LobbyCanvas | null,
  active: boolean,
  boardId: string,
  userId: string,
  role: BoardRole,
  notify: (n: NoticeInput) => void,
  requestAccess: () => void,
) {
  const hinted = useRef(false)
  const request = useRef(requestAccess)
  request.current = requestAccess
  useEffect(() => {
    if (!canvas || !active) return
    const key = `draftroom:blocked-edit-hint:${boardId}`
    try {
      if (sessionStorage.getItem(key)) hinted.current = true
    } catch {}
    let pressed = false
    const blocked = () => {
      if (hinted.current) return
      hinted.current = true
      try {
        sessionStorage.setItem(key, '1')
      } catch {}
      void ownerName(boardId, userId).then((owner) =>
        notify({
          key: 'blocked-edit',
          text: blockedEditHint(role, owner),
          testId: 'blocked-edit-hint',
          timeoutMs: 12_000,
          action: { label: 'Request', testId: 'blocked-edit-request', onClick: () => request.current() },
        }),
      )
    }
    return canvas.on('input', (e) => {
      if (hinted.current) return
      if (e.type === 'pointer-down') pressed = e.button === 0 && canvas.tool() === 'select' && !!e.hit
      else if (e.type === 'pointer-up') pressed = false
      else if (e.type === 'pointer-move' && pressed && canvas.pointer()?.down) blocked()
      else if (e.type === 'double-click' && canvas.tool() === 'select' && e.hit) blocked()
      else if (
        e.type === 'key-down' &&
        (e.key === 'Delete' || e.key === 'Backspace') &&
        canvas.selection.length
      )
        blocked()
    })
  }, [canvas, active, boardId, userId, role, notify])
}

/** Someone who can grant access, for the blocked-edit hint: an owner other than me (null if unknown). */
async function ownerName(boardId: string, selfUserId: string): Promise<string | null> {
  try {
    const members = await Promise.race([
      api.listMembers(boardId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), 1_500)),
    ])
    const owners = members.filter((m) => m.role === 'owner' && m.user.id !== selfUserId)
    return (owners.find((m) => m.source === 'grant') ?? owners[0])?.user.name ?? null
  } catch {
    return null
  }
}
