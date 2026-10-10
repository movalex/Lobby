// M6-2 / M6-4 (wave M, PWR-4): what the board says while it shows this device's last copy of itself, before the
// room's state replaces it: "Showing your last copy · connecting", or offline "Offline · showing your copy from
// 14:32". Honest words only: never "Saved", never a claim that the copy is current.

import type { ReactNode } from 'react'
import { cachedOfflineLabel, SAVE_LABEL } from './copy.ts'
import './sync-quality.css'

export interface CachedCopyProps {
  /** when this device saved the copy */
  readonly savedAt: number
  /** the page is offline (no socket, or no network at all) */
  readonly offline: boolean
  /** changes queued offline on this device (not drawn on the copy yet) */
  readonly changes?: number
  /** drawn inside the layer (the skeleton's toolbar, so nothing moves when the board takes over) */
  readonly children?: ReactNode
}

/** The words, for the pill and for tests. */
export const cachedCopyText = (savedAt: number, offline: boolean, changes = 0): string =>
  offline ? cachedOfflineLabel(savedAt, undefined, changes) : SAVE_LABEL.cached

/** The layer over the canvas: a pill at the top, and nothing that takes a pointer. */
export function CachedCopy({ savedAt, offline, changes = 0, children }: CachedCopyProps) {
  return (
    <div className="lobby-cached-copy" data-testid="cached-copy" data-offline={offline || undefined}>
      <p className="lobby-cached-copy__pill" role="status" data-offline={offline || undefined}>
        <span className="dr-save__dot" aria-hidden="true" />
        <span data-testid="cached-copy-label">{cachedCopyText(savedAt, offline, changes)}</span>
      </p>
      {children}
    </div>
  )
}
