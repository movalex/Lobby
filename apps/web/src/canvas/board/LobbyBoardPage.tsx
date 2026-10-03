/**
 * Lobby's board page on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.3, §7.2 wave 2C;
 * docs/EXCALIDRAW-CONTRACTS.md). /b/:boardId in every build (the one board page since wave 4 part 2),
 * inside the app's session: the same load, access and error screens the tldraw page had, the same top
 * bar, dock and notices, and the canvas: the Excalidraw host with
 * the board session (./session.ts), the overlay root and host slots (./chrome.tsx), and CANVAS_FEATURES
 * installed on the feature-facing canvas after the first welcome.
 *
 * Test ids: the tldraw page's where the job is the same (`board-loading`, `board-load-error`, `topbar`,
 * `board-title`, `save-status`, `conn-status`, `presence-user`, `feature-dock`, `sync-loading`,
 * `sync-error`, `offline-banner`, `share-button`, `skip-to-canvas`), and `lobby-board` (data-phase,
 * data-engine="excalidraw"), `lease-notice`, `lease-status`, `typing-badge`, `cursor` for the canvas.
 */
import '../engine/engineGlobals.ts'
import type { Board, BoardDetail, Me, TicketResponse } from '@draftroom/contracts'
import {
  lazy,
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
import {
  accessActorName,
  blockedEditHint,
  freshActorName,
  isReadonlyRole,
  roleChangeNotice,
} from '../../board/access.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import { NoticeRegion, useNotices } from '../../board/Notices.tsx'
import { SyncErrorScreen } from '../../board/SyncErrorScreen.tsx'
import { BoardAccount, type ConnState, TopBarFrame } from '../../board/TopBarFrame.tsx'
import { CANVAS_FEATURES } from '../../features/canvas-registry.ts'
import { type BoardEvents, createBoardEvents } from '../../features/events.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import { boardPath, navigate, setLeaveGuard } from '../../lib/routing.ts'
import { useResource } from '../../lib/useResource.ts'
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
import { parseFileKey } from '../files/loader.ts'
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
import {
  type ClipboardElement,
  contentOf,
  dispatchContent,
  filesBoardCannotShow,
  filesLeftOutNotice,
  readOnlyDropNotice,
  withoutElements,
} from './content.ts'
import { PROBE_FEATURE } from './probe.tsx'
import { LobbyBoardSession, type LobbyBoardSnapshot } from './session.ts'
import { duplicateLobbyData } from './tx.ts'
import { onUploads, uploadsInFlight } from './uploads.ts'
import './board.css'

const ShareDialog = lazy(() =>
  import('../../board/ShareDialog.tsx').then((m) => ({ default: m.ShareDialog })),
)

/** Longest an in-app navigation waits for this board's last changes to be acknowledged. */
const LEAVE_WAIT_MS = 5_000

/** /b/:bid — loads the board (and the caller's role) from the API, then opens the canvas. */
export function LobbyBoardPage({ boardId }: { boardId: string }) {
  const load = useCallback((signal: AbortSignal) => api.getBoard(boardId, signal), [boardId])
  const detail = useResource(load)
  if (detail.status === 'loading') return <LoadingScreen label="Opening board…" testId="board-loading" />
  if (detail.status === 'error') {
    if (isNoAccess(detail.error)) return <NoAccessScreen />
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

  useEffect(() => {
    document.title = `${board.title} · Lobby`
    return () => {
      document.title = 'Lobby'
    }
  }, [board.title])

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
      onAccessLost={() => setAccessLost(true)}
      onRetry={retry}
    />
  )
}

interface SessionProps {
  me: Me
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
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
  const { onAccessLost } = props
  const boardId = props.board.id
  useEffect(() => {
    const ac = new AbortController()
    api.boardTicket(boardId, ac.signal).then(
      (t) => setFirst(t),
      (e: unknown) => {
        if (ac.signal.aborted) return
        const kind = (e as { kind?: string }).kind
        if (kind === 'forbidden' || kind === 'not-found') onAccessLost()
        else if (kind === 'unauthorized') void refresh()
        else setFailed(isApiError(e) ? e.message : 'The board could not be opened.')
      },
    )
    return () => ac.abort()
  }, [boardId, onAccessLost, refresh])
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
  if (!first) return <LoadingScreen label="Opening board…" testId="board-loading" />
  return <LobbyBoardView {...props} first={first} />
}

const connOf = (s: LobbyBoardSnapshot): ConnState =>
  s.phase === 'ready'
    ? 'online'
    : s.phase === 'offline'
      ? 'offline'
      : s.phase === 'closed'
        ? 'error'
        : 'connecting'

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
    })
    setSession(s)
    return () => {
      s.dispose()
      setSession((current) => (current === s ? null : current))
    }
  }, [boardId, first, notify, dismiss])

  if (!session) return <LoadingScreen label="Opening board…" testId="board-loading" />
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
  useEffect(() => {
    if (!ctx || !welcomed) return
    return installCanvasFeatures(CANVAS_FEATURES, ctx)
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
    handle.installProbe = () => {
      uninstall ??= installCanvasFeatures([PROBE_FEATURE], ctx)
    }
    handle.uninstallProbe = () => {
      uninstall?.()
      uninstall = null
    }
    return () => {
      uninstall?.()
      delete handle.installProbe
      delete handle.uninstallProbe
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
  })

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
  const dropBlocked = useRef({ readonly, archived: board.status === 'archived' })
  dropBlocked.current = { readonly, archived: board.status === 'archived' }
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
  // REVIEW-6: the server tells ME (and nobody else) who changed my access; the toast names them.
  const announcedRole = useRef(role)
  const accessActor = useRef<{ name: string; at: number } | null>(null)
  useEffect(() => {
    if (!events) return
    return events.on('access.changed', (data) => {
      const name = accessActorName(data)
      accessActor.current = name ? { name, at: Date.now() } : null
    })
  }, [events])
  useEffect(() => {
    const text = roleChangeNotice(
      announcedRole.current,
      role,
      freshActorName(accessActor.current, Date.now()),
    )
    announcedRole.current = role
    if (text) {
      accessActor.current = null
      notify({ key: 'role-changed', text, testId: 'role-change-toast', timeoutMs: 8000 })
    }
  }, [role, notify])
  const roleNow = useRef(role)
  roleNow.current = role
  useEffect(() => {
    if (!events) return
    let seq = 0
    return events.on('sharing.changed', () => {
      const mine = ++seq
      api.boardTicket(boardId).then(
        (t) => {
          if (mine !== seq || t.role === roleNow.current) return
          if (RANK[t.role] < RANK[roleNow.current]) handlers.current.onRole(t.role)
        },
        () => {}, // no access any more: the sync server closes the session and says so
      )
    })
  }, [events, boardId])

  // PRI-08: on a read-only board, the first edit someone tries (dragging, double-clicking or deleting)
  // explains why nothing happened, once, with a way to ask for more.
  useBlockedEditHint(canvas, readonly && board.status === 'active', boardId, me.user.id, role, notify, () =>
    setSharing('request'),
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
  const conn = connOf(snap)
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
        <div className="dr-banner" data-testid="offline-banner" role="status">
          {snap.guest
            ? "You're offline. Changes you make are kept in this tab only until the connection returns; reloading now would lose them."
            : "You're offline. Changes you make are kept on this device and sync when the connection returns."}
        </div>
      )}
      <div className="dr-board__body">
        {ctx && !focusMode ? <CanvasDock ctx={ctx} /> : null}
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
          {!snap.welcomed && !closed && (
            <div className="dr-screen dr-screen--overlay lobby-canvas-screen" data-testid="sync-loading">
              <span className="dr-spinner" aria-hidden="true" />
              <p>{snap.phase === 'preparing' ? 'Preparing this board…' : 'Connecting to board…'}</p>
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
