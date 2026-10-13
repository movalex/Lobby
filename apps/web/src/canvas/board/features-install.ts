// The board page's install of the canvas features (CANVAS_FEATURES), once per canvas after the first welcome
// (docs/EXCALIDRAW-CONTRACTS.md §4). Wave N.1: on a large board the features' first computations (their overlays
// over thousands of elements) were most of the welcome's long task, so they install once the board has shown
// itself editable (the next frame), in a task of their own. A smaller board installs them at once, as before.
//
// Wave N.1 review: in that window the features' input listeners are not there yet (canvas-ux's double-click note
// and Lobby's context menu, every feature key and tool, the mind map's own marking of a copy this tab makes), and
// the engine acted on the input instead (its text box, its menu, a paste the mind map never saw). So until the
// install the canvas takes no input: a press, a double-click, a right-click, a wheel, a pinch or a key does nothing
// (the board's input layer keeps it from the engine, `handled()`). Hovering and a press's end go through (the engine
// tracks a drag's end on the window), and so do Lobby's own synthetic keys (the text lease) and Tab (the keyboard's
// way off the canvas). A change from someone else in that window needs no replay: each feature reads the canvas as
// it is when it installs (the mind map's index, its hidden branches), and the mind map's keeper fixes up only maps
// this tab changed a moment ago, which a tab that has just opened has not.

import type { CanvasInputEvent, LobbyCanvas } from '../api/lobby-canvas.ts'

/** The frame and task timers the install waits on (the window's; a test passes its own). */
export interface InstallTimers {
  requestAnimationFrame(fn: () => void): number
  cancelAnimationFrame(id: number): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const WINDOW_TIMERS: InstallTimers = {
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * Wave O: how long the install waits for an animation frame. A hidden tab runs none (a big board opened in a
 * background tab would install nothing until the tab was shown), so the install does not wait longer than this: the
 * same 100 ms as the chunked apply's frames (../sync/adapter/chunk-frames.ts animationFrames).
 */
export const FRAME_FALLBACK_MS = 100

/** Whether the engine may act on `e` while the features are not installed yet (see the header). */
export function passesBeforeFeatures(e: CanvasInputEvent): boolean {
  if (e.type === 'pointer-move' || e.type === 'pointer-up') return true
  return e.type === 'key-down' && (e.synthetic || e.key === 'Tab')
}

/**
 * Installs the features (`install`, which returns their uninstall): at once when the board has `laterAbove`
 * elements or fewer, else a frame and a task later (or FRAME_FALLBACK_MS later, whichever comes first, and only once),
 * the canvas taking no input meanwhile. Returns the cleanup (before the install: nothing is installed, and the canvas
 * takes input again).
 */
export function installFeaturesAfterWelcome(
  canvas: Pick<LobbyCanvas, 'items' | 'on'>,
  laterAbove: number,
  install: () => () => void,
  timers: InstallTimers = WINDOW_TIMERS,
): () => void {
  if (canvas.items().length <= laterAbove) return install()
  let gate: (() => void) | null = canvas.on('input', (e) => {
    if (!passesBeforeFeatures(e)) e.handled()
  })
  const open = () => {
    gate?.()
    gate = null
  }
  let uninstall: (() => void) | null = null
  let done = false
  let frame: number | null = null
  let task: unknown = null
  let fallback: unknown = null
  const cancelWaits = () => {
    if (frame !== null) timers.cancelAnimationFrame(frame)
    if (task !== null) timers.clearTimeout(task)
    if (fallback !== null) timers.clearTimeout(fallback)
    frame = null
    task = null
    fallback = null
  }
  // whichever comes first installs, once: the frame's task, or the fallback (a task of its own already)
  const go = () => {
    if (done) return
    done = true
    cancelWaits()
    open()
    uninstall = install()
  }
  frame = timers.requestAnimationFrame(() => {
    frame = null
    task = timers.setTimeout(() => {
      task = null
      go()
    }, 0)
  })
  fallback = timers.setTimeout(() => {
    fallback = null
    go()
  }, FRAME_FALLBACK_MS)
  return () => {
    done = true
    cancelWaits()
    open()
    uninstall?.()
  }
}
