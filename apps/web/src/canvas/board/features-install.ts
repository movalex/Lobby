// The board page's install of the canvas features (CANVAS_FEATURES), once per canvas after the first welcome
// (docs/EXCALIDRAW-CONTRACTS.md §4). Wave N.1: on a large board the features' first computations (their overlays
// over thousands of elements) were most of the welcome's long task, so they install once the board has shown
// itself editable (the next frame), in a task of their own. A smaller board installs them at once, as before.

import type { LobbyCanvas } from '../api/lobby-canvas.ts'

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
 * Installs the features (`install`, which returns their uninstall): at once when the board has `laterAbove`
 * elements or fewer, else a frame and a task later. Returns the cleanup (before the install: nothing is installed).
 */
export function installFeaturesAfterWelcome(
  canvas: Pick<LobbyCanvas, 'items' | 'on'>,
  laterAbove: number,
  install: () => () => void,
  timers: InstallTimers = WINDOW_TIMERS,
): () => void {
  if (canvas.items().length <= laterAbove) return install()
  let uninstall: (() => void) | null = null
  let timer: unknown = null
  const frame = timers.requestAnimationFrame(() => {
    timer = timers.setTimeout(() => {
      timer = null
      uninstall = install()
    }, 0)
  })
  return () => {
    timers.cancelAnimationFrame(frame)
    if (timer !== null) timers.clearTimeout(timer)
    uninstall?.()
  }
}
