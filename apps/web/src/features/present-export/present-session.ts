// Present mode state and lifecycle (imperative; the overlay renders from these atoms). One presenter per
// editor. Everything the session changes is restored on exit: camera, page, selection, fullscreen, the
// <html> presenting flag and every listener.
//
// What it hides and how (verified against tldraw 5.4.2): there is no instance flag for "hide other people";
// collaborator cursors are the `CollaboratorCursor` editor component (index.tsx wraps it to render
// nothing while presenting), and their hints/brushes/selection outlines are drawn on the overlay canvas
// `.tl-canvas-overlays`, hidden with the tldraw UI layer (`.tlui-layout`), frame headings and our own
// board chrome by present-export.css under `html[data-dr-presenting]`. Other features can use the same
// attribute to hide their canvas overlays (comment pins, vote dots) during a presentation.
import {
  type Atom,
  atom,
  computed,
  type Editor,
  react,
  type TLEventInfo,
  type TLPageId,
  type TLShape,
  type TLShapeId,
  unsafe__withoutCapture,
} from 'tldraw'
import { type FrameEntry, presentationOrder } from './board-ops.ts'
import { buildSlides, findStartIndex, reconcileIndex, type Slide, stepIndex } from './slides.ts'

export const PRESENTING_ATTR = 'data-dr-presenting'
/** Marks a small menu open inside the presentation chrome; Esc sends it PRESENT_POPUP_CLOSE. */
export const PRESENT_POPUP_ATTR = 'data-present-popup'
export const PRESENT_POPUP_CLOSE = 'dr-present-popup-close'
/** How long after a presentation the board view is re-centred while the canvas settles. */
const HOLD_CENTRE_MS = 2000
/** Room around the slide left in view when stepping out of a live presentation (screen px). */
const HERE_INSET_PX = 32

export type FullscreenMode = 'native' | 'window'

/**
 * Who drives the slides (present-live): the person presenting, or someone following a presentation to
 * everyone, whose slide is set by the presenter through the api (live/controller.ts). A follower has
 * the same chrome and the same clean board, but no slide keys: Esc steps out.
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
  slideId?: TLShapeId | null
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

interface SavedView {
  pageId: TLPageId
  camera: { x: number; y: number; z: number }
  /**
   * The page point at the middle of the board's viewport when the presentation started. The view is
   * restored around it, not from the raw camera: tldraw keeps camera x/y when the canvas changes size,
   * so a side panel that was open before and is closed after would leave the board shifted sideways.
   */
  center: { x: number; y: number }
  selectedIds: TLShapeId[]
  focus: HTMLElement | null
}

export interface PresentState {
  slideId: TLShapeId | null
  index: number
  mode: FullscreenMode
  gridOpen: boolean
  saved: SavedView
  role: PresentRole
  /** Who presents, while following a live presentation. */
  leader: PresentLeader | null
}

export interface CurrentSlide {
  index: number
  slide: Slide | null
  count: number
}

export type StartResult = { ok: true } | { ok: false; reason: 'no-frames' | 'all-skipped' | 'already' }

export interface Presenter {
  readonly state: Atom<PresentState | null>
  /** The current page's slides (top-level frames in presentation order, skips removed). */
  slides(): Slide[]
  /** The page's top-level frames in presentation order (including skipped ones). */
  order(): FrameEntry[]
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
  follow(slideId: TLShapeId | null, index: number): void
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

/** The current page plus its frame and group shapes: all board-ops needs for frame order and bounds. */
export function frameRecords(editor: Editor) {
  // Frames can only be parented to the page, frames or groups: those records carry every transform.
  const shapes = editor.getCurrentPageShapes().filter((s) => s.type === 'frame' || s.type === 'group')
  return [editor.getCurrentPage(), ...shapes]
}

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

export function createPresenter(editor: Editor): Presenter {
  const state = atom<PresentState | null>('dr-present-state', null)
  const order$ = computed('dr-present-order', () =>
    presentationOrder(frameRecords(editor), editor.getCurrentPageId()),
  )
  const slides$ = computed('dr-present-slides', () =>
    buildSlides(order$.get(), (id) => editor.getShape(id) as TLShape | undefined),
  )
  const current$ = computed<CurrentSlide>('dr-present-current', () => {
    const s = state.get()
    const slides = slides$.get()
    if (!s) return { index: -1, slide: null, count: slides.length }
    const index = reconcileIndex(s.index, s.slideId, slides)
    return { index, slide: slides[index] ?? null, count: slides.length }
  })

  let overlay: HTMLElement | null = null
  let cleanups: (() => void)[] = []

  const container = () => editor.getContainer()

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

  /** Shows the page holding `slideId` (a live presentation can be on another page than this person). */
  const showPageOf = (slideId: TLShapeId | null | undefined) => {
    if (!slideId) return
    const shape = editor.getShape(slideId)
    if (!shape) return
    const pageId = editor.getAncestorPageId(shape)
    if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId)
  }

