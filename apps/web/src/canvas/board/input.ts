/**
 * The board page's outer input layer (docs/EXCALIDRAW-CONTRACTS.md §2.1 `on('input')`, `pointer`,
 * `hovered`, `hasKeyboard`, §3 the key registry). Capture-phase listeners on the board's canvas region,
 * an ANCESTOR of the Excalidraw host's wrapper, so they run before spike B's input layer
 * (canvas/input/CanvasInput.ts: the allowlist, the editor-open guard, double-tap) and before Excalidraw:
 *
 *  - keydown: the Lobby-owned keys features register (`registries.keys`: commands with `kbd`, feature
 *    keys). `canvas` scope: the board has the keyboard (the event is inside Excalidraw's container) and
 *    no text editor is open or pending; `editor` scope: inside the granted editor. A handler that returns
 *    true stops and prevents the key. Keys no handler takes go on to the allowlist, which blocks or
 *    delegates them as before. Keys typed into an overlay's own field (a comment composer) are never
 *    board keys;
 *  - pointer, wheel, double-click and context-menu events over the canvas (not over an overlay): the
 *    `input` stream, before the engine; `handled()` stops the engine from acting on the event;
 *  - the pointer state (`pointer()`), what is under it (`hovered()`, computed lazily at the last pointer
 *    position) and whether the board has the keyboard;
 *  - the two-finger touch pinch (CR 3b-10): a `pinch` input event when the second finger lands, on each
 *    move of either and when one lifts, with the fingers' spread and middle (`TouchPinchTracker`). The
 *    engine pinches itself; a listener that `handled()` a move keeps the engine from acting on it.
 *
 * Browser only.
 */
import type {
  CanvasElement,
  CanvasInputEvent,
  InputModifiers,
  LobbyCanvas,
  PointerState,
  ScenePoint,
  TouchPinch,
} from '../api/lobby-canvas.ts'
import type { KeyHandlerSpec } from '../registries.ts'

export interface BoardInputOptions {
  /** the board's canvas region (the host's wrapper and the overlay root are inside it) */
  readonly root: HTMLElement
  /** Excalidraw's container (`.excalidraw`), once mounted */
  canvasEl(): HTMLElement | null
  keys(): readonly KeyHandlerSpec[]
  canvas(): LobbyCanvas | null
  /** the text editor's state: none, a request pending, or granted and open */
  editor(): 'none' | 'pending' | 'granted'
  /** whether `ta` is the granted editor's textarea */
  isGrantedEditor(ta: HTMLTextAreaElement): boolean
  toScene(clientX: number, clientY: number): ScenePoint
  hit(point: ScenePoint): CanvasElement | null
  /** listeners of the `input` stream (the canvas's `on('input')`) */
  listeners(): readonly ((e: CanvasInputEvent) => void)[]
  /** the pointer moved, a button or a modifier changed, or the keyboard came or went */
  onPointerChange(): void
  /** what is under the pointer may have changed (at most once per animation frame) */
  onHoverChange(): void
}

const WYSIWYG = 'excalidraw-wysiwyg'

const isTextEntry = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

