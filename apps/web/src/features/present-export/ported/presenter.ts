// Present mode on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §4.5 "Frame-by-frame
// presentation": the viewport on the frame, the chrome hidden): the port of ../present-session.ts onto
// LobbyCanvas, same states, keys and restore rules. One presenter per canvas. Everything the session
// changes is restored on exit: the view, the selection, fullscreen, focus mode, the <html> presenting flag
// and every listener.
//
// What it hides and how: `canvas.settings` focus mode makes the board page drop its dock, top bar and host
// slots and every overlay layer that does not ask to stay (docs/EXCALIDRAW-CONTRACTS.md §3); other
// people's cursors are filtered through `registries.cursorVisible` (./index.tsx). The <html> presenting
// attribute stays for CSS that hides other chrome (notices, banners: ../present-export.css).
//
// Keys: while presenting, the presentation is modal. A window capture-phase listener takes every key
// before the board's own layers (the key registry, spike B's allowlist, Excalidraw), exactly as the tldraw
// presenter did: slide keys, Esc, Tab inside the controls; every other key (n, Delete, Ctrl+Z, PageUp)
// does nothing. The Present shortcut itself is a registered command (./index.tsx).
//
// The camera: slides are fitted by the chrome (./PresentOverlay.tsx) through `viewport.set` with the
// zoom and position computed by slides.ts `fittedSlideRect`, so the surround's window and the camera use
// the same numbers.

import type { LobbyCanvas, Viewport } from '../../../canvas/api/index.ts'
import { NotImplementedError } from '../../../canvas/api/index.ts'
import { type Atom, atom, computed, untracked } from '../../../lib/signals.ts'
import type {
  CurrentSlide as CurrentSlideOf,
  FullscreenMode,
  PresentLeader,
  PresentRole,
  StartResult,
  StopInfo,
  StopOptions,
} from '../present-session.ts'
import { findStartIndex, reconcileIndex, type Slide, stepIndex } from '../slides.ts'
import { containersOf, type ElementFrameEntry, presentationOrder, slidesOf } from './frames.ts'

export type { FullscreenMode, PresentLeader, PresentRole, StartResult, StopInfo, StopOptions }

export const PRESENTING_ATTR = 'data-dr-presenting'
/** Marks a small menu open inside the presentation chrome; Esc sends it PRESENT_POPUP_CLOSE. */
export const PRESENT_POPUP_ATTR = 'data-present-popup'
export const PRESENT_POPUP_CLOSE = 'dr-present-popup-close'
/** How long after a presentation the board view is re-centred while the canvas settles. */
const HOLD_CENTRE_MS = 2000
/** Room around the slide left in view when stepping out of a live presentation (screen px). */
const HERE_INSET_PX = 32

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

/** A view the presenter asks the canvas for (scene top-left and zoom). */
type ViewTarget = { x: number; y: number; zoom: number }

interface SavedView {
  viewport: Viewport
  /**
   * The scene point at the middle of the board's view when the presentation started. The view is restored
   * around it, not from the raw scroll position: the engine keeps its top-left when the canvas changes
   * size, so a side panel that was open before and is closed after would leave the board shifted.
   */
  center: { x: number; y: number }
  selectedIds: string[]
  focus: HTMLElement | null
}

export interface PresentState {
  slideId: string | null
  index: number
  mode: FullscreenMode
  gridOpen: boolean
  saved: SavedView
  role: PresentRole
  /** Who presents, while following a live presentation. */
  leader: PresentLeader | null
}

export type CurrentSlide = Omit<CurrentSlideOf, 'slide'> & { slide: Slide<string> | null }

