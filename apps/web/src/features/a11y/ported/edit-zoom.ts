// K5-1 (wave K): on a phone, editing a note brings it to a readable size above the keyboard, and puts the
// camera back afterwards.
//
// At a whole-board fit (about 42 % on a phone) a note's text editor is about 48 × 11 px: its words are about
// 8 px tall, and the note usually sits where the soft keyboard opens. When this tab's text editor opens
// (`editingChanged` with an id) on a touch screen ((pointer: coarse)) or on a canvas narrower than
// PHONE_CANVAS_PX, and the zoom is under READABLE_BELOW or the element reaches into the bottom 55 % of the
// canvas, the LOCAL camera moves: the element is centred across, its centre in the upper third (below the
// board menu's corner), at the zoom
// max(current, 1) (less only when 1 would not fit it on the screen above the keyboard). When the editor
// closes the camera goes back to where it was, unless the person moved it meanwhile (a pan or a pinch: the
// camera is no longer where this put it), and then it stays where they put it.
//
// This is a camera move and nothing else: `viewport.set` only (scroll and zoom are this tab's own state, never
// synced), no element is written, so the sync engine pushes nothing for it (k5 spec: a push counter). A move
// honours reduced motion (./motion.ts) and, like every camera move without `force`, gives way while the
// person follows someone or presents.
import type { Bounds, LobbyCanvas, Viewport } from '../../../canvas/api/index.ts'

/** A canvas narrower than this (px) counts as a phone, whatever the pointer. */
export const PHONE_CANVAS_PX = 600
/** Under this zoom an edit always zooms in. */
export const READABLE_BELOW = 0.8
/** The zoom an edit zooms in to (or the current one, when it is higher). */
export const READABLE_ZOOM = 1
/** An element reaching below this share of the canvas height is where the keyboard opens. */
export const KEYBOARD_LINE = 0.45
/** Screen px kept free around the element. */
export const EDIT_MARGIN_PX = 16
/** Screen px kept free at the top of the canvas: a phone's board menu and panel button sit there. */
export const EDIT_TOP_PX = 56
/** How long the camera waits after an editor closes before going back (another editor may open at once). */
export const RESTORE_DELAY_MS = 150
/** How far (screen px) the camera may be from where this put it and still count as not moved by the person. */
export const MOVED_PX = 2

/** The canvas members edit-zoom uses (a fake one in edit-zoom.test.ts). */
export interface EditZoomCanvas {
  on: LobbyCanvas['on']
  editingId(): string | null
  bounds(id: string): Bounds | null
  readonly viewport: Pick<
    LobbyCanvas['viewport'],
    'get' | 'set' | 'screenRect' | 'limits' | 'moving' | 'stop'
  >
}

