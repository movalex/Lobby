// OWNER: 3c. The seam between present mode (3e, features/present-export/ported) and present-to-everyone
// (3c, this folder) on the Excalidraw board page. The tldraw page handed the live controller its presenter
// in one call (present-export/index.tsx `mountLive(ctx, controller.presenter)`); here the two features are
// separate CANVAS_FEATURES entries with separate owners, so present mode PROVIDES its presenter on the board's
// registries and present-live mounts on it:
//
//   // 3e, in the present-export feature's onMount:
//   const unprovide = provideLivePresenter(ctx.registries, presenter)
//
// The presenter below is the part of the tldraw page's `Presenter` (present-session.ts) the live controller
// uses, with element ids for slides (the api's `shape:<id>` refs are converted here, at its edge) and a
// lib/signals signal for the state. 3e also renders `<LiveTop ctx>` and `<LiveBarControls ctx>` (./LiveUi.tsx)
// in its presentation chrome, as the tldraw page's PresentOverlay does, and marks small menus with
// PRESENT_POPUP_ATTR (Esc sends them PRESENT_POPUP_CLOSE instead of ending the presentation).

import type { FeatureRegistries } from '../../../../canvas/api/index.ts'
import { type Atom, atom, type Signal } from '../../../../lib/signals.ts'

/** The tldraw page's present-session.ts values: the DOM contract with the presentation chrome. */
export const PRESENT_POPUP_ATTR = 'data-present-popup'
export const PRESENT_POPUP_CLOSE = 'dr-present-popup-close'

export type PresentRole = 'presenter' | 'follower'

export interface PresentLeader {
  userId: string
  name: string
}

/** Why a presentation ended here: this person (Esc, Exit), the live presentation (remote), or leaving the board. */
export type StopReason = 'local' | 'remote' | 'unmount'

export interface StopInfo {
  role: PresentRole
  reason: StopReason
}

export interface LivePresenterState {
  role: PresentRole
  /** Who presents, while following a live presentation. */
  leader: PresentLeader | null
}

export type StartResult = { ok: true } | { ok: false; reason: 'no-frames' | 'all-skipped' | 'already' }

/** What present-live needs of present mode (3e implements it). Slide ids are element ids. */
export interface LivePresenter {
  /** null when not presenting; reactive (lib/signals) */
  readonly state: Signal<LivePresenterState | null>
  /** The slide on screen: its frame's element id, its index and the slide count. */
  current(): { index: number; slideId: string | null; count: number }
  isPresenting(): boolean
  /** Call from a user gesture when it asks for full screen. */
  start(opts?: {
    role?: PresentRole
    slideId?: string | null
    index?: number
    fullscreen?: boolean
    leader?: PresentLeader | null
  }): StartResult
  stop(opts?: { view?: 'restore' | 'here'; reason?: StopReason }): void
  role(): PresentRole | null
  /** Switches between presenting and following without leaving the presentation (a hand-off). */
  setRole(role: PresentRole, leader?: PresentLeader | null): void
  /** Following: show the presenter's slide (by frame id; `index` when that frame is not a slide here). */
  follow(slideId: string | null, index: number): void
  /** Called after every end of a presentation here (with the role it had and why it ended). */
  onStop(listener: (info: StopInfo) => void): () => void
}

const slots = new WeakMap<FeatureRegistries, Atom<LivePresenter | null>>()

/** The presenter slot of one board page (reactive). */
export function presenterSlot(registries: FeatureRegistries): Atom<LivePresenter | null> {
  let slot = slots.get(registries)
  if (!slot) {
    slot = atom<LivePresenter | null>('dr-live-presenter', null)
    slots.set(registries, slot)
  }
  return slot
}

/** Present mode offers its presenter to present-live; returns the withdrawal. */
export function provideLivePresenter(registries: FeatureRegistries, presenter: LivePresenter): () => void {
  const slot = presenterSlot(registries)
  slot.set(presenter)
  return () => {
    if (slot.get() === presenter) slot.set(null)
  }
}
