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

export interface PresencePoint {
  x: number
  y: number
}

export interface PresenceSample {
  /** Scene coordinates, or null when the pointer left the board. */
  pointer: PresencePoint | null
  button: 'down' | 'up'
  /** The DOM event that produced it, for tests: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointerleave'. */
  source: string
  pointerType: string
}

export interface PresencePointerOptions {
  /** Client (viewport) coordinates to scene coordinates, e.g. CanvasPort.screenToScene. */
  toScene: (clientX: number, clientY: number) => PresencePoint
  onSample: (sample: PresenceSample) => void
  hz?: number
  now?: () => number
}

export function attachPresencePointer(wrapper: HTMLElement, opts: PresencePointerOptions): () => void {
  const interval = 1000 / (opts.hz ?? 20)
  const now = opts.now ?? (() => performance.now())
  let button: 'down' | 'up' = 'up'
  let lastSent = Number.NEGATIVE_INFINITY
  let trailing: ReturnType<typeof setTimeout> | null = null
  let latest: PointerEvent | null = null
  let left = false

  const sample = (e: PointerEvent, source: string, pointer: PresencePoint | null) => {
    lastSent = now()
    opts.onSample({ pointer, button, source, pointerType: e.pointerType })
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
