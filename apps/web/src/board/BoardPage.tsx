import {
  type Board,
  type BoardDetail,
  GUEST_NAME_SUFFIX,
  type Me,
  type TicketResponse,
} from '@draftroom/contracts'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { TLRemoteSyncError, useSync } from '@tldraw/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  atom,
  computed,
  createCachedUserResolve,
  createUserId,
  defaultShapeUtils,
  type Editor,
  type TLComponents,
  type TLEventInfo,
  type TLOnMountHandler,
  type TLStore,
  type TLUiOverrides,
  type TLUser,
  type TLUserStore,
  Tldraw,
  UserRecordType,
  useValue,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { api, isApiError, isNoAccess } from '../api/client.ts'
import { createAssetStore } from '../assets/asset-store.ts'
import { AssetMetaStore } from '../assets/meta-store.ts'
import { useMe, useSession } from '../auth/session.tsx'
import { type BoardEvents, createBoardEvents } from '../features/events.ts'
import {
  FeatureDock,
  FeatureOverlays,
  mergeFeatureProps,
  useFeatureMounts,
} from '../features/FeatureHost.tsx'
import { BOARD_FEATURES } from '../features/registry.ts'
import type { FeatureContext } from '../features/types.ts'
import { FileCardShapeUtil } from '../file-card/FileCardShapeUtil.tsx'
import { DEV_AUTH_ENABLED, safeColor } from '../lib/identity.ts'
import type { BoardRole } from '../lib/permissions.ts'
import { boardPath, setLeaveGuard } from '../lib/routing.ts'
import { useResource } from '../lib/useResource.ts'
import { rejectionNotice, undoNotice } from '../sync-quality/copy.ts'
import { installPerPropUndo } from '../sync-quality/perPropUndo.ts'
import { installRebaseSelectionGuard } from '../sync-quality/rebaseGuard.ts'
import { createTrackedConnect } from '../sync-quality/saveTracker.ts'
import { trackUploads } from '../sync-quality/uploads.ts'
import { useSaveStatus } from '../sync-quality/useSaveStatus.ts'
import { LoadingScreen, MessageScreen, NoAccessScreen } from '../ui/screens.tsx'
import { blockedEditHint, isReadonlyRole, roleChangeNotice } from './access.ts'
import { BoardContext, type BoardContextValue } from './board-context.ts'
import { EditingBadges } from './EditingBadges.tsx'
import { ExternalContentHandlers, IMAGE_HANDLER_LIMITS, watchImagePreview } from './ExternalContent.tsx'
import { NoticeRegion, useNotices } from './Notices.tsx'
import { getDraftroomPresence, holderName, parseLeaseDenied } from './presence.ts'
import { ShareDialog } from './ShareDialog.tsx'
import { SyncErrorScreen } from './SyncErrorScreen.tsx'
import { BoardAccount, type ConnState, TopBar } from './TopBar.tsx'
import { createTicketUri } from './ticket.ts'

// Module level = referentially stable. useSync treats utils/assets/users/uri as effect dependencies
// (an unstable one reconnects in a loop), and <Tldraw> re-creates the editor when utils change.
const customShapeUtils = [FileCardShapeUtil]
const syncShapeUtils = [...defaultShapeUtils, ...customShapeUtils] // useSync does NOT add the defaults
const assetUrls = getAssetUrlsByImport() // self-hosted fonts/icons/translations (no CDN)
/** Longest an in-app navigation waits for this board's last changes to be acknowledged. */
const LEAVE_WAIT_MS = 5_000

const components: TLComponents = {
  // Presence and sharing live in our top bar; the default people menu edits local tldraw
  // preferences, which are not the identity we sync.
  SharePanel: null,
  InFrontOfTheCanvas: EditingBadges,
}

/**
 * The name a note's attribution label shows (SEAM-01). tldraw draws only the first word of it
 * (NoteShapeUtil: `name.split(' ')[0]`), so a guest who calls himself "Alice" would read exactly like
 * Alice the member. A guest's name (the ticket's "Alice (guest)", pinned by the sync server) keeps its
 * marker there: its spaces become no-break spaces, which that split leaves alone. Members keep
 * tldraw's first-name label; the tooltip shows the same name.
 */
function noteAttributionUser(user: TLUser): TLUser {
  if (!user.name.endsWith(GUEST_NAME_SUFFIX)) return user
  return { ...user, name: user.name.replace(/ /g, '\u00a0') }
}

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}
async function insertFiles(editor: Editor) {
  const files = await pickFiles()
  if (!files.length) return
  editor.markHistoryStoppingPoint('insert files')
  await editor.putExternalContent({ type: 'files', files, point: editor.getViewportPageBounds().center })
}