/** The ported presenter: ../present-session.ts `Presenter` with element ids (3c's present-live drives it). */
export interface Presenter {
  readonly state: Atom<PresentState | null>
  /** The board's slides (frames in presentation order, skips removed). */
  slides(): Slide<string>[]
  /** The board's frames in presentation order (including skipped ones). */
  order(): ElementFrameEntry[]
  current(): CurrentSlide
  isPresenting(): boolean
  /** Call from a user gesture (click / keydown) when it asks for full screen: that needs transient activation. */
  start(opts?: StartOptions): StartResult
  stop(opts?: StopOptions): void
  go(delta: number): void
  goTo(index: number): void
  /** The role now (null when not presenting). */
  role(): PresentRole | null
  /** Switches between presenting and following without leaving the presentation (a hand-off). */
  setRole(role: PresentRole, leader?: PresentLeader | null): void
  /** Following: show the presenter's slide (by frame id; `index` when that frame is not a slide here). */
  follow(slideId: string | null, index: number): void
  /** Called after every end of a presentation here (with the role it had and why it ended). */
  onStop(listener: (info: StopInfo) => void): () => void
  setGridOpen(open: boolean): void
  /**
   * Adopts the slide now on screen after the list changed under the presentation (the current frame was
   * deleted or skipped), so the frame coming back later does not pull the presentation away.
   */
  settle(): void
  /** The overlay's root element: key handling keeps focus inside it. */
  setOverlayElement(el: HTMLElement | null): void
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar'])
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp'])

/** What gets the focus after a presentation: what had it before, else the Present button. */
export function focusTarget(before: HTMLElement | null): HTMLElement | null {
  if (before?.isConnected && before !== document.body) return before
  return document.querySelector<HTMLElement>('[data-testid="present-button"]')
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/** A member a later wave-3 owner lands (follow is 3c's): until then its stub means "nobody is followed". */
function tryMember<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch (e) {
    if (e instanceof NotImplementedError) return fallback
    throw e
  }
}

/** The camera that shows scene `bounds` fitted in the middle of a `w`×`h` view with `inset` px around. */
export function viewportFor(
  bounds: { x: number; y: number; w: number; h: number },
  view: { w: number; h: number },
  inset: number,
  zoomRange: { min: number; max: number },
): { x: number; y: number; zoom: number } {
  const w = Math.max(bounds.w, 1e-6)
  const h = Math.max(bounds.h, 1e-6)
  const fit = Math.min((view.w - inset * 2) / w, (view.h - inset * 2) / h)
  const zoom = Math.max(zoomRange.min, Math.min(zoomRange.max, fit))
  return {
    x: bounds.x + w / 2 - view.w / zoom / 2,
    y: bounds.y + h / 2 - view.h / zoom / 2,
    zoom,
  }
}

/**
 * The canvas's size on screen now, from its region's layout (the engine's own copy of its size follows
 * a resize a little later: placing the view from it right after the chrome came back, or after
 * fullscreen, would centre it on the old size).
 */
export function canvasSize(canvas: LobbyCanvas): { w: number; h: number } {
  const r = canvas.container()?.getBoundingClientRect()
  if (r && r.width > 0 && r.height > 0) return { w: r.width, h: r.height }
  const s = canvas.viewport.screenRect()
  return { w: s.width, h: s.height }
}

/**
 * The zoom range slides are fitted in. Excalidraw's own range is 0.1-30 (`getNormalizedZoom`), but
 * Lobby installs its camera through the scene's app state, which takes less (§4.2); tldraw's range was
 * about 0.05-8 × its base zoom.
 */
export const PRESENT_ZOOM_RANGE = { min: 0.02, max: 8 } as const

export function createPresenter(canvas: LobbyCanvas): Presenter {
  const state = atom<PresentState | null>('lobby-present-state', null)
  const order$ = computed('lobby-present-order', () => presentationOrder(canvas))
  const slides$ = computed('lobby-present-slides', () => slidesOf(order$.get()))
  const current$ = computed<CurrentSlide>('lobby-present-current', () => {
    const s = state.get()
    const slides = slides$.get()
    if (!s) return { index: -1, slide: null, count: slides.length }
    const index = reconcileIndex(s.index, s.slideId, slides)
    return { index, slide: slides[index] ?? null, count: slides.length }
  })

  let overlay: HTMLElement | null = null
  let cleanups: (() => void)[] = []

  const container = () => canvas.container()
  const viewSize = () => canvasSize(canvas)

  const goTo = (index: number) => {
    const s = state.get()
    const slides = slides$.get()
    const slide = slides[index]
    // A follower's slide comes from the presenter (follow()), never from their own keys or clicks.
    if (!s || !slide || s.role !== 'presenter') return
    state.set({ ...s, slideId: slide.id, index, gridOpen: false })
  }

  const go = (delta: number) => {
    const { index, count } = current$.get()
    if (count === 0) return
    goTo(stepIndex(index, delta, count))
  }

  const setGridOpen = (open: boolean) => {
    const s = state.get()
    if (s && s.gridOpen !== open && (!open || s.role === 'presenter')) state.set({ ...s, gridOpen: open })
  }

  const settle = () => {
    const s = state.get()
    // Following: the presenter's frame id stays the target even while it is not a slide here yet (a
    // frame they just made has not synced): the presentation moves there as soon as it arrives.
    if (s?.role !== 'presenter') return
    const { index, slide } = current$.get()
    if (slide && (slide.id !== s.slideId || index !== s.index)) state.set({ ...s, slideId: slide.id, index })
  }

  /** Where a slide id sits in the current slides, else `fallback` clamped (-1 without slides). */
  const indexFor = (slideId: string | null | undefined, fallback: number) => {
    const slides = slides$.get()
    if (slides.length === 0) return -1
    const at = slideId ? slides.findIndex((sl) => sl.id === slideId) : -1
    return at >= 0 ? at : Math.max(0, Math.min(slides.length - 1, fallback))
  }

  const follow = (slideId: string | null, index: number) => {
    const s = state.get()
    if (s?.role !== 'follower') return
    const at = indexFor(slideId, index)
    const target = slideId ?? slides$.get()[at]?.id ?? null
    const next = Math.max(0, at)
    // Idempotent (the live controller calls it after every change): no new state, no re-render.
    if (s.slideId === target && s.index === next && !s.gridOpen) return
    state.set({ ...s, slideId: target, index: next, gridOpen: false })
  }

  const setRole = (role: PresentRole, leader: PresentLeader | null = null) => {
    const s = state.get()
    if (!s) return
    if (s.role === role && s.leader?.userId === leader?.userId && s.leader?.name === leader?.name) return
    state.set({ ...s, role, leader: role === 'follower' ? leader : null, gridOpen: false })
  }

  const stopListeners = new Set<(info: StopInfo) => void>()

  const trapTab = (e: KeyboardEvent) => {
    if (!overlay) return
    const items = focusables(overlay)
    if (items.length === 0) {
      e.preventDefault()
      overlay.focus()
      return
    }
    const active = document.activeElement as HTMLElement | null
    const at = active ? items.indexOf(active) : -1
    const next = e.shiftKey
      ? at <= 0
        ? items.length - 1
        : at - 1
      : at < 0 || at >= items.length - 1
        ? 0
        : at + 1
    e.preventDefault()
    items[next]?.focus()
  }

  const moveGridFocus = (delta: number) => {
    const items = overlay ? Array.from(overlay.querySelectorAll<HTMLElement>('[data-slide-option]')) : []
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? 0 : Math.max(0, Math.min(items.length - 1, at + delta))
    items[next]?.focus()
  }

  // Keys whose keydown the presentation swallowed get their keyup swallowed too (also just after the
  // presentation ended), so the board never sees a release without its press: the Enter that activates
  // "Exit" would otherwise reach the board on keyup, where the note whose selection was just restored
  // could start editing.
  const swallowed = new Set<string>()
  let keyupTimer: ReturnType<typeof setTimeout> | undefined
  const onKeyUp = (e: KeyboardEvent) => {
    if (swallowed.delete(e.code || e.key)) e.stopPropagation()
    if (!state.get() && swallowed.size === 0) unlistenKeyup()
  }
  const listenKeyup = () => {
    if (keyupTimer) clearTimeout(keyupTimer)
    keyupTimer = undefined
    window.addEventListener('keyup', onKeyUp, true)
  }
  function unlistenKeyup() {
    window.removeEventListener('keyup', onKeyUp, true)
    swallowed.clear()
    if (keyupTimer) clearTimeout(keyupTimer)
    keyupTimer = undefined
  }

  // Window capture phase: runs before the board's key layers (the key registry, the allowlist) and
  // Excalidraw's, so board shortcuts (tools, undo, delete, nudge, z-order) never fire under a presentation.
  const onKeyDown = (e: KeyboardEvent) => {
    const s = state.get()
    if (!s) return
    e.stopPropagation()
    swallowed.add(e.code || e.key)
    if (e.isComposing) return
    const target = e.target instanceof HTMLElement ? e.target : null
    const onControl = !!(target && overlay?.contains(target) && target.closest('button, a, [role="button"]'))
    const modified = e.ctrlKey || e.metaKey || e.altKey
    // A small menu open in the chrome (present-live's "Hand over"): Esc closes it, Tab moves inside
    // the chrome, Enter/Space press its buttons, and no key changes the slide meanwhile.
    const popup = overlay?.querySelector<HTMLElement>(`[${PRESENT_POPUP_ATTR}]`)
    if (popup) {
      if (e.key === 'Escape') {
        e.preventDefault()
        popup.dispatchEvent(new CustomEvent(PRESENT_POPUP_CLOSE))
      } else if (e.key === 'Tab') trapTab(e)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (s.gridOpen) setGridOpen(false)
      else stop({ reason: 'local', view: s.role === 'follower' ? 'here' : 'restore' })
      return
    }
    if (e.key === 'Tab') {
      trapTab(e)
      return
    }
    if (modified) return // browser shortcuts (reload, zoom, close tab) keep working
    // Following: the presenter drives the slides; the other keys do nothing (buttons still work).
    if (s.role === 'follower') return
    if (s.gridOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        moveGridFocus(1)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        moveGridFocus(-1)
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        setGridOpen(false)
      }
      return // Enter/Space activate the focused slide button by default
    }
    if ((e.key === ' ' || e.key === 'Enter') && onControl) return // activate the focused button
    if (NEXT_KEYS.has(e.key)) {
      e.preventDefault()
      go(1)
    } else if (PREV_KEYS.has(e.key)) {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      goTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      goTo(current$.get().count - 1)
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault()
      setGridOpen(true)
    }
  }

