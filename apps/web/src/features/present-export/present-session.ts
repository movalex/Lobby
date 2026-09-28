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
  type TLEventInfo,
  type TLPageId,
  type TLShape,
  type TLShapeId,
  unsafe__withoutCapture,
} from 'tldraw'
import { type FrameEntry, presentationOrder } from './board-ops.ts'
import { buildSlides, findStartIndex, reconcileIndex, type Slide, stepIndex } from './slides.ts'

export const PRESENTING_ATTR = 'data-dr-presenting'
/** How long after a presentation the board view is re-centred while the canvas settles. */
const HOLD_CENTRE_MS = 2000

export type FullscreenMode = 'native' | 'window'

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
  /** Call from a user gesture (click / keydown): fullscreen needs transient activation. */
  start(): StartResult
  stop(): void
  go(delta: number): void
  goTo(index: number): void
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
    if (!s || !slide) return
    state.set({ ...s, slideId: slide.id, index, gridOpen: false })
  }

  const go = (delta: number) => {
    const { index, count } = current$.get()
    if (count === 0) return
    goTo(stepIndex(index, delta, count))
  }

  const setGridOpen = (open: boolean) => {
    const s = state.get()
    if (s && s.gridOpen !== open) state.set({ ...s, gridOpen: open })
  }

  const settle = () => {
    const s = state.get()
    if (!s) return
    const { index, slide } = current$.get()
    if (slide && (slide.id !== s.slideId || index !== s.index)) state.set({ ...s, slideId: slide.id, index })
  }

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
    if (e.key === 'Escape') {
      e.preventDefault()
      if (s.gridOpen) setGridOpen(false)
      else stop()
      return
    }
    if (e.key === 'Tab') {
      trapTab(e)
      return
    }
    if (modified) return // browser shortcuts (reload, zoom, close tab) keep working
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
    if (!document.fullscreenElement) stop()
  }

  const start = (): StartResult => {
    if (state.get()) return { ok: false, reason: 'already' }
    const slides = slides$.get()
    if (slides.length === 0) {
      return { ok: false, reason: order$.get().length > 0 ? 'all-skipped' : 'no-frames' }
    }
    stopHolding?.()
    const selectedIds = editor.getSelectedShapeIds()
    const startIndex = findStartIndex(slides, order$.get(), selectedIds, (id) =>
      editor
        .getShapeAncestors(id)
        .map((a) => a.id)
        .reverse(),
    )
    const active = document.activeElement
    const middle = editor.getViewportPageBounds().center
    const saved: SavedView = {
      pageId: editor.getCurrentPageId(),
      camera: { ...editor.getCamera() },
      center: { x: middle.x, y: middle.y },
      selectedIds: [...selectedIds],
      focus: active instanceof HTMLElement ? active : null,
    }
    if (editor.getEditingShapeId()) editor.setEditingShape(null)
    if (editor.getInstanceState().followingUserId) editor.stopFollowingUser()
    editor.selectNone()

    const el = container()
    let mode: FullscreenMode = 'window'
    if (typeof el.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
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
    cleanups = [
      () => window.removeEventListener('keydown', onKeyDown, true),
      () => document.removeEventListener('fullscreenchange', onFullscreenChange),
    ]
    const first = slides[startIndex] ?? slides[0]
    state.set({ slideId: first?.id ?? null, index: Math.max(0, startIndex), mode, gridOpen: false, saved })
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
  const holdCentre = (saved: SavedView) => {
    stopHolding?.()
    const onResize = () => {
      if (state.get()) return release()
      restoreCamera(saved)
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

  // tldraw 5.4.2 measures the viewport's screen bounds from its `.tl-canvas` element (DefaultCanvas,
  // useScreenBounds) through a 200 ms throttle, plus a once-a-second check. When the presentation ends
  // less than 200 ms after one of those checks, the editor keeps the full-window bounds for up to
  // another 200 ms after the board chrome is back: a click or drag in that window lands off by the
  // dock's width and the top bar's height, so a drag started on a shape brushes the canvas instead of
  // moving it, or jumps when the bounds catch up mid-drag. Measure it ourselves as soon as the board
  // layout is back.
  const measureViewport = () => {
    const el = container()
    editor.updateViewportScreenBounds(el.querySelector<HTMLElement>('.tl-canvas') ?? el)
  }

  function stop() {
    const s = state.get()
    if (!s) return
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
    const { saved } = s
    // The board view once the container is back at its board size: its real screen bounds (see
    // measureViewport), then exactly the camera it had.
    const settleView = () => {
      if (state.get()) return
      measureViewport()
      restoreCamera(saved)
    }
    if (document.fullscreenElement && document.fullscreenElement === container()) {
      document.exitFullscreen().then(
        () => {
          settleView()
          restoreFocus()
        },
        () => {},
      )
    }
    unsafe__withoutCapture(() => {
      // In-window presentations (and a fullscreen the browser already left) have their board layout
      // back now that the presenting flag is gone; a native fullscreen still covers the screen here.
      measureViewport()
      restoreCamera(saved)
      const stillThere = saved.selectedIds.filter((id) => editor.getShape(id))
      if (stillThere.length) editor.setSelectedShapes(stillThere)
      holdCentre(saved)
    })
    // The container returns to its board size over the next frames (fullscreen exit is async): measure
    // it, and while the centre is still held set the camera again, so the board view is where it was.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (state.get()) return
        measureViewport()
        if (stopHolding) restoreCamera(saved)
      }),
    )
    focusTarget(saved.focus)?.focus({ preventScroll: true })
    requestAnimationFrame(() => requestAnimationFrame(restoreFocus))
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
    setGridOpen,
    settle,
    setOverlayElement(el) {
      overlay = el
    },
  }
}
