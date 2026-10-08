// OWNER: 3i. The board's focus ring (the early wave-5 review W5-45, WCAG 2.4.7): while the keyboard is on
// the board (it got there by Tab, F6, "Skip to canvas", or Escape out of an editor the keyboard got to;
// the rule is ./focus-ring.ts, K2-1, fed by ./index.tsx `nameTheCanvas`), a ring is drawn just inside the
// canvas's edge. An outline on the engine's own container would be painted under its canvases, so the ring
// is a screen overlay layer (above the drawing, below the chrome) that takes no pointer events. Hidden in
// focus mode (presenting), as the chrome is.
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { atom, useValue } from '../../../lib/signals.ts'

/** The keyboard is on the board, and it came there by the keyboard. */
export const keyboardFocus = atom('a11y.keyboard-focus', false)

export function FocusRing(_props: { readonly ctx: CanvasFeatureContext }) {
  const on = useValue(keyboardFocus)
  if (!on) return null
  return <div className="dr-a11y-focus-ring" data-testid="canvas-focus-ring" aria-hidden="true" />
}