  const onFullscreenChange = () => {
    const s = state.get()
    if (s?.mode !== 'native') return
    // Esc in real fullscreen is taken by the browser: leaving fullscreen ends the presentation.
    if (!document.fullscreenElement)
      stop({ reason: 'local', view: s.role === 'follower' ? 'here' : 'restore' })
  }

  const stopFollowing = () => {
    if (tryMember(() => canvas.follow.current(), null)) tryMember(() => canvas.follow.stop(), undefined)
  }

  const start = (opts: StartOptions = {}): StartResult => {
    if (state.get()) return { ok: false, reason: 'already' }
    const role = opts.role ?? 'presenter'
    const selectedIds = [...canvas.selection]
    const active = document.activeElement
    const vp = canvas.viewport.get()
    const saved: SavedView = {
      viewport: vp,
      center: { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 },
      selectedIds,
      focus: active instanceof HTMLElement ? active : null,
    }
    const live = opts.slideId !== undefined
    const slides = slides$.get()
    if (slides.length === 0)
      return { ok: false, reason: order$.get().length > 0 ? 'all-skipped' : 'no-frames' }
    stopHolding?.()
    const startIndex = live
      ? indexFor(opts.slideId, opts.index ?? 0)
      : findStartIndex<string>(slides, order$.get(), selectedIds, (id) => containersOf(canvas, id))
    if (canvas.editingId()) canvas.text.stop()
    stopFollowing()
    canvas.select([])

    const el = container()
    let mode: FullscreenMode = 'window'
    const fullscreen = opts.fullscreen ?? role === 'presenter'
    if (
      el &&
      fullscreen &&
      typeof el.requestFullscreen === 'function' &&
      document.fullscreenEnabled !== false
    ) {
      mode = 'native'
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => {
          // Esc (or Exit) came before the browser had entered fullscreen: stop() found nothing to
          // leave, so leave it now instead of stranding the board full screen without a presentation.
          if (!state.get() && document.fullscreenElement === el) document.exitFullscreen().catch(() => {})
        },
        () => {
          // Denied (permissions policy, no user activation): stay in the in-window presentation.
          const s = state.get()
          if (s && s.mode === 'native') state.set({ ...s, mode: 'window' })
        },
      )
    }
    document.documentElement.setAttribute(PRESENTING_ATTR, 'true')
    canvas.settings.set({ focusMode: true })
    listenKeyup()
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // Nobody's view follows another person's under a presentation ("Gather everyone", a people-list
    // follow): the slides own the camera.
    let offFollow: () => void = () => {}
    try {
      offFollow = canvas.on('followChanged', (sid) => {
        if (sid && state.get()) queueMicrotask(stopFollowing)
      })
    } catch (e) {
      if (!(e instanceof NotImplementedError)) throw e
    }
    cleanups = [
      () => window.removeEventListener('keydown', onKeyDown, true),
      () => document.removeEventListener('fullscreenchange', onFullscreenChange),
      offFollow,
    ]
    const first = slides[startIndex] ?? slides[0]
    // Live: the presenter's frame stays the target even if it is not a slide here yet (not synced).
    const slideId = live && opts.slideId ? opts.slideId : (first?.id ?? null)
    state.set({
      slideId,
      index: Math.max(0, startIndex),
      mode,
      gridOpen: false,
      saved,
      role,
      leader: role === 'follower' ? (opts.leader ?? null) : null,
    })
    return { ok: true }
  }

  /** Puts the saved centre back in the middle of the canvas as it is now, at the saved zoom. */
  /** Puts the saved centre back in the middle of the canvas as it is now, at the saved zoom. */
  const restoreCamera = (saved: SavedView): ViewTarget => {
    const { w, h } = viewSize()
    const z = saved.viewport.zoom
    const target =
      w > 0 && h > 0 && z > 0
        ? { x: saved.center.x - w / (2 * z), y: saved.center.y - h / (2 * z), zoom: z }
        : { x: saved.viewport.x, y: saved.viewport.y, zoom: z }
    canvas.viewport.set(target, { force: true })
    return target
  }

  /**
   * After a presentation the board's canvas settles over the next frames (fullscreen exit, the dock
   * and top bar coming back): re-centre on every resize for a moment, until the person moves the camera
   * or presses a key themselves.
   */
  let stopHolding: (() => void) | null = null
  /** Puts the held view back (while the hold lasts); null when nothing is held. */
  let holdPlace: (() => void) | null = null
  const holdCentre = (place: () => ViewTarget, first: ViewTarget) => {
    stopHolding?.()
    // The views the hold asked for. A resize keeps the scene position (the engine keeps its scroll), so a
    // view that is none of them was moved by something else meanwhile (a zoom to a frame, a deep link, a
    // script): that wins, and the hold ends instead of pulling the view back. The engine applies a view
    // a render later, so the one before the latest request still counts as ours until then.
    let placed: ViewTarget[] = [canvas.viewport.get(), first]
    const put = () => {
      placed = [placed[placed.length - 1] as ViewTarget, place()]
    }
    const near = (a: ViewTarget, b: ViewTarget) =>
      Math.abs(a.x - b.x) <= 0.01 && Math.abs(a.y - b.y) <= 0.01 && Math.abs(a.zoom - b.zoom) <= 1e-6
    const moved = () => {
      const c = canvas.viewport.get()
      return !placed.some((p) => near(c, p))
    }
    const onResize = () => {
      if (state.get() || moved()) return release()
      put()
    }
    // The board's canvas region itself: it changes size more than once on the way back (fullscreen
    // ends, then the top bar and the dock return), and the engine's resize report lags the layout.
    const root = container()
    const ro = root && typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    if (root) ro?.observe(root)
    const offResize = canvas.on('resize', onResize)
    const offInput = canvas.on('input', (e) => {
      if (e.type === 'wheel' || e.type === 'pinch' || e.type === 'pointer-down' || e.type === 'key-down')
        release()
    })
    const timer = setTimeout(() => release(), HOLD_CENTRE_MS)
    function release() {
      clearTimeout(timer)
      offResize()
      ro?.disconnect()
      offInput()
      if (stopHolding === release) {
        stopHolding = null
        holdPlace = null
      }
    }
    stopHolding = release
    holdPlace = () => {
      if (moved()) return release()
      put()
    }
  }

  function stop(opts: StopOptions = {}) {
    const s = state.get()
    if (!s) return
    // 'here' (a follower stepping out, a live presentation ending): the slide on screen stays in view,
    // fitted to the board as it is once the chrome is back, instead of the view from before.
    const here = opts.view === 'here' ? (current$.get().slide?.bounds ?? null) : null
    if (here) canvas.viewport.stop()
    for (const c of cleanups) c()
    cleanups = []
    state.set(null)
    // Keys still held (the Esc or Enter that ended it) keep their keyup filtered, briefly.
    if (swallowed.size === 0) unlistenKeyup()
    else keyupTimer = setTimeout(unlistenKeyup, 2000)
    document.documentElement.removeAttribute(PRESENTING_ATTR)
    canvas.settings.set({ focusMode: false })
    // Focus goes back where it was when the presentation started (the Present button after a click,
    // the board after Ctrl/Cmd+Alt+Enter), or to the Present button when that is gone (RETRO-22b).
    const restoreFocus = () => {
      if (state.get()) return
      const active = document.activeElement
      const root = container()
      const parked = !!root && active === root
      if (active && active !== document.body && !parked && !overlay?.contains(active)) return
      focusTarget(s.saved.focus)?.focus({ preventScroll: true })
    }
    // The engine measures its container after the layout changed: until it does, points on screen map
    // to the scene through the full-screen size. Measure now, once the layout is back.
    const measure = () => {
      if (state.get()) return
      canvas.viewport.remeasure()
      holdPlace?.()
    }
    const root = container()
    if (document.fullscreenElement && document.fullscreenElement === root) {
      document.exitFullscreen().then(
        () => {
          measure()
          restoreFocus()
        },
        () => {},
      )
    }
    const { saved } = s
    const place = here
      ? (): ViewTarget => {
          const v = viewportFor(here, viewSize(), HERE_INSET_PX, PRESENT_ZOOM_RANGE)
          canvas.viewport.set(v, { force: true })
          return v
        }
      : () => restoreCamera(saved)
    untracked(() => {
      canvas.viewport.remeasure()
      const first = place()
      const stillThere = saved.selectedIds.filter((id) => canvas.get(id) && !canvas.get(id)?.isDeleted)
      if (stillThere.length) canvas.select(stillThere)
      holdCentre(place, first)
    })
    // The container returns to its board size over the next frames (fullscreen exit is async): set the
    // view again once it has, so the board view is exactly where it was.
    requestAnimationFrame(() => requestAnimationFrame(measure))
    focusTarget(saved.focus)?.focus({ preventScroll: true })
    requestAnimationFrame(() => requestAnimationFrame(restoreFocus))
    const info: StopInfo = { role: s.role, reason: opts.reason ?? 'local' }
    for (const l of [...stopListeners]) {
      try {
        l(info)
      } catch (e) {
        console.error('presentation stop listener failed', e)
      }
    }
  }

  return {
    state,
    slides: () => slides$.get(),
    order: () => order$.get(),
    current: () => current$.get(),
    isPresenting: () => state.get() !== null,
    start,
    stop,
    go,
    goTo,
    role: () => state.get()?.role ?? null,
    setRole,
    follow,
    onStop(listener) {
      stopListeners.add(listener)
      return () => void stopListeners.delete(listener)
    },
    setGridOpen,
    settle,
    setOverlayElement(el) {
      overlay = el
    },
  }
}
