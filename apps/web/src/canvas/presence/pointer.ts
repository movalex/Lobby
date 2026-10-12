// Lobby's own pointer source for presence (docs/EXCALIDRAW-MIGRATION.md §2.7).
//
// Why not Excalidraw's onPointerUpdate: under the `interaction` config (read-only roles) App.savePointer
// returns before calling it unless the active tool is one the config keeps (laser or custom):
// `if (!this.isInteractionEnabled() && !this.isToolSupported(this.state.activeTool.type)) return`
// (@excalidraw/excalidraw dist/dev/index.js:47784-47786; isToolSupported :42465-42479). So commenters,
// viewers and limited guests would send no cursor with the normal selection tool.
//
// These listeners are passive and capture-phase on the board wrapper, for every role: pointermove,
// pointerdown, pointerup, and pointerleave (-> pointer: null). They never call preventDefault or
// stopPropagation, so Excalidraw's input is untouched. Moves are throttled to `hz` (default 20, leading
// and trailing edge); button changes and leave are sent at once.
//
// While the button is down, the points of the moves between two samples (each move's coalesced points too)
// are kept and handed over with the next sample as `trail` (oldest first, the sample's own point left out):
// the shared laser (wave L, L6-1) draws the path between two 20 Hz messages from them. At most
// MAX_BETWEEN_SAMPLES are kept (thinned evenly beyond that); nothing is kept while the button is up.

import type { PresencePoint, PresenceSample } from './sample.ts'

export type { PresencePoint, PresenceSample } from './sample.ts'

export interface PresencePointerOptions {
  /** Client (viewport) coordinates to scene coordinates, e.g. CanvasPort.screenToScene. */
  toScene: (clientX: number, clientY: number) => PresencePoint
  onSample: (sample: PresenceSample) => void
  hz?: number
  now?: () => number
}

/** The most in-between points one sample carries (more are thinned evenly, the first and last kept). */
export const MAX_BETWEEN_SAMPLES = 32

const thin = (points: PresencePoint[], n: number): PresencePoint[] => {
  if (points.length <= n) return points
  const out: PresencePoint[] = []
  for (let i = 0; i < n; i++)
    out.push(points[Math.round((i * (points.length - 1)) / (n - 1))] as PresencePoint)
  return out
}

export function attachPresencePointer(wrapper: HTMLElement, opts: PresencePointerOptions): () => void {
  const interval = 1000 / (opts.hz ?? 20)
  const now = opts.now ?? (() => performance.now())
  let button: 'down' | 'up' = 'up'
  let lastSent = Number.NEGATIVE_INFINITY
  let trailing: ReturnType<typeof setTimeout> | null = null
  let latest: PointerEvent | null = null
  let left = false
  /** the points passed since the last sample, while the button is down */
  let between: PresencePoint[] = []

  /** Keeps the points of a move (its coalesced ones, else its own) while the button is down. */
  const keep = (e: PointerEvent) => {
    if (button !== 'down') return
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    for (const c of list.length ? list : [e]) between.push(opts.toScene(c.clientX, c.clientY))
    if (between.length > MAX_BETWEEN_SAMPLES) between = thin(between, MAX_BETWEEN_SAMPLES / 2)
  }
  /** The kept points before `pointer` (the sample's own point, the last one kept, is left out). */
  const takeBetween = (pointer: PresencePoint | null): PresencePoint[] => {
    const out = between
    between = []
    const last = out[out.length - 1]
    if (pointer && last && Math.abs(last.x - pointer.x) < 0.5 && Math.abs(last.y - pointer.y) < 0.5) out.pop()
    return out
  }

  const sample = (e: PointerEvent, source: string, pointer: PresencePoint | null) => {
    lastSent = now()
    const trail = takeBetween(pointer)
    opts.onSample({
      pointer,
      button,
      source,
      pointerType: e.pointerType,
      ...(trail.length ? { trail } : {}),
    })
  }
  const flushTrailing = () => {
    trailing = null
    if (latest) sample(latest, 'pointermove', opts.toScene(latest.clientX, latest.clientY))
    latest = null
  }
  const cancelTrailing = () => {
    if (trailing !== null) clearTimeout(trailing)
    trailing = null
    latest = null
  }

  const onMove = (e: PointerEvent) => {
    if (!e.isPrimary) return
    left = false
    // a move with no button held, after a press this listener never saw end (let go over the page's chrome, in another
    // window): the press is over. Sent as the release it is, so the laser (and a drag marker) do not follow a free mouse.
    if (button === 'down' && e.buttons === 0) {
      cancelTrailing()
      button = 'up'
      between = []
      sample(e, 'pointerup', opts.toScene(e.clientX, e.clientY))
      return
    }
    keep(e)
    const wait = lastSent + interval - now()
    if (wait <= 0) {
      cancelTrailing()
      sample(e, 'pointermove', opts.toScene(e.clientX, e.clientY))
      return
    }
    latest = e
    if (trailing === null) trailing = setTimeout(flushTrailing, wait)
  }
  const onDown = (e: PointerEvent) => {
    if (!e.isPrimary) return
    left = false
    cancelTrailing()
    between = []
    button = 'down'
    sample(e, 'pointerdown', opts.toScene(e.clientX, e.clientY))
  }
  const onUp = (e: PointerEvent) => {
    if (!e.isPrimary) return
    cancelTrailing()
    button = 'up'
    sample(e, 'pointerup', opts.toScene(e.clientX, e.clientY))
  }
  const onLeave = (e: PointerEvent) => {
    // pointerleave does not bubble, but capture listeners still see it for every element the pointer
    // leaves. Only leaving the board counts: the wrapper itself, or its child (Excalidraw's container)
    // when the wrapper is display: contents. Both can fire for one exit; one null is sent.
    if ((e.target !== wrapper && e.target !== wrapper.firstElementChild) || !e.isPrimary || left) return
    left = true
    cancelTrailing()
    between = []
    sample(e, 'pointerleave', null)
  }

  const passiveCapture = { capture: true, passive: true } as const
  wrapper.addEventListener('pointermove', onMove, passiveCapture)
  wrapper.addEventListener('pointerdown', onDown, passiveCapture)
  wrapper.addEventListener('pointerup', onUp, passiveCapture)
  wrapper.addEventListener('pointerleave', onLeave, passiveCapture)
  return () => {
    cancelTrailing()
    wrapper.removeEventListener('pointermove', onMove, passiveCapture)
    wrapper.removeEventListener('pointerdown', onDown, passiveCapture)
    wrapper.removeEventListener('pointerup', onUp, passiveCapture)
    wrapper.removeEventListener('pointerleave', onLeave, passiveCapture)
  }
}
