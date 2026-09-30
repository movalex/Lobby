// OWNER: 3f. "Is the board being presented?" on the Excalidraw page: present-export marks a running
// presentation on <html> (../presenting.ts, data-dr-presenting) on the tldraw board; on this page present
// mode is the canvas's focus mode (`settings.focusMode`, docs/EXCALIDRAW-CONTRACTS.md §3). Either counts.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { isPresentingNow, usePresenting } from '../presenting.ts'

/** Reactive: presenting (the <html> mark or the canvas's focus mode). */
export function usePresentingHere(canvas: LobbyCanvas): boolean {
  const marked = usePresenting()
  const focus = useValue('dr-wk-focus-mode', () => canvas.settings.get().focusMode, [canvas])
  return marked || focus
}

/** Presenting right now (outside React). */
export function isPresentingHere(canvas: LobbyCanvas): boolean {
  if (isPresentingNow()) return true
  try {
    return canvas.settings.get().focusMode
  } catch {
    return false
  }
}
