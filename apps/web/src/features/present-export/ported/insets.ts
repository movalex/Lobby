// K3-4: nothing covers a slide's content. The presentation draws its own chrome over the canvas: the
// read-only timer (workshops' `timer-floating`, top left) and the raised hands under it, present-live's
// banner ("Presenting to everyone", "Following Chase", top centre) and the control bar (bottom centre).
// A slide fitted to the whole view (tldraw's inset 0) put the timer over its heading and the bar over its
// footer, the most visible flaw in a demo. The chrome's band is kept free instead: the slide is fitted in
// what the top and bottom insets leave (slides.ts `fittedSlideRect`, presenter.ts `viewportFor`).
//
// What floats at the top comes from the features that draw it (`providePresentChrome`: workshops gives its
// timer and hands, present-live its banner through ./live-slots.ts); the numbers are the chrome's CSS
// (workshops.css `.dr-wk-floating`, present-export.css `.dr-present__bar`, live.css `.dr-live-top`) plus a
// small gap. Pure apart from the provider registry: unit-tested in Node.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { type Insets, NO_INSETS } from '../slides.ts'

/** The control bar: 20 px from the bottom, 46 px tall (34 px buttons and 6 px padding), and a 14 px gap. */
export const PRESENT_BAR_INSET = 80
/** One row of floating chrome at the top (the timer or the hands: 16 px down, about 40 px tall) and a gap. */
export const PRESENT_TOP_INSET = 64
/** The timer with the raised hands under it (the hands sit 68 px down: workshops.css). */
export const PRESENT_TOP_STACKED_INSET = 116
/** At most this share of the view's height goes to insets (a phone held sideways keeps a usable slide). */
export const PRESENT_INSET_MAX_SHARE = 0.4

/** What floats over the top of the slides right now. */
export interface PresentTopChrome {
  /** the live (running or paused) timer */
  readonly timer: boolean
  /** raised hands */
  readonly hands: boolean
  /** present-live's banner (presenting to everyone, following someone) */
  readonly banner: boolean
}

export const NO_TOP_CHROME: PresentTopChrome = { timer: false, hands: false, banner: false }

/**
 * The insets a slide is fitted in: the top row(s) of floating chrome and the control bar (`bar`: the
 * presentation has slides, so the bar is drawn; it fades while idle but keeps its place, so the slide never
 * jumps when the pointer moves). Never more than PRESENT_INSET_MAX_SHARE of the height in all.
 */
export function presentInsets(view: { w: number; h: number }, top: PresentTopChrome, bar: boolean): Insets {
  let t =
    top.timer && top.hands
      ? PRESENT_TOP_STACKED_INSET
      : top.timer || top.hands || top.banner
        ? PRESENT_TOP_INSET
        : 0
  let b = bar ? PRESENT_BAR_INSET : 0
  const max = Math.max(0, view.h) * PRESENT_INSET_MAX_SHARE
  if (t + b > max && t + b > 0) {
    const k = max / (t + b)
    t = Math.floor(t * k)
    b = Math.floor(b * k)
  }
  if (t === 0 && b === 0) return { ...NO_INSETS }
  return { top: t, right: 0, bottom: b, left: 0 }
}

/** Two rectangles share any area (touching edges do not count). */
export function intersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// ---- who floats what (one reactive reader per feature) -------------------------------------------------

type ChromeReader = () => Partial<PresentTopChrome>

const providers = new WeakMap<LobbyCanvas, Atom<readonly ChromeReader[]>>()

function slotOf(canvas: LobbyCanvas): Atom<readonly ChromeReader[]> {
  let slot = providers.get(canvas)
  if (!slot) {
    slot = atom<readonly ChromeReader[]>('lobby-present-top-chrome', [])
    providers.set(canvas, slot)
  }
  return slot
}

/** A feature says what it floats over the slides (`read` is reactive: it reads signals); returns the removal. */
export function providePresentChrome(canvas: LobbyCanvas, read: ChromeReader): () => void {
  const slot = slotOf(canvas)
  slot.set([...slot.get(), read])
  return () => slot.set(slot.get().filter((r) => r !== read))
}

/** Reactive: everything the features float at the top of the slides now. */
export function presentTopChromeOf(canvas: LobbyCanvas): PresentTopChrome {
  const out = { timer: false, hands: false, banner: false }
  for (const read of slotOf(canvas).get()) {
    const c = read()
    out.timer ||= !!c.timer
    out.hands ||= !!c.hands
    out.banner ||= !!c.banner
  }
  return out
}
