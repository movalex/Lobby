/**
 * N1-4 (wave N, PERF-3c): the board page's frames for a chunked cold open (the core's ChunkScheduler) and the
 * elements it shows first (those in the canvas's view). Browser only for the frames (requestAnimationFrame);
 * `idsInView` is pure.
 */
import { CHUNK_SIZE, CHUNK_THRESHOLD } from '../flags.ts'
import type { ChunkScheduler, SceneElement } from '../types.ts'

/** N1-4: the frames a chunked install runs on: the next animation frame, or 100 ms in a tab that does not paint. */
export function animationFrames(
  first: (elements: readonly SceneElement[]) => ReadonlySet<string>,
): ChunkScheduler {
  return {
    threshold: CHUNK_THRESHOLD,
    size: CHUNK_SIZE,
    frame(fn) {
      let done = false
      const run = () => {
        if (done) return
        done = true
        cancelAnimationFrame(raf)
        clearTimeout(timer)
        fn()
      }
      const raf = requestAnimationFrame(run)
      const timer = setTimeout(run, 100)
      return () => {
        done = true
        cancelAnimationFrame(raf)
        clearTimeout(timer)
      }
    },
    cancel: (h) => (h as () => void)(),
    first,
  }
}

/** N1-4: the ids of `elements` whose box meets the scene rectangle `view` (its points' box for a line or arrow). */
export function idsInView(
  elements: readonly SceneElement[],
  view: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Set<string> {
  const out = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const e = el as unknown as {
      x?: number
      y?: number
      width?: number
      height?: number
      points?: number[][]
    }
    let x0 = e.x ?? 0
    let y0 = e.y ?? 0
    let x1 = x0 + Math.max(0, e.width ?? 0)
    let y1 = y0 + Math.max(0, e.height ?? 0)
    if (Array.isArray(e.points))
      for (const p of e.points) {
        const px = (e.x ?? 0) + (p[0] ?? 0)
        const py = (e.y ?? 0) + (p[1] ?? 0)
        if (px < x0) x0 = px
        if (py < y0) y0 = py
        if (px > x1) x1 = px
        if (py > y1) y1 = py
      }
    if (x1 < view.x || y1 < view.y || x0 > view.x + view.width || y0 > view.y + view.height) continue
    out.add(el.id)
  }
  return out
}