/** The default media picker only offers image/video types; ours accepts any file (PDFs, attachments). */
const overrides: TLUiOverrides = {
  tools(editor, tools) {
    const asset = tools.asset
    if (asset) tools.asset = { ...asset, onSelect: () => void insertFiles(editor) }
    return tools
  },
  actions(editor, actions) {
    const insert = actions['insert-media']
    if (insert) actions['insert-media'] = { ...insert, onSelect: () => void insertFiles(editor) }
    return actions
  },
  translations: { en: { 'tool.media': 'Insert file', 'action.insert-media': 'Insert file' } },
}

// Feature slots merged once at module level: <Tldraw> must get referentially stable props.
const featureProps = mergeFeatureProps(BOARD_FEATURES, { overrides, components })

declare global {
  interface Window {
    editor?: Editor
  }
}

/** /b/:bid — loads the board (and the caller's role) from the API, then opens the canvas. */
export function BoardPage({ boardId }: { boardId: string }) {
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
  return <BoardShell key={boardId} initial={detail.data} />
}

function BoardShell({ initial }: { initial: BoardDetail }) {
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

  // The request form starts from the role they had (PRI-16): most people want it back.
  if (accessLost) return <NoAccessScreen revoked previousRole={role} />
  // A fresh key = a fresh useSync (new socket + store): the only way out of a terminal sync error.
  return (
    <BoardSession
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

function BoardSession({
  me,
  board,
  role,
  workspace,
  onBoardChange,
  onRole,
  onAccessLost,
  onRetry,
}: {
  me: Me
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  onBoardChange(board: Board): void
  onRole(role: BoardRole): void
  onAccessLost(): void
  onRetry(): void
}) {
  const boardId = board.id
  const { refresh } = useSession()
  const [editor, setEditor] = useState<Editor | null>(null)
  // Open Share dialog; 'request' scrolls to (and focuses) its "Need more access?" form.
  const [sharing, setSharing] = useState<false | 'default' | 'request'>(false)
  // The sharing badge (features/sharing) opens the Share dialog through this window event.
  useEffect(() => {
    const open = () => setSharing('default')
    window.addEventListener('draftroom:open-share', open)
    return () => window.removeEventListener('draftroom:open-share', open)
  }, [])
  const [activePanel, setActivePanel] = useState<string | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const { notices, notify, dismiss } = useNotices()

  // Created once per mounted session (the parent key covers board/user). The abort signal is
  // (re)created in an effect so StrictMode's simulated unmount/remount does not leave it aborted.
  const metaStore = useMemo(() => new AssetMetaStore(), [])
  const lifetime = useRef<AbortSignal | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller.signal
    return () => {
      controller.abort()
      metaStore.stopAll()
    }
  }, [metaStore])

  // One server-sent event stream per mounted board session, shared by all features. Created in an
  // effect (not useMemo): StrictMode's simulated unmount would otherwise close the memoized stream for
  // good (close() is permanent) and leak a second, unlistened EventSource from the double render.
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

  // Uploads are counted so the save indicator does not say "Saved" while an image's bytes are
  // still on their way (tldraw puts its shape on the board first).
  const uploads = useMemo(
    () =>
      trackUploads(
        createAssetStore({
          boardId,
          metaStore,
          onUploaded: (assetRecordId, meta) => {
            const ed = editorRef.current
            if (ed && lifetime.current)
              watchImagePreview(ed, metaStore, boardId, assetRecordId, meta, lifetime.current)
          },
        }),
      ),
    [boardId, metaStore],
  )
  const assets = uploads.store
  const uploading = useValue('dr-uploads-in-flight', () => uploads.inFlight.get(), [uploads])

  // Viewers/commenters get a read-only editor (UI only: the sync server marks their session read-only
  // and skips any write).
  const readonly = isReadonlyRole(role, board.status)
  // Read by the currentUser derivation below. An atom, not a dependency of `users`: that object is a
  // useSync effect dependency, and a new one would reconnect.
  const [readonlyAtom] = useState(() => atom('dr-canvas-readonly', readonly))
  useEffect(() => {
    readonlyAtom.set(readonly)
  }, [readonlyAtom, readonly])

  const { id: userId, name: userName, color: userColor } = me.user
  const identity = useMemo(
    () => ({ id: userId, name: userName, color: safeColor(userColor, userId) }),
    [userId, userName, userColor],
  )
  // Who the latest connection ticket says this is. Every (re)connect fetches a ticket first, so this
  // is the ticket of the socket being opened. The sync server accepts this session's user record only
  // with the ticket's name and color (apps/sync user-records.ts), and a long guest name is shortened
  // there ("Alexandr… (guest)"), so the account's own name would get the tab closed. An atom, like
  // readonlyAtom, so a new ticket never reconnects.
  const [ticketUserAtom] = useState(() =>
    atom<TicketResponse['user'] | null>('dr-ticket-user', null, {
      isEqual: (a, b) => a === b || (!!a && !!b && a.id === b.id && a.name === b.name && a.color === b.color),
    }),
  )
  // The board's store once the editor has mounted: resolve() below reads user records from it.
  const [storeAtom] = useState(() => atom<TLStore | null>('dr-attribution-store', null))
  const users = useMemo<TLUserStore>(
    () => ({
      // Only id, display name and color: tldraw persists user records into the board document.
      // Read-only roles get none: the editor would write it, the server would discard it, and tldraw
      // 5.4.2 re-writes it forever (~14 pushes/s; docs/research/saved-indicator.md §7). Their name and
      // color reach others through presence (getUserPresence below) instead. None before the first
      // ticket either (the editor only mounts once its socket has synced).
      currentUser: computed('currentUser', () => {
        const ticketUser = ticketUserAtom.get()
        if (readonlyAtom.get() || !ticketUser) return null
        return UserRecordType.create({
          id: createUserId(ticketUser.id),
          name: ticketUser.name,
          // the server's presenceIdentity makes the same choice for a color that is not plain hex
          color: safeColor(ticketUser.color, ticketUser.id),
        })
      }),
      // Note attribution names (Editor.getAttributionDisplayName asks this first, then the store):
      // the synced user records, which the sync server binds to each person's ticket (G-R8), with a
      // guest's "(guest)" marker kept in the label.
      resolve: createCachedUserResolve((uid) => {
        const user = storeAtom.get()?.get(createUserId(uid))
        return user ? noteAttributionUser(user) : null
      }),
    }),
    [readonlyAtom, ticketUserAtom, storeAtom],
  )
  // useSync keeps this in an atom (useReactiveEvent), so a new function does not reconnect.
  const getUserPresence = useCallback(
    (s: TLStore, user: TLUser) => getDraftroomPresence(s, user, identity),
    [identity],
  )

  // The ticket callbacks change identity every render; the uri function must not (it is a useSync
  // effect dependency: a new one would reconnect). Route them through a ref.
  const handlers = useRef({ onTicket: (_t: TicketResponse) => {}, onAccessLost, onSignedOut: () => {} })
  handlers.current = {
    onTicket: (t) => onRole(t.role),
    onAccessLost,
    onSignedOut: () => void refresh(),
  }
  const ticketUri = useMemo(
    () =>
      createTicketUri({
        boardId,
        fetchTicket: (bid) => api.boardTicket(bid),
        onTicket: (t) => {
          // Only a ticket a socket connects with (not the role re-read below): it is what the server pins.
          ticketUserAtom.set(t.user)
          handlers.current.onTicket(t)
        },
        onAccessLost: () => handlers.current.onAccessLost(),
        onSignedOut: () => handlers.current.onSignedOut(),
        origin: location,
      }),
    [boardId, ticketUserAtom],
  )
  useEffect(() => () => ticketUri.cancel(), [ticketUri])
  // The save tracker wraps tldraw's own socket adapter (docs/research/saved-indicator.md). Its uri
  // function is still createTicketUri's: every (re)connect fetches a fresh ticket. Memoized on the
  // (stable) ticketUri: `connect` is a useSync effect dependency.
  const tracked = useMemo(() => createTrackedConnect(ticketUri.uri), [ticketUri])

  const onCustomMessageReceived = useCallback(
    (data: unknown) => {
      const denied = parseLeaseDenied(data)
      if (!denied) return
      const who = holderName(editorRef.current?.getCollaborators() ?? [], denied.holderUserId)
      notify({
        key: `lease:${denied.shapeId}`,
        text: `${who} is editing this text`,
        testId: 'lease-toast',
        timeoutMs: Math.max(3000, Math.min(denied.expiresInMs ?? 4000, 8000)),
      })
    },
    [notify],
  )

  const store = useSync({
    connect: tracked.connect,
    assets,
    users,
    shapeUtils: syncShapeUtils,
    getUserPresence,
    onCustomMessageReceived,
  })
  const save = useSaveStatus(store, tracked.current, { uploading })

  // In-app navigation away from the board (Back to the workspace, a notification for another board,
  // the browser's Back) unmounts the sync client, which drops the changes it has not sent yet: alone
  // on a board, tldraw sends at most once a second. Hold the navigation until everything is
  // acknowledged, bounded so a stuck push cannot trap anyone here. (Offline changes cannot be saved
  // by waiting; the offline banner says so.)
  useEffect(() => {
    const settling = () =>
      uploads.inFlight.get() > 0 || tracked.current.get()?.getSnapshot().state === 'saving'
    return setLeaveGuard((to) => {
      if (new URL(to, location.origin).pathname === boardPath(boardId)) return
      // Store listeners (the sync client's, the tracker's) otherwise hear of a change made in this
      // very task only on the next frame, after the unmount.
      editorRef.current?.store._flushHistory()
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
  }, [boardId, tracked, uploads])

  // A change the server did not apply (veto, read-only, deleted by someone else): say so once.
  // (The tracker keeps one Rejection object per event, so this runs when one starts or gains detail.)
  const rejection = save.raw.rejection
  const sessionReadonly = save.raw.readonly
  useEffect(() => {
    if (!rejection) return
    const text = rejectionNotice(rejection, sessionReadonly)
    if (text) notify({ key: 'save-rejected', text, tone: 'error', testId: 'save-rejected-toast' })
    else dismiss('save-rejected') // the lease toast already explains it
  }, [rejection, sessionReadonly, notify, dismiss])

  const syncError =
    store.status === 'error'
      ? String(store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message)
      : null
  // Access revoked while open: the sync server closes the session with FORBIDDEN (terminal).
  const lostAccess = syncError === 'FORBIDDEN' || syncError === 'NOT_FOUND'
  useEffect(() => {
    if (lostAccess) onAccessLost()
  }, [lostAccess, onAccessLost])

  const onMount = useCallback<TLOnMountHandler>(
    (ed) => {
      editorRef.current = ed
      setEditor(ed)
      if (DEV_AUTH_ENABLED) window.editor = ed // e2e + debugging only, behind the local-dev guard
      // Undo/redo reverse only this user's own changes (WRK-05, docs/research/undo-per-prop.md).
      const uninstallUndo = installPerPropUndo(ed, {
        onReplay: (report) => {
          const text = undoNotice(report)
          if (text) notify({ key: 'undo-skip', text, testId: 'undo-notice' })
        },
        // The server lease vetoes the WHOLE record op (lease.ts), so an undo that reverts text a
        // collaborator is editing would also lose its move/resize. Leave that text alone instead, and
        // its "last edited by" with it: the server refuses a name without the text it goes with
        // (apps/sync attribution.ts, SEAM-01).
        isFieldLocked: (rec, path) =>
          (path === 'props.richText' || path === 'props.textLastEditedBy') &&
          ed.getCollaborators().some((c) => c.meta?.editingShapeId === rec.id),
      })
      // A sync rebase that removes and re-adds a shape of ours must not wipe the redo stack.
      const uninstallRebaseGuard = installRebaseSelectionGuard(ed)
      // Note attribution names are read from this store (users.resolve above).
      storeAtom.set(ed.store)
      return () => {
        if (storeAtom.get() === ed.store) storeAtom.set(null)
        uninstallRebaseGuard()
        uninstallUndo()
        editorRef.current = null
        setEditor(null)
        if (window.editor === ed) window.editor = undefined
      }
    },
    [notify, storeAtom],
  )

  // Keeps tools and menus from offering edits to read-only roles (the server enforces).
  useEffect(() => {
    if (editor && readonly && !editor.getInstanceState().isReadonly) {
      editor.updateInstanceState({ isReadonly: true })
    }
  }, [editor, readonly])

  const featureCtx = useMemo<FeatureContext | null>(
    () =>
      editor && events
        ? {
            editor,
            board,
            role,
            me,
            workspace,
            api,
            events,
            notify,
            dismiss,
            openPanel: setActivePanel,
            activePanel,
          }
        : null,
    [editor, board, role, me, workspace, events, notify, dismiss, activePanel],
  )
  useFeatureMounts(BOARD_FEATURES, featureCtx)

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

  // PRI-09b: when my role changes while the board is open (a grant, an approved request, a removed
  // link), say so. Roles arrive with each sync ticket; a sharing event also re-reads the role now, and
  // applies a LOWER one at once (a higher one waits for the socket to reconnect with it, so the
  // editor never writes as an editor on a session the server still treats as read-only).
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
          const rank = { viewer: 1, commenter: 2, editor: 3, owner: 4 }
          if (rank[t.role] < rank[roleNow.current]) handlers.current.onTicket(t)
        },
        () => {}, // no access any more: the sync server closes the session and says so
      )
    })
  }, [events, boardId])

  // PRI-08: on a read-only board, the first edit someone tries (dragging, double-clicking or
  // deleting a shape) explains why nothing happened, once, with a way to ask for more.
  const hinted = useRef(false)
  useEffect(() => {
    if (!editor || !readonly || board.status !== 'active') return
    const key = `draftroom:blocked-edit-hint:${boardId}`
    try {
      if (sessionStorage.getItem(key)) hinted.current = true
    } catch {}
    let pressedShape = false
    // Only with the select tool: a drag with the hand tool, the comment tool or a vote is not an edit.
    const overShape = () =>
      editor.getCurrentToolId() === 'select' &&
      !!editor.getShapeAtPoint(editor.inputs.getCurrentPagePoint(), { hitInside: true, margin: 0 })
    const typing = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    }
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
          action: { label: 'Request', testId: 'blocked-edit-request', onClick: () => setSharing('request') },
        }),
      )
    }
    const onEvent = (info: TLEventInfo) => {
      if (hinted.current) return
      if (info.type === 'pointer') {
        // Canvas pointer events say target "canvas" even over a shape: hit-test ourselves.
        if (info.name === 'pointer_down') pressedShape = info.button === 0 && overShape()
        else if (info.name === 'pointer_up') pressedShape = false
        else if (info.name === 'pointer_move' && pressedShape && editor.inputs.getIsDragging()) blocked()
      } else if (info.type === 'click' && info.name === 'double_click' && overShape()) {
        blocked()
      } else if (
        info.type === 'keyboard' &&
        info.name === 'key_down' &&
        (info.key === 'Delete' || info.key === 'Backspace') &&
        editor.getSelectedShapeIds().length > 0 &&
        !typing()
      ) {
        blocked()
      }
    }
    editor.on('event', onEvent)
    return () => {
      editor.off('event', onEvent)
    }
  }, [editor, readonly, board.status, boardId, userId, role, notify])

  const context = useMemo<BoardContextValue>(
    () => ({ boardId, userId, role, metaStore, notify, dismiss }),
    [boardId, userId, role, metaStore, notify, dismiss],
  )

  const conn: ConnState =
    store.status === 'loading' ? 'connecting' : store.status === 'error' ? 'error' : store.connectionStatus

  return (
    <BoardContext.Provider value={context}>
      <div className="dr-board" data-board-id={boardId} data-role={role}>
        <TopBar
          board={board}
          role={role}
          workspace={workspace}
          selfUserId={userId}
          conn={conn}
          save={{ state: save.state, rejection, readonly: save.raw.readonly, uploading, role }}
          editor={editor}
          onRename={(t) => void rename(t)}
          onShare={() => setSharing('default')}
          onRequestAccess={() => setSharing('request')}
          features={BOARD_FEATURES}
          featureCtx={featureCtx}
        />
        {conn === 'offline' && (
          <div className="dr-banner" data-testid="offline-banner" role="status">
            You're offline. Changes you make are kept in this tab only until the connection returns; reloading
            now would lose them.
          </div>
        )}
        <div className="dr-board__body">
          <FeatureDock features={BOARD_FEATURES} ctx={featureCtx} />
          <main className="dr-board__canvas" aria-label="Board canvas">
            {store.status === 'loading' && (
              <div className="dr-screen" data-testid="sync-loading">
                <span className="dr-spinner" aria-hidden="true" />
                <p>Connecting to board…</p>
              </div>
            )}
            {syncError !== null && !lostAccess && <SyncErrorScreen reason={syncError} onRetry={onRetry} />}
            {store.status === 'synced-remote' && (
              <div className="dr-board__editor">
                <Tldraw
                  store={store.store}
                  shapeUtils={customShapeUtils}
                  assetUrls={assetUrls}
                  components={featureProps.components}
                  overrides={featureProps.overrides}
                  options={featureProps.options}
                  onMount={onMount}
                  {...IMAGE_HANDLER_LIMITS}
                >
                  <ExternalContentHandlers />
                  <FeatureOverlays features={BOARD_FEATURES} ctx={featureCtx} />
                </Tldraw>
              </div>
            )}
          </main>
        </div>
        <NoticeRegion notices={notices} onDismiss={dismiss} />
        <BoardAccount />
        {sharing && (
          <ShareDialog
            board={board}
            role={role}
            workspace={workspace}
            selfUserId={userId}
            focus={sharing === 'request' ? 'request' : undefined}
            onClose={() => setSharing(false)}
            onBoardChange={onBoardChange}
          />
        )}
      </div>
    </BoardContext.Provider>
  )
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
