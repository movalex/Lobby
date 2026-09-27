import type { RemoteTLStoreWithStatus } from '@tldraw/sync'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type Atom, useValue } from 'tldraw'
import type { SaveSnapshot, SaveState, SaveTracker } from './saveTracker.ts'

export type DisplayState = SaveState | 'readonly'

const CONNECTING: SaveSnapshot = {
  state: 'connecting',
  readonly: false,
  inFlight: 0,
  unsent: false,
  offlineChanges: false,
  verifying: 0,
  rejection: null,
  lastSavedAt: null,
  errorReason: null,
}
const noSubscribe = () => () => {}
const connecting = () => CONNECTING

export interface SaveStatusOptions {
  /** Keep showing "Saving…" this long after everything is acknowledged (bursts don't flicker). */
  settleMs?: number
  /** Once shown, "Saving…" stays at least this long. */
  minVisibleMs?: number
  /** This tab's file uploads in flight (uploads.ts): not saved until their bytes are on the server. */
  uploading?: number
}

/**
 * Display status for the save indicator. `raw` is the tracker's exact state; `state` only ever
 * delays LEAVING 'saving' (never delays entering it, which would briefly claim "Saved" falsely).
 */
export function useSaveStatus(
  sync: RemoteTLStoreWithStatus,
  current: Atom<SaveTracker | null>,
  { settleMs = 250, minVisibleMs = 500, uploading = 0 }: SaveStatusOptions = {},
): { state: DisplayState; raw: SaveSnapshot } {
  const tracker = useValue('save tracker', () => current.get(), [current])
  const store = sync.status === 'synced-remote' ? sync.store : undefined
  useEffect(() => {
    if (tracker && store && store.id === tracker.storeId) return tracker.attachStore(store)
  }, [tracker, store])
  const raw = useSyncExternalStore(
    tracker ? tracker.subscribe : noSubscribe,
    tracker ? tracker.getSnapshot : connecting,
  )

  let state: DisplayState = sync.status === 'error' ? 'error' : raw.state
  if (state === 'saved' && uploading > 0) state = 'saving'
  if (state === 'saved' && raw.readonly) state = 'readonly'

  const [held, setHeld] = useState(false)
  const since = useRef<number | null>(null)
  useEffect(() => {
    if (state === 'saving') {
      since.current ??= performance.now()
      setHeld(true)
      return
    }
    if (!held) return
    if (state !== 'saved' && state !== 'readonly') {
      since.current = null
      setHeld(false)
      return
    }
    const shown = performance.now() - (since.current ?? 0)
    const t = setTimeout(
      () => {
        since.current = null
        setHeld(false)
      },
      Math.max(settleMs, minVisibleMs - shown),
    )
    return () => clearTimeout(t)
  }, [state, held, settleMs, minVisibleMs])

  // Leaving the page with unacknowledged changes loses them (offline edits live in memory only).
  const unsafe =
    uploading > 0 ||
    raw.state === 'saving' ||
    raw.state === 'offline-pending' ||
    (raw.state === 'error' && raw.offlineChanges)
  useEffect(() => {
    if (!unsafe) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', onBeforeUnload)
    return () => removeEventListener('beforeunload', onBeforeUnload)
  }, [unsafe])

  return { state: held && (state === 'saved' || state === 'readonly') ? 'saving' : state, raw }
}
