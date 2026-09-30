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
 *    position) and whether the board has the keyboard.
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

export class BoardInput {
  private readonly o: BoardInputOptions
  private state: PointerState | null = null
  private keyboard = false
  private hoverFrame: number | null = null
  private hoverAt: { x: number; y: number } | null = null
  private hoverCache: { x: number; y: number; id: string | null } | null = null
  private readonly offs: (() => void)[] = []

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
    on(root, 'pointerdown', (e) => this.onPointer(e, 'pointer-down'))
    on(root, 'pointermove', (e) => this.onPointer(e, 'pointer-move'))
    on(root, 'pointerup', (e) => this.onPointer(e, 'pointer-up'))
    on(root, 'dblclick', (e) => this.onPointer(e, 'double-click'))
    on(root, 'contextmenu', (e) => this.onPointer(e, 'context-menu'))
    on(root, 'wheel', (e) => this.onWheel(e), { capture: true, passive: false })
    on(root, 'pointerleave', () => this.onLeave())
    const doc = root.ownerDocument
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
  ): void {
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
    if (!over) return
    const listeners = this.o.listeners()
    if (!listeners.length) return
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
