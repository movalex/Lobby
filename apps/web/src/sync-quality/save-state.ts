// The save indicator's vocabulary (WRK-03; docs/EXCALIDRAW-MIGRATION.md §2.5.7). Until wave 4 part 2 these
// types were the tldraw save tracker's (saveTracker.ts, useSaveStatus.ts); the Excalidraw board page's
// indicator (engineSave.ts, useEngineSaveStatus.ts) speaks the same states.

export type SaveState =
  | 'connecting' // first connect not finished
  // M6-2 (wave M): this device's last copy of the board is shown, read-only, until the first welcome replaces it
  // (never "Saved": nothing of this tab is confirmed then)
  | 'cached'
  | 'saved' // everything acknowledged + verified
  | 'saving' // local changes unsent, in flight, or being verified
  | 'offline' // disconnected, nothing unsaved
  | 'offline-pending' // disconnected with unsaved changes (kept in memory only)
  | 'rejected' // the server did not apply a local change (held for a moment)
  | 'error' // terminal socket error (4099); unsaved changes are lost
  | 'unsupported' // unknown protocol version: fail safe

/** `retrying`: UNAVAILABLE for 30 s on the engine (./engineSave.ts). */
export type DisplayState = SaveState | 'readonly' | 'retrying'

/** A change the server did not apply (the tldraw-era shape; the engine's rejects carry a code instead). */
export interface Rejection {
  at: number
  records: Array<{ id: string; typeName: string; kind: 'vetoed' | 'deleted-remotely' }>
  /** The last custom message from the server (e.g. text-lease-denied), if it arrived within 1 s. */
  serverMessage: unknown
}