export interface EditZoomEnv {
  /** The primary pointer is a finger ((pointer: coarse)). */
  coarse(): boolean
  /** Camera moves animate (off under reduced motion). */
  animate(): boolean
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type Camera = Pick<Viewport, 'x' | 'y' | 'zoom'>

const browserEnv = (): EditZoomEnv => ({
  coarse: () => {
    try {
      return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    } catch {
      return false
    }
  },
  animate: () => {
    try {
      return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return true
    }
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
})

/**
 * The camera that brings `b` (scene bounds) to a readable size in the upper third of a `screen`-sized canvas,
 * or null when the edit needs no move: a fine pointer on a wide canvas, or a zoom already readable with the
 * element above the keyboard line.
 */
export function editCamera(input: {
  readonly view: Viewport
  readonly screen: { readonly width: number; readonly height: number }
  readonly bounds: Bounds
  readonly coarse: boolean
  readonly limits?: { readonly min: number; readonly max: number }
}): Camera | null {
  const { view, screen, bounds: b } = input
  const W = screen.width
  const H = screen.height
  if (!(W > 0) || !(H > 0) || !(view.zoom > 0) || !(b.width >= 0) || !(b.height >= 0)) return null
  if (!input.coarse && W >= PHONE_CANVAS_PX) return null
  const z = view.zoom
  const bottom = (b.y + b.height - view.y) * z
  const top = (b.y - view.y) * z
  const offScreen = bottom < 0 || top > H || (b.x + b.width - view.x) * z < 0 || (b.x - view.x) * z > W
  if (z >= READABLE_BELOW && bottom <= H * KEYBOARD_LINE && !offScreen) return null
  // max(current, 1); less than 1 only when 1 would not fit the element across or above the keyboard line
  const fits = Math.min(
    b.width > 0 ? (W - 2 * EDIT_MARGIN_PX) / b.width : Number.POSITIVE_INFINITY,
    b.height > 0 ? (H * KEYBOARD_LINE - EDIT_TOP_PX - EDIT_MARGIN_PX) / b.height : Number.POSITIVE_INFINITY,
  )
  let zoom = Math.max(z, Math.min(READABLE_ZOOM, fits > 0 ? fits : READABLE_ZOOM))
  if (input.limits) zoom = Math.min(input.limits.max, Math.max(input.limits.min, zoom))
  // centred across; its centre in the upper third (at its middle, or lower when the element would reach the
  // board menu at the top: then its top is just below it)
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const centreY = Math.max(H / 6, EDIT_TOP_PX + (b.height * zoom) / 2)
  return { x: cx - W / 2 / zoom, y: cy - centreY / zoom, zoom }
}

/** The camera is (within MOVED_PX on screen) where `target` put it. */
export function sameCamera(now: Camera, target: Camera): boolean {
  if (Math.abs(now.zoom - target.zoom) > 1e-3 * Math.max(1, target.zoom)) return false
  return (
    Math.abs(now.x - target.x) * now.zoom <= MOVED_PX && Math.abs(now.y - target.y) * now.zoom <= MOVED_PX
  )
}

/**
 * Watches this tab's text editor and moves the local camera as described above; returns the uninstaller
 * (which also cancels a pending return).
 */
export function installEditZoom(canvas: EditZoomCanvas, env: EditZoomEnv = browserEnv()): () => void {
  /** Where the camera was before the first edit that moved it, and where this put it. */
  let held: { before: Camera; target: Camera } | null = null
  let restoreTimer: unknown = null

  const cancelRestore = () => {
    if (restoreTimer === null) return
    env.clearTimeout(restoreTimer)
    restoreTimer = null
  }

  const open = (id: string) => {
    const view = canvas.viewport.get()
    const b = canvas.bounds(id)
    if (!b) return
    const rect = canvas.viewport.screenRect()
    let limits: { min: number; max: number } | undefined
    try {
      limits = canvas.viewport.limits()
    } catch {
      limits = undefined
    }
    const target = editCamera({ view, screen: rect, bounds: b, coarse: env.coarse(), limits })
    if (!target) return
    // a second edit right after the first: the camera still goes back to where it was before the first
    const before = held ? held.before : { x: view.x, y: view.y, zoom: view.zoom }
    canvas.viewport.set(target, { animate: env.animate() })
    held = { before, target }
  }

  const close = () => {
    const h = held
    held = null
    if (!h) return
    // still animating towards where this put it: the person has not moved it
    const moving = canvas.viewport.moving()
    if (!moving && !sameCamera(canvas.viewport.get(), h.target)) return
    if (moving) canvas.viewport.stop()
    canvas.viewport.set(h.before, { animate: env.animate() })
  }

  const off = canvas.on('editingChanged', (id) => {
    if (id !== null) {
      // another editor opens before the camera went back: keep where it was before the first one
      if (restoreTimer !== null) {
        cancelRestore()
        if (held && !sameCamera(canvas.viewport.get(), held.target) && !canvas.viewport.moving()) held = null
      }
      open(id)
      return
    }
    if (!held) return
    cancelRestore()
    restoreTimer = env.setTimeout(() => {
      restoreTimer = null
      close()
    }, RESTORE_DELAY_MS)
  })
  // an editor already open when this installs (a remount)
  const current = canvas.editingId()
  if (current !== null) open(current)

  return () => {
    off()
    cancelRestore()
    held = null
  }
}