const mods = (e: {
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): InputModifiers => ({
  shift: e.shiftKey,
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
})

const pointerTypeOf = (e: Event): 'mouse' | 'pen' | 'touch' => {
  const t = (e as PointerEvent).pointerType
  return t === 'pen' || t === 'touch' ? t : 'mouse'
}

// ---- the two-finger touch pinch ---------------------------------------------------------------------------

/** One step of a pinch: its phase, the spread of the fingers since the start, and where they are. */
export interface PinchStep {
  readonly phase: TouchPinch['phase']
  /** the distance between the fingers now over the distance when the second one went down */
  readonly scale: number
  /** the middle of the fingers now */
  readonly centre: { readonly x: number; readonly y: number }
  /** the middle of the fingers when the second one went down */
  readonly start: { readonly x: number; readonly y: number }
}

/**
 * Follows the touch fingers on the canvas and says when two of them make a pinch, the way Excalidraw's own
 * gesture state reads them (its `gesture.pointers`: a pinch begins when the second finger goes down, and
 * ends when there are not exactly two; a third finger ends it for good, as it does there). Pure (Node-tested).
 */
export class TouchPinchTracker {
  private readonly fingers = new Map<number, { x: number; y: number }>()
  private on = false
  private distance0 = 1
  private start = { x: 0, y: 0 }

  /** whether two fingers are pinching now */
  get active(): boolean {
    return this.on
  }

  private centre(): { x: number; y: number } {
    let x = 0
    let y = 0
    for (const p of this.fingers.values()) {
      x += p.x
      y += p.y
    }
    const n = this.fingers.size || 1
    return { x: x / n, y: y / n }
  }

  private distance(): number {
    const [a, b] = [...this.fingers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  private step(phase: PinchStep['phase']): PinchStep {
    // fingers on the same spot (a zero start distance) never divide by nothing
    const scale = phase === 'start' ? 1 : this.distance() / this.distance0
    return { phase, scale: Number.isFinite(scale) ? scale : 1, centre: this.centre(), start: this.start }
  }

  /** A finger went down: `start` when that makes two, `end` when it makes three (or more). */
  down(id: number, x: number, y: number): PinchStep | null {
    this.fingers.set(id, { x, y })
    if (this.fingers.size === 2) {
      this.on = true
      this.start = this.centre()
      this.distance0 = Math.max(1, this.distance())
      return this.step('start')
    }
    return this.end()
  }

  /** A finger moved: a `move` while two are down and this is one of them. */
  move(id: number, x: number, y: number): PinchStep | null {
    const p = this.fingers.get(id)
    if (!p) return null
    p.x = x
    p.y = y
    return this.on ? this.step('move') : null
  }

  /** A finger lifted (or the browser took it): `end` when it ended the pinch. */
  up(id: number): PinchStep | null {
    if (!this.fingers.delete(id)) return null
    return this.end()
  }

  /** Every finger forgotten (the page lost focus): `end` when two were pinching. */
  reset(): PinchStep | null {
    this.fingers.clear()
    return this.end()
  }

  private end(): PinchStep | null {
    if (!this.on) return null
    this.on = false
    return this.step('end')
  }
}

export class BoardInput {
  private readonly o: BoardInputOptions
  private state: PointerState | null = null
  private keyboard = false
  private hoverFrame: number | null = null
  private hoverAt: { x: number; y: number } | null = null
  private hoverCache: { x: number; y: number; id: string | null } | null = null
  private readonly offs: (() => void)[] = []
  private readonly pinch = new TouchPinchTracker()

  constructor(o: BoardInputOptions) {
    this.o = o
    const root = o.root
    const cap = { capture: true } as const
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts: AddEventListenerOptions = cap,
    ) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.offs.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    on(root, 'keydown', (e) => this.onKey(e))
    on(root, 'keyup', (e) => this.onModifier(e))
    on(root, 'pointerdown', (e) => {
      const handled = this.onPointer(e, 'pointer-down')
      // a finger a listener took is not part of a pinch
      if (!handled && e.pointerType === 'touch' && this.overCanvas(e.target))
        this.onPinch(this.pinch.down(e.pointerId, e.clientX, e.clientY), e)
    })
    on(root, 'pointermove', (e) => {
      this.onPointer(e, 'pointer-move')
      if (e.pointerType !== 'touch') return
      // a finger that moves with nothing pressed lost its pointerup (the engine's own state has the same hole)
      const step =
        e.buttons === 0 ? this.pinch.up(e.pointerId) : this.pinch.move(e.pointerId, e.clientX, e.clientY)
      this.onPinch(step, e)
    })
    on(root, 'pointerup', (e) => this.onPointer(e, 'pointer-up'))
    on(root, 'dblclick', (e) => this.onPointer(e, 'double-click'))
    on(root, 'contextmenu', (e) => this.onPointer(e, 'context-menu'))
    on(root, 'wheel', (e) => this.onWheel(e), { capture: true, passive: false })
    on(root, 'pointerleave', () => this.onLeave())
    const doc = root.ownerDocument
    // a finger's end is read on the document, in case its target went away under it
    for (const type of ['pointerup', 'pointercancel'] as const)
      on(doc, type, (e) => {
        if (e.pointerType === 'touch') this.onPinch(this.pinch.up(e.pointerId), e)
      })
    const win = doc.defaultView
    const forgetFingers = () => this.onPinch(this.pinch.reset(), null)
    win?.addEventListener('blur', forgetFingers)
    this.offs.push(() => win?.removeEventListener('blur', forgetFingers))
    on(doc, 'focusin', () => this.syncKeyboard())
    on(doc, 'focusout', () => queueMicrotask(() => this.syncKeyboard()))
  }

  dispose(): void {
    for (const f of this.offs.splice(0)) f()
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame)
  }

  pointer(): PointerState | null {
    return this.state
  }

  hasKeyboard(): boolean {
    return this.keyboard
  }

  /** The element under the pointer (cached per position; the scene is re-read after `invalidate`). */
  hovered(): string | null {
    const s = this.state
    if (!s?.overCanvas) return null
    const c = this.hoverCache
    if (c && c.x === s.scene.x && c.y === s.scene.y) return c.id
    const id = this.o.hit(s.scene)?.id ?? null
    this.hoverCache = { x: s.scene.x, y: s.scene.y, id }
    return id
  }

  /** The scene changed under a still pointer: `hovered` is recomputed on its next read. */
  invalidateHover(): void {
    this.hoverCache = null
    this.scheduleHover()
  }

  private syncKeyboard(): void {
    const el = this.o.canvasEl()
    const active = this.o.root.ownerDocument.activeElement
    const has = !!el && !!active && el.contains(active)
    if (has === this.keyboard) return
    this.keyboard = has
    this.o.onPointerChange()
  }

  private overCanvas(target: EventTarget | null): boolean {
    const el = this.o.canvasEl()
    return !!el && target instanceof Node && el.contains(target)
  }

  // ---- keys -----------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    this.onModifier(e)
    const t = e.target
    const wysiwyg = t instanceof HTMLTextAreaElement && t.classList.contains(WYSIWYG) ? t : null
    let scope: 'canvas' | 'editor' | null = null
    if (wysiwyg) scope = this.o.isGrantedEditor(wysiwyg) ? 'editor' : null
    else if (isTextEntry(t)) scope = null
    else if (this.overCanvas(t) && this.o.editor() === 'none') scope = 'canvas'
    // passive observers (a presentation that ends on any key) see every key over the board
    if (!isTextEntry(t) || wysiwyg) {
      const ev: CanvasInputEvent = { type: 'key-down', key: e.key, code: e.code, ...mods(e) }
      for (const l of this.o.listeners()) l(ev)
    }
    if (!scope || e.isComposing) return
    const canvas = this.o.canvas()
    if (!canvas) return
    for (const spec of this.o.keys()) {
      if (spec.scope !== scope) continue
      let took = false
      try {
        took = spec.match(e) && spec.handle(e, canvas)
      } catch (err) {
        console.error(`key handler ${spec.id} failed`, err)
      }
      if (took) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
  }

  private onModifier(e: KeyboardEvent): void {
    const s = this.state
    if (!s) return
    if (s.shift === e.shiftKey && s.alt === e.altKey && s.ctrl === e.ctrlKey && s.meta === e.metaKey) return
    this.state = { ...s, ...mods(e) }
    this.o.onPointerChange()
  }

  // ---- pointer ----------------------------------------------------------------------------------------

  private onPointer(
    e: MouseEvent,
    type: 'pointer-down' | 'pointer-move' | 'pointer-up' | 'double-click' | 'context-menu',
  ): boolean {
    const over = this.overCanvas(e.target)
    const scene = this.o.toScene(e.clientX, e.clientY)
    const down = type === 'pointer-up' ? (e.buttons & ~1) !== 0 : e.buttons !== 0 || type === 'pointer-down'
    this.state = {
      scene,
      screen: { x: e.clientX, y: e.clientY },
      overCanvas: over,
      down,
      ...mods(e),
    }
    this.o.onPointerChange()
    if (type === 'pointer-move') this.scheduleHover()
    if (!over) return false
    const listeners = this.o.listeners()
    if (!listeners.length) return false
    let handled = false
    let hit: CanvasElement | null | undefined
    const self = this
    const ev = {
      type,
      scene,
      screen: { x: e.clientX, y: e.clientY },
      get hit() {
        if (hit === undefined) hit = self.o.hit(scene)
        return hit
      },
      button: e.button,
      pointerType: pointerTypeOf(e),
      handled() {
        handled = true
      },
      ...mods(e),
    } as CanvasInputEvent
    for (const l of listeners) l(ev)
    if (handled) {
      e.stopPropagation()
      e.preventDefault()
    }
    return handled
  }

  /**
   * A pinch step as a `pinch` input event (CR 3b-10). A listener that `handled()` a move keeps the engine
   * from seeing the finger's pointermove (`e`: the event of the move; none when the page lost focus).
   */
  private onPinch(step: PinchStep | null, e: PointerEvent | null): void {
    if (!step) return
    const listeners = this.o.listeners()
    if (!listeners.length) return
    let handled = false
    const ev: CanvasInputEvent = {
      type: 'pinch',
      screen: { x: step.centre.x, y: step.centre.y },
      touch: {
        phase: step.phase,
        scale: step.scale,
        startScreen: { x: step.start.x, y: step.start.y },
      },
      handled() {
        handled = true
      },
      ...(e ? mods(e) : { shift: false, alt: false, ctrl: false, meta: false }),
    }
    for (const l of listeners) l(ev)
    if (handled && e && step.phase === 'move') {
      e.stopPropagation()
      e.preventDefault()
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.overCanvas(e.target)) return
    const listeners = this.o.listeners()
    if (!listeners.length) return
    let handled = false
    const ev: CanvasInputEvent = {
      type: e.ctrlKey ? 'pinch' : 'wheel',
      screen: { x: e.clientX, y: e.clientY },
      // CR 3b-2: what the engine would zoom or pan by
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      handled() {
        handled = true
      },
      ...mods(e),
    }
    for (const l of listeners) l(ev)
    if (handled) {
      e.stopPropagation()
      e.preventDefault()
    }
  }

  private onLeave(): void {
    if (!this.state) return
    this.state = { ...this.state, overCanvas: false }
    this.o.onPointerChange()
    this.scheduleHover()
  }

  private scheduleHover(): void {
    if (this.hoverFrame !== null) return
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = null
      const s = this.state
      const at = s?.overCanvas ? { x: s.scene.x, y: s.scene.y } : null
      if (at?.x === this.hoverAt?.x && at?.y === this.hoverAt?.y && this.hoverCache) return
      this.hoverAt = at
      this.o.onHoverChange()
    })
  }
}
