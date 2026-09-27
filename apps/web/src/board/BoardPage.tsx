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
import { createAssetStore } from '../assets/asset-store.ts'
import { AssetMetaStore } from '../assets/meta-store.ts'
import { FileCardShapeUtil } from '../file-card/FileCardShapeUtil.tsx'
import { colorForUser, DEV_AUTH_ENABLED, type DevIdentity } from '../lib/identity.ts'
import { boardPath } from '../lib/routing.ts'
import { BoardContext, type BoardContextValue } from './board-context.ts'
import { EditingBadges } from './EditingBadges.tsx'
import { ExternalContentHandlers, IMAGE_HANDLER_LIMITS, watchImagePreview } from './ExternalContent.tsx'
import { NoticeRegion, useNotices } from './Notices.tsx'
import { getDraftroomPresence, holderName, parseLeaseDenied } from './presence.ts'
import { SyncErrorScreen } from './SyncErrorScreen.tsx'
import { type ConnState, TopBar } from './TopBar.tsx'

// Module level = referentially stable. useSync treats utils/assets/users/uri as effect dependencies
// (an unstable one reconnects in a loop), and <Tldraw> re-creates the editor when utils change.
const customShapeUtils = [FileCardShapeUtil]
const syncShapeUtils = [...defaultShapeUtils, ...customShapeUtils] // useSync does NOT add the defaults
const assetUrls = getAssetUrlsByImport() // self-hosted fonts/icons/translations (no CDN)

const components: TLComponents = {
  // Presence lives in our top bar; the default people menu edits local tldraw preferences, which are
  // not the identity we sync.
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

export function BoardPage({ boardId, identity }: { boardId: string; identity: DevIdentity }) {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // A fresh key = a fresh useSync (new socket + store): the only way out of a terminal sync error.
  return (
    <BoardSession
      key={`${boardId}/${identity.userId}/${identity.role}/${attempt}`}
      boardId={boardId}
      identity={identity}
      onRetry={retry}
    />
  )
}

function BoardSession({
  boardId,
  identity,
  onRetry,
}: {
  boardId: string
  identity: DevIdentity
  onRetry(): void
}) {
  const { userId, role } = identity
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const { notices, notify, dismiss } = useNotices()

  // Created once per mounted session (the parent key covers board/identity). The abort signal is
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
        devUser: userId,
        metaStore,
        onUploaded: (assetRecordId, meta) => {
          const ed = editorRef.current
          if (ed && lifetime.current)
            watchImagePreview(ed, metaStore, boardId, assetRecordId, meta, lifetime.current)
        },
      }),
    [boardId, userId, metaStore],
  )

  const users = useMemo<TLUserStore>(
    () => ({
      // Only id, display name and color: tldraw persists user records into the board document.
      currentUser: computed('currentUser', () =>
        UserRecordType.create({ id: createUserId(userId), name: userId, color: colorForUser(userId) }),
      ),
    }),
    [userId],
  )

  // Called on every (re)connect attempt; in milestone 1 this fetches a short-lived signed ticket.
  const uri = useCallback(() => {
    const ws = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const q = new URLSearchParams({ devUser: userId })
    if (role === 'viewer') q.set('devRole', 'viewer')
    return `${ws}//${location.host}/connect/${encodeURIComponent(boardId)}?${q}`
  }, [boardId, userId, role])

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

  const onMount = useCallback<TLOnMountHandler>((ed) => {
    editorRef.current = ed
    setEditor(ed)
    if (DEV_AUTH_ENABLED) window.editor = ed // e2e + debugging only, same guard as dev identities
    return () => {
      editorRef.current = null
      setEditor(null)
      if (window.editor === ed) window.editor = undefined
    }
  }, [])

  const copyLink = useCallback(async () => {
    const url = `${location.origin}${boardPath(boardId)}`
    try {
      await navigator.clipboard.writeText(url)
      notify({ key: 'copy-link', text: 'Board link copied', timeoutMs: 2500 })
    } catch {
      notify({ key: 'copy-link', text: `Copy this link: ${url}`, timeoutMs: 10000 })
    }
  }, [boardId, notify])

  const board = useMemo<BoardContextValue>(
    () => ({ boardId, userId, role, metaStore, notify, dismiss }),
    [boardId, userId, role, metaStore, notify, dismiss],
  )

  const conn: ConnState =
    store.status === 'loading' ? 'connecting' : store.status === 'error' ? 'error' : store.connectionStatus

  return (
    <BoardContext.Provider value={board}>
      <div className="dr-board">
        <TopBar
          boardId={boardId}
          identity={identity}
          conn={conn}
          editor={editor}
          onCopyLink={() => void copyLink()}
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
          {store.status === 'error' && (
            <SyncErrorScreen
              reason={String(
                store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message,
              )}
              onRetry={onRetry}
            />
          )}
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
      </div>
    </BoardContext.Provider>
  )
}
