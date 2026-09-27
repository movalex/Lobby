// F8: locking a frame freezes everything inside it, silently. When someone clicks or drags a shape that
// is locked, or sits inside a locked frame (or group), canvas-ux says so next to it and offers to
// unlock. Pure message logic; the wiring is locked-hint-runtime.ts, the bar is in Overlay.tsx.

export interface LockChainLike {
  /** Shape id. */
  id: string
  type: string
  isLocked: boolean
  /** Frame name (frames only). */
  name?: string
}

/**
 * The shape whose lock stops `chain[0]`: the shape itself when it is locked, else its nearest locked
 * ancestor. `chain` is the hit shape followed by its ancestors, nearest first. Null when nothing is locked.
 */
export function lockSource<T extends LockChainLike>(chain: readonly T[]): T | null {
  for (const s of chain) if (s.isLocked) return s
  return null
}

/** The hint shown for a hit on `hit` whose lock comes from `source`. */
export function lockedHintMessage(hit: LockChainLike, source: LockChainLike, isMac: boolean): string {
  const keys = `${isMac ? '⌘⇧L' : 'Ctrl+Shift+L'} or right-click → Unlock all`
  if (source.id === hit.id) return `Locked. ${keys}`
  if (source.type === 'frame') {
    const name = source.name?.trim()
    return `Locked. Inside locked frame ${name ? `"${name}"` : '(untitled)'}. ${keys}`
  }
  return `Locked. Inside a locked ${source.type === 'group' ? 'group' : 'shape'}. ${keys}`
}

/** Label of the hint's unlock button. */
export function unlockLabel(source: LockChainLike): string {
  return source.type === 'frame' ? 'Unlock frame' : source.type === 'group' ? 'Unlock group' : 'Unlock'
}
