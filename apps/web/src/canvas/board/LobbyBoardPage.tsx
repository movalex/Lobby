/**
 * Lobby's board page on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.3, §7.2 wave 2C;
 * docs/EXCALIDRAW-CONTRACTS.md). /b/:boardId with VITE_LOBBY_ENGINE=excalidraw (behind the dev-auth guard
 * until wave 4), inside the app's session: the same load, access and error screens as the tldraw page
 * (board/BoardPage.tsx), the same top bar, dock and notices, and the canvas: the Excalidraw host with
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
import { useMe, useSession } from '../../auth/session.tsx'
import { blockedEditHint, isReadonlyRole, roleChangeNotice } from '../../board/access.ts'
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
import { isFocusLost } from '../../ui/focus.ts'
import { boardRegionName, SkipLink } from '../../ui/SkipLink.tsx'
import { LoadingScreen, MessageScreen, NoAccessScreen } from '../../ui/screens.tsx'
import {
  type CanvasFeatureContext,
  CanvasFeatureContextProvider,
  installCanvasFeatures,
} from '../api/feature.ts'
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import { ExcalidrawHost, type ExcalidrawHostProps, type HostWiring } from '../engine/ExcalidrawHost.tsx'
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
import { contentOf, dispatchContent } from './content.ts'
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
  me,
  board,
  role,
  workspace,
  onBoardChange,
  onRole,
  onAccessLost,
  onRetry,
  first,
}: SessionProps & { first: TicketResponse }) {
  const boardId = board.id
  const { refresh } = useSession()
  const { notices, notify, dismiss } = useNotices()
  const [sharing, setSharing] = useState<false | 'default' | 'request'>(false)
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const handlers = useRef({ onRole, onAccessLost, refresh })
  handlers.current = { onRole, onAccessLost, refresh }

  const [session] = useState(
    () =>
      new LobbyBoardSession({
        boardId,
        first,
        archived: board.status === 'archived',
        notices: { notify, dismiss },
        onTicket: (t) => handlers.current.onRole(t.role),
        onAccessLost: () => handlers.current.onAccessLost(),
        onSignedOut: () => void handlers.current.refresh(),
      }),
  )
  useEffect(() => () => session.dispose(), [session])
  const snap = useSyncExternalStore(
    (l) => session.subscribe(l),
    () => session.snapshot,
  )
  useRegistries(session.registries)
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
    rootRef.current?.setAttribute('aria-label', boardRegionName(board.title))
  }, [board.title])
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
  const announcedRole = useRef(role)
  useEffect(() => {
    const text = roleChangeNotice(announcedRole.current, role)
    announcedRole.current = role
    if (text) notify({ key: 'role-changed', text, testId: 'role-change-toast', timeoutMs: 8000 })
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
    // Excalidraw's own clipboard (elements copied on a board) is Excalidraw's to paste
    if (data.elements?.length) return true
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
          people={(max) =>
            featureHasPeople(session.registries) ? null : (
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
