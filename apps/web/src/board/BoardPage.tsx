import type { Board, BoardDetail, Me, TicketResponse } from '@draftroom/contracts'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { TLRemoteSyncError, useSync } from '@tldraw/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  computed,
  createUserId,
  defaultShapeUtils,
  type Editor,
  type TLComponents,
  type TLOnMountHandler,
  type TLUiOverrides,
  type TLUserStore,
  Tldraw,
  UserRecordType,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { api, isApiError, isNoAccess } from '../api/client.ts'
import { createAssetStore } from '../assets/asset-store.ts'
import { AssetMetaStore } from '../assets/meta-store.ts'
import { useMe, useSession } from '../auth/session.tsx'
import { FileCardShapeUtil } from '../file-card/FileCardShapeUtil.tsx'
import { DEV_AUTH_ENABLED, safeColor } from '../lib/identity.ts'
import type { BoardRole } from '../lib/permissions.ts'
import { useResource } from '../lib/useResource.ts'
import { LoadingScreen, MessageScreen, NoAccessScreen } from '../ui/screens.tsx'
import { isReadonlyRole } from './access.ts'
import { BoardContext, type BoardContextValue } from './board-context.ts'
import { EditingBadges } from './EditingBadges.tsx'
import { ExternalContentHandlers, IMAGE_HANDLER_LIMITS, watchImagePreview } from './ExternalContent.tsx'
import { NoticeRegion, useNotices } from './Notices.tsx'
import { getDraftroomPresence, holderName, parseLeaseDenied } from './presence.ts'
import { ShareDialog } from './ShareDialog.tsx'
import { SyncErrorScreen } from './SyncErrorScreen.tsx'
import { type ConnState, TopBar } from './TopBar.tsx'
import { createTicketUri } from './ticket.ts'

// Module level = referentially stable. useSync treats utils/assets/users/uri as effect dependencies
// (an unstable one reconnects in a loop), and <Tldraw> re-creates the editor when utils change.
const customShapeUtils = [FileCardShapeUtil]
const syncShapeUtils = [...defaultShapeUtils, ...customShapeUtils] // useSync does NOT add the defaults
const assetUrls = getAssetUrlsByImport() // self-hosted fonts/icons/translations (no CDN)

const components: TLComponents = {
  // Presence and sharing live in our top bar; the default people menu edits local tldraw
  // preferences, which are not the identity we sync.
  SharePanel: null,
  InFrontOfTheCanvas: EditingBadges,
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
    document.title = `${board.title} · Draftroom`
    return () => {
      document.title = 'Draftroom'
    }
  }, [board.title])

  if (accessLost) return <NoAccessScreen revoked />
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
  const [sharing, setSharing] = useState(false)
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

  const assets = useMemo(
    () =>
      createAssetStore({
        boardId,
        metaStore,
        onUploaded: (assetRecordId, meta) => {
          const ed = editorRef.current
          if (ed && lifetime.current)
            watchImagePreview(ed, metaStore, boardId, assetRecordId, meta, lifetime.current)
        },
      }),
    [boardId, metaStore],
  )

  const { id: userId, name: userName, color: userColor } = me.user
  const users = useMemo<TLUserStore>(
    () => ({
      // Only id, display name and color: tldraw persists user records into the board document.
      currentUser: computed('currentUser', () =>
        UserRecordType.create({
          id: createUserId(userId),
          name: userName,
          color: safeColor(userColor, userId),
        }),
      ),
    }),
    [userId, userName, userColor],
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
        onTicket: (t) => handlers.current.onTicket(t),
        onAccessLost: () => handlers.current.onAccessLost(),
        onSignedOut: () => handlers.current.onSignedOut(),
        origin: location,
      }),
    [boardId],
  )
  useEffect(() => () => ticketUri.cancel(), [ticketUri])
  const uri = ticketUri.uri

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
    uri,
    assets,
    users,
    shapeUtils: syncShapeUtils,
    getUserPresence: getDraftroomPresence,
    onCustomMessageReceived,
  })

  const syncError =
    store.status === 'error'
      ? String(store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message)
      : null
  // Access revoked while open: the sync server closes the session with FORBIDDEN (terminal).
  const lostAccess = syncError === 'FORBIDDEN' || syncError === 'NOT_FOUND'
  useEffect(() => {
    if (lostAccess) onAccessLost()
  }, [lostAccess, onAccessLost])

  const onMount = useCallback<TLOnMountHandler>((ed) => {
    editorRef.current = ed
    setEditor(ed)
    if (DEV_AUTH_ENABLED) window.editor = ed // e2e + debugging only, behind the local-dev guard
    return () => {
      editorRef.current = null
      setEditor(null)
      if (window.editor === ed) window.editor = undefined
    }
  }, [])

  // Viewers/commenters get a read-only editor. UI only: the sync server already marks their session
  // read-only and skips any write, this keeps tools and menus from offering edits.
  const readonly = isReadonlyRole(role, board.status)
  useEffect(() => {
    if (editor && readonly && !editor.getInstanceState().isReadonly) {
      editor.updateInstanceState({ isReadonly: true })
    }
  }, [editor, readonly])

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
          editor={editor}
          onRename={(t) => void rename(t)}
          onShare={() => setSharing(true)}
        />
        {conn === 'offline' && (
          <div className="dr-banner" data-testid="offline-banner" role="status">
            You're offline. Changes you make are kept in this tab only until the connection returns; reloading
            now would lose them.
          </div>
        )}
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
                components={components}
                overrides={overrides}
                onMount={onMount}
                {...IMAGE_HANDLER_LIMITS}
              >
                <ExternalContentHandlers />
              </Tldraw>
            </div>
          )}
        </main>
        <NoticeRegion notices={notices} onDismiss={dismiss} />
        {sharing && (
          <ShareDialog
            board={board}
            role={role}
            workspace={workspace}
            selfUserId={userId}
            onClose={() => setSharing(false)}
            onBoardChange={onBoardChange}
          />
        )}
      </div>
    </BoardContext.Provider>
  )
}