  /** Where a slide id sits in the current slides, else `fallback` clamped (-1 without slides). */
  const indexFor = (slideId: TLShapeId | null | undefined, fallback: number) => {
    const slides = slides$.get()
    if (slides.length === 0) return -1
    const at = slideId ? slides.findIndex((sl) => sl.id === slideId) : -1
    return at >= 0 ? at : Math.max(0, Math.min(slides.length - 1, fallback))
  }

  const follow = (slideId: TLShapeId | null, index: number) => {
    const s = state.get()
    if (s?.role !== 'follower') return
    showPageOf(slideId)
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
  // presentation ended), so tldraw never sees a release without its press: the Enter that activates
  // "Exit" would otherwise reach tldraw's select tool on keyup and start editing the note whose
  // selection was just restored.
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

  // Window capture phase: runs before tldraw's container/body listeners and every other feature's, so
  // board shortcuts (tools, undo, delete, nudge, PgUp/PgDn z-order) never fire under a presentation.
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

  const start = (opts: StartOptions = {}): StartResult => {
    if (state.get()) return { ok: false, reason: 'already' }
    const role = opts.role ?? 'presenter'
    // The view to come back to is the one on screen now, before a live slide switches the page.
    const selectedIds = editor.getSelectedShapeIds()
    const active = document.activeElement
    const middle = editor.getViewportPageBounds().center
    const saved: SavedView = {
      pageId: editor.getCurrentPageId(),
      camera: { ...editor.getCamera() },
      center: { x: middle.x, y: middle.y },
      selectedIds: [...selectedIds],
      focus: active instanceof HTMLElement ? active : null,
    }
    const live = opts.slideId !== undefined
    if (live) showPageOf(opts.slideId)
    const slides = slides$.get()
    if (slides.length === 0) {
      if (live && editor.getCurrentPageId() !== saved.pageId) editor.setCurrentPage(saved.pageId)
      return { ok: false, reason: order$.get().length > 0 ? 'all-skipped' : 'no-frames' }
    }
    stopHolding?.()
    const startIndex = live
      ? indexFor(opts.slideId, opts.index ?? 0)
      : findStartIndex(slides, order$.get(), selectedIds, (id) =>
          editor
            .getShapeAncestors(id)
            .map((a) => a.id)
            .reverse(),
        )
    if (editor.getEditingShapeId()) editor.setEditingShape(null)
    if (editor.getInstanceState().followingUserId) editor.stopFollowingUser()
    editor.selectNone()

    const el = container()
    let mode: FullscreenMode = 'window'
    const fullscreen = opts.fullscreen ?? role === 'presenter'
    if (fullscreen && typeof el.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
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
    listenKeyup()
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // Nobody's view follows another person's cursor under a presentation ("Gather everyone", a
    // people-list follow): the slides own the camera. tldraw ends following on the next tick.
    const stopFollowGuard = react('dr-present-no-follow', () => {
      if (!editor.getInstanceState().followingUserId) return
      queueMicrotask(() => {
        if (state.get() && editor.getInstanceState().followingUserId) editor.stopFollowingUser()
      })
    })
    cleanups = [
      () => window.removeEventListener('keydown', onKeyDown, true),
      () => document.removeEventListener('fullscreenchange', onFullscreenChange),
      stopFollowGuard,
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

  const restoreCamera = (saved: SavedView) => {
    if (editor.getCurrentPageId() !== saved.pageId && editor.getPage(saved.pageId)) {
      editor.setCurrentPage(saved.pageId)
    }
    // screen = (page + camera) * z: put the saved centre back in the middle of the canvas as it is now.
    const { w, h } = editor.getViewportScreenBounds()
    const { z } = saved.camera
    const camera =
      w > 0 && h > 0 && z > 0
        ? { x: w / (2 * z) - saved.center.x, y: h / (2 * z) - saved.center.y, z }
        : saved.camera
    editor.setCamera(camera, { immediate: true, force: true })
  }

  /**
   * After a presentation the board's canvas settles over the next frames (fullscreen exit, the dock
   * and top bar coming back; tldraw reads the new size up to 200 ms late): re-centre on every resize
   * for a moment, until the person moves the camera or presses a key themselves.
   */
  let stopHolding: (() => void) | null = null
  const holdCentre = (place: () => void) => {
    stopHolding?.()
    const onResize = () => {
      if (state.get()) return release()
      place()
    }
    const onEvent = (info: TLEventInfo) => {
      if (
        info.type === 'wheel' ||
        info.type === 'pinch' ||
        (info.type === 'pointer' && info.name === 'pointer_down') ||
        (info.type === 'keyboard' && info.name === 'key_down')
      ) {
        release()
      }
    }
    const timer = setTimeout(() => release(), HOLD_CENTRE_MS)
    function release() {
      clearTimeout(timer)
      editor.off('resize', onResize)
      editor.off('event', onEvent)
      if (stopHolding === release) stopHolding = null
    }
    editor.on('resize', onResize)
    editor.on('event', onEvent)
    stopHolding = release
  }

  function stop(opts: StopOptions = {}) {
    const s = state.get()
    if (!s) return
    // 'here' (a follower stepping out, a live presentation ending): the slide on screen stays in view,
    // fitted to the board as it is once the chrome is back, instead of the view from before.
    const here = opts.view === 'here' ? (current$.get().slide?.bounds ?? null) : null
    if (here) editor.stopCameraAnimation()
    for (const c of cleanups) c()
    cleanups = []
    state.set(null)
    // Keys still held (the Esc or Enter that ended it) keep their keyup filtered, briefly.
    if (swallowed.size === 0) unlistenKeyup()
    else keyupTimer = setTimeout(unlistenKeyup, 2000)
    document.documentElement.removeAttribute(PRESENTING_ATTR)
    // Focus goes back where it was when the presentation started (the Present button after a click,
    // the board after Ctrl/Cmd+Alt+Enter), or to the Present button when that is gone (RETRO-22b).
    // Leaving fullscreen and removing the overlay settle over the next frames and can drop the focus
    // to <body>: it is put back then too.
    const restoreFocus = () => {
      if (state.get()) return
      const active = document.activeElement
      if (active && active !== document.body && !overlay?.contains(active)) return
      focusTarget(s.saved.focus)?.focus({ preventScroll: true })
    }
    if (document.fullscreenElement && document.fullscreenElement === container()) {
      document.exitFullscreen().then(restoreFocus, () => {})
    }
    const { saved } = s
    const place = here
      ? () => editor.zoomToBounds(here, { inset: HERE_INSET_PX, immediate: true, force: true })
      : () => restoreCamera(saved)
    unsafe__withoutCapture(() => {
      place()
      const stillThere = saved.selectedIds.filter((id) => editor.getShape(id))
      if (stillThere.length) editor.setSelectedShapes(stillThere)
      holdCentre(place)
    })
    // The container returns to its board size over the next frames (fullscreen exit is async): set the
    // camera again once it has, so the board view is exactly where it was.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!state.get() && stopHolding) place()
      }),
    )
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
