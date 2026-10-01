// Present mode's shared vocabulary (the ported presenter, ./ported/presenter.ts, and its chrome): roles,
// start/stop options and results, the current slide. Until wave 4 part 2 these lived in the tldraw
// presenter (present-session.ts); ids are element ids (strings) on the new canvas.
import type { Slide } from './slides.ts'

export const PRESENTING_ATTR = 'data-dr-presenting'
/** Marks a small menu open inside the presentation chrome; Esc sends it PRESENT_POPUP_CLOSE. */
export const PRESENT_POPUP_ATTR = 'data-present-popup'
export const PRESENT_POPUP_CLOSE = 'dr-present-popup-close'

export type FullscreenMode = 'native' | 'window'

/**
 * Who drives the slides (present-live): the person presenting, or someone following a presentation to
 * everyone, whose slide is set by the presenter through the api (live/ported/controller.ts). A follower
 * has the same chrome and the same clean board, but no slide keys: Esc steps out.
 */
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

export interface StartOptions {
  /** Default 'presenter'. */
  role?: PresentRole
  /** Open at this frame (a live presentation's slide) instead of where the selection says. */
  slideId?: string | null
  /** The slide index to fall back to when `slideId` is not (yet) a slide here. */
  index?: number
  /** Ask the browser for full screen (needs a user gesture). Default: presenters yes, followers no. */
  fullscreen?: boolean
  leader?: PresentLeader | null
}

export interface StopOptions {
  /** 'restore' (default): the view from before the presentation. 'here': stay on the slide on screen. */
  view?: 'restore' | 'here'
  /** Default 'local'. */
  reason?: StopReason
}

export interface CurrentSlide {
  index: number
  slide: Slide | null
  count: number
}

export type StartResult = { ok: true } | { ok: false; reason: 'no-frames' | 'all-skipped' | 'already' }

export type ExportFocus = 'image' | 'pdf' | 'csv'

export interface ExportRequest {
  focus: ExportFocus
  seq: number
}
