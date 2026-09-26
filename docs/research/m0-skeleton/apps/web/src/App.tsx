import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { TLRemoteSyncError, useSync } from '@tldraw/sync'
import { useMemo } from 'react'
import {
  computed,
  createUserId,
  defaultShapeUtils,
  type Editor,
  getDefaultUserPresence,
  type TLAssetStore,
  type TLUserStore,
  Tldraw,
  UserRecordType,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { FileCardShapeUtil } from './FileCardShapeUtil.tsx'

const SYNC_URL = import.meta.env.VITE_SYNC_URL ?? 'ws://localhost:5858'
const params = new URLSearchParams(location.search)
const BOARD_ID = params.get('room') ?? 'default-board'
const DEV_USER = params.get('user') ?? 'dev-user' // DEV ONLY

// Module-level = referentially stable. useSync treats these as effect deps.
const customShapeUtils = [FileCardShapeUtil]
const syncShapeUtils = [...defaultShapeUtils, ...customShapeUtils] // useSync does NOT add defaults
const assetUrls = getAssetUrlsByImport()
async function getSyncUri() {
  // called on every (re)connect: fetch a short-lived ticket here in the real app
  return `${SYNC_URL}/connect/${encodeURIComponent(BOARD_ID)}?devUser=${encodeURIComponent(DEV_USER)}`
}
const assets: TLAssetStore = {
  async upload() {
    throw new Error('uploads not wired in this skeleton')
  },
  resolve: (asset) => asset.props.src,
}

declare global {
  interface Window {
    editor?: Editor
  }
}

export function App() {
  const users = useMemo<TLUserStore>(
    () => ({
      currentUser: computed('currentUser', () =>
        UserRecordType.create({ id: createUserId(DEV_USER), name: DEV_USER, color: '#1971c2' }),
      ),
    }),
    [],
  )
  const store = useSync({
    uri: getSyncUri,
    assets,
    users,
    shapeUtils: syncShapeUtils,
    getUserPresence(s, user) {
      const p = getDefaultUserPresence(s, user)
      return p && { ...p, meta: { app: 'draftroom' } }
    },
  })
  if (store.status === 'loading') return <div data-testid="sync-loading">Connecting…</div>
  if (store.status === 'error') {
    const reason = store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message
    return <div data-testid="sync-error">{String(reason)}</div>
  }
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div data-testid="conn" style={{ position: 'absolute', zIndex: 1000, left: 8, bottom: 8 }}>
        {store.connectionStatus}
      </div>
      <Tldraw
        store={store.store}
        shapeUtils={customShapeUtils}
        assetUrls={assetUrls}
        onMount={(editor) => {
          window.editor = editor
        }}
      />
    </div>
  )
}
