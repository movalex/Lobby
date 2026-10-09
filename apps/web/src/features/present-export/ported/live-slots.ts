// Where present-live (3c: features/present-export/live/ported/**) plugs into the ported presentation
// chrome, as the tldraw page's PresentOverlay rendered live/LiveUi.tsx's `LiveTop` and `LiveBarControls`
// and read `useLive(editor).presentingLive`. present-live provides them in its onMount with
// `providePresentLive(ctx.canvas, …)` and drives the presentation through `presenterOf(ctx.canvas)`
// (./controller.ts); until it does, the chrome shows no live controls and Exit always says "Exit".
import type { ComponentType } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'

export interface PresentLiveChrome {
  /** Above the slide: who presents, "Stop following" (live/LiveUi.tsx LiveTop). */
  readonly Top?: ComponentType<{ readonly ctx: CanvasFeatureContext }>
  /** In the control bar before Exit: "Present to everyone", "Hand over" (LiveBarControls). */
  readonly Bar?: ComponentType<{ readonly ctx: CanvasFeatureContext }>
  /** Reactive: this tab presents to everyone (Exit becomes "End", which ends it for everyone). */
  presentingLive(): boolean
  /** Reactive: `Top` draws its banner now (K3-4: the slide is fitted under it, ./insets.ts). */
  banner?(): boolean
  /** Reactive (wave L, L5-1): the banner has the run of show's strip under it, one row taller (./insets.ts). */
  agenda?(): boolean
  /** K3-5: a presentation was just started here with the Present button or its shortcut, to everyone. */
  onLocalStart?(): void
  /**
   * Wave K.1 (K3-5, follow-up 3): how many other people a Present here would go live to (0: nobody, or this
   * person may not present to everyone, or someone already presents). Above 0, Present asks first.
   */
  audience?(): number
}

const slots = new WeakMap<LobbyCanvas, Atom<PresentLiveChrome | null>>()

/** The live chrome provided for `canvas` (reactive), or null. */
export function presentLiveOf(canvas: LobbyCanvas): Atom<PresentLiveChrome | null> {
  let slot = slots.get(canvas)
  if (!slot) {
    slot = atom<PresentLiveChrome | null>('lobby-present-live', null)
    slots.set(canvas, slot)
  }
  return slot
}

/** present-live's chrome for `canvas` (one provider); returns the removal. */
export function providePresentLive(canvas: LobbyCanvas, chrome: PresentLiveChrome): () => void {
  const slot = presentLiveOf(canvas)
  slot.set(chrome)
  return () => {
    if (slot.get() === chrome) slot.set(null)
  }
}
