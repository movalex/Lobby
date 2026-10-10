// OWNER: W4 (wave M, M4-4, FTU-8). Reveal the result: after an AI result, a Mermaid paste, a Piece or a Recap frame is
// written, this tab's camera moves to show it whole, clear of the board's chrome (the safe part of the view:
// ./board-chrome.ts safeViewRect, the view less the style panel, the bottom toolbar and the top-centre stack), when
// it is not already there. It keeps the zoom when the result fits at it, else zooms out to fit (never in, never past
// the board's limits), and centres the result in the safe part. A local camera move only: nothing is written,
// nothing is pushed, nobody else's view moves. It waits two frames, so the chrome that opens with the new selection
// (the style panel) is on the page when it measures. Under reduced motion the camera jumps.

import type { Bounds, LobbyCanvas } from '../../canvas/api/index.ts'
import { prefersReducedMotion } from '../a11y/ported/motion.ts'
import { boardObstacles, type Rect, SAFE_INSET, safeViewRect } from './board-chrome.ts'

export interface RevealOptions {
  /** more boxes to keep the result clear of (client px): a panel of the feature's own, read when it measures */
  readonly avoid?: () => readonly Rect[]
  /** measure now instead of two frames from now (tests) */
  readonly now?: boolean
}

/** Where the camera goes to show scene bounds `b` inside client rect `safe` of a canvas at `view` (pure). */
export function revealCamera(
  b: Bounds,
  safe: Rect,
  view: Rect,
  current: { readonly zoom: number },
  limits: { readonly min: number; readonly max: number } = { min: 0.01, max: 1 },
): { x: number; y: number; zoom: number } {
  const fit = Math.min(safe.width / Math.max(1, b.width), safe.height / Math.max(1, b.height))
  const zoom = Math.max(limits.min, Math.min(current.zoom, fit, limits.max))
  const cx = safe.x + safe.width / 2 - view.x
  const cy = safe.y + safe.height / 2 - view.y
  return { x: b.x + b.width / 2 - cx / zoom, y: b.y + b.height / 2 - cy / zoom, zoom }
}

/** Whether scene bounds `b` lie wholly inside client rect `safe` at the canvas's current camera. */
function shownIn(canvas: Pick<LobbyCanvas, 'sceneToScreen'>, b: Bounds, safe: Rect): boolean {
  const tl = canvas.sceneToScreen({ x: b.x, y: b.y })
  const br = canvas.sceneToScreen({ x: b.x + b.width, y: b.y + b.height })
  return (
    tl.x >= safe.x - 0.5 &&
    tl.y >= safe.y - 0.5 &&
    br.x <= safe.x + safe.width + 0.5 &&
    br.y <= safe.y + safe.height + 0.5
  )
}

const inset = (r: Rect, by: number): Rect => {
  const dx = Math.min(by, r.width / 4)
  const dy = Math.min(by, r.height / 4)
  return { x: r.x + dx, y: r.y + dy, width: r.width - 2 * dx, height: r.height - 2 * dy }
}

/**
 * Moves this tab's camera to show `ids` (see the header). Resolves whether it moved. Never throws: a result is on
 * the board either way.
 */
export function revealResult(
  canvas: LobbyCanvas,
  ids: readonly string[],
  opts: RevealOptions = {},
): Promise<boolean> {
  const run = (): boolean => {
    try {
      const b = canvas.boundsOf(ids)
      if (!b || !ids.length) return false
      const view = canvas.viewport.screenRect()
      const doc = canvas.container()?.ownerDocument ?? null
      const safe = inset(safeViewRect(view, [...boardObstacles(doc), ...(opts.avoid?.() ?? [])]), SAFE_INSET)
      if (shownIn(canvas, b, safe)) return false
      let limits = { min: 0.01, max: 1 }
      try {
        const l = canvas.viewport.limits()
        limits = { min: l.min, max: Math.min(1, l.max) }
      } catch {
        // the camera's limits are 3b's: without them, Lobby's own floor and 100% at most
      }
      const to = revealCamera(b, safe, view, canvas.viewport.get(), limits)
      canvas.viewport.set(to, { animate: !prefersReducedMotion() })
      return true
    } catch (e) {
      console.warn('reveal: could not bring the result into view', e)
      return false
    }
  }
  if (opts.now) return Promise.resolve(run())
  return new Promise((resolve) => {
    const frame = globalThis.requestAnimationFrame
    if (typeof frame !== 'function') {
      setTimeout(() => resolve(run()), 0)
      return
    }
    frame(() => frame(() => resolve(run())))
  })
}
