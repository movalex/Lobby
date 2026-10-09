/**
 * The board page's engine handles (`BoardHandles`, canvas/api/impl.ts): what 2C's board-page members of
 * `LobbyCanvas` do on the Excalidraw host, the engine core, the lease, undo and presence. The session
 * (./session.ts) builds them once the host is initialised and passes them to `createLobbyCanvas`.
 *
 * Every document write still goes through `CanvasPort.transact` (one undo step, pushed by the sync
 * engine). Camera moves, the next-element style and the cursor are view state (no push).
 *
 * Browser only.
 */
import { randomId } from '@excalidraw/common'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardConcern, BoardEvent, BoardHandles } from '../api/impl.ts'
import type {
  ArrowKind,
  Bounds,
  CameraMove,
  CanvasGesture,
  EditOptions,
  LobbyCanvasEventMap,
  StyleValues,
  Viewport,
} from '../api/lobby-canvas.ts'
import { CAMERA_ANIMATION_MS } from '../api/lobby-canvas.ts'
import { prefersReducedMotion } from '../api/parts/navigation.ts'
import type { FeatureRegistries } from '../api/registries.ts'
import type { UndoController } from '../history/controller.ts'
import type { CanvasInput } from '../input/CanvasInput.ts'
import type { LeaseClient } from '../lease/client.ts'
import type { RenderOverrides } from '../overrides.ts'
import type { LobbyCanvasPort } from '../port-impl.ts'
import { nextNoteFill } from '../tools/notes.ts'
import { joinInto, joinMark } from './history-join.ts'
import { hitTest } from './hit.ts'
import type { BoardInput } from './input.ts'
import type { PeerStore } from './peers.ts'
import type { SettingsStore } from './settings.ts'
import { layoutReplacement, measureText } from './text.ts'

export interface HandleDeps {
  readonly api: ExcalidrawImperativeAPI
  readonly port: LobbyCanvasPort
  readonly registries: FeatureRegistries
  readonly input: CanvasInput
  readonly board: BoardInput
  readonly lease: LeaseClient
  readonly undo: UndoController
  readonly overrides: RenderOverrides
  readonly peers: PeerStore
  readonly settings: SettingsStore
  /** the board's canvas region (./input.ts `root`) */
  readonly root: HTMLElement
  readOnly(): boolean
  theme(): 'light' | 'dark'
  /** Lobby's undo and redo (the session's, with their notices) */
  runUndo(dir: 'undo' | 'redo'): void
  /** the image loader's state of a file, or undefined */
  fileState(fileId: string): string | undefined
  /** the lease id of this tab's open (granted) editor */
  editingLease(): string | null
  /** subscribe to the session's concerns and events */
  subscribe(concern: BoardConcern, listener: () => void): () => void
  on<E extends BoardEvent>(event: E, listener: LobbyCanvasEventMap[E]): () => void
  docWritten(keys: readonly string[]): void
  /** waits until the core has pushed its pending changes to `ids` (or `timeoutMs`) */
  pushed(ids: readonly string[], timeoutMs: number): Promise<void>
  /** a concern changed that only the handles know of (the next-element styles) */
  changed(concern: BoardConcern): void
  /** wave L: the contracts revision the room announced on the current socket, or null (the session's) */
  contractsRev(): number | null
}

const excalidrawContainer = (root: HTMLElement) => root.querySelector<HTMLElement>('.excalidraw')

/**
 * A connector's kind as the engine's `currentItemArrowType` (CR-W5-3A-1, W5-40): straight is 'sharp' (no
 * roundness), curved is 'round', and an elbow is 'elbow'. The engine reads this, not `currentItemRoundness`
 * (which is the corners of shapes and plain lines), to make the next arrow.
 */
const ARROW_TYPE_OF: Readonly<Record<ArrowKind, 'sharp' | 'round' | 'elbow'>> = {
  straight: 'sharp',
  curved: 'round',
  elbow: 'elbow',
}

/** The connector kind of an engine arrow type (anything but 'round' and 'elbow' is straight). */
export const arrowKindOf = (type: string | undefined): ArrowKind =>
  type === 'elbow' ? 'elbow' : type === 'round' ? 'curved' : 'straight'

/** The engine's current-item state as Lobby's style vocabulary (the engine's field names). */
export function nextStyles(api: ExcalidrawImperativeAPI): StyleValues {
  const s = api.getAppState()
  return {
    strokeColor: s.currentItemStrokeColor,
    backgroundColor: s.currentItemBackgroundColor,
    fillStyle: s.currentItemFillStyle,
    strokeStyle: s.currentItemStrokeStyle,
    roughness: s.currentItemRoughness,
    opacity: s.currentItemOpacity,
    fontFamily: s.currentItemFontFamily,
    fontSize: s.currentItemFontSize,
    textAlign: s.currentItemTextAlign,
    startArrowhead: s.currentItemStartArrowhead,
    endArrowhead: s.currentItemEndArrowhead,
    roundness: s.currentItemRoundness === 'round' ? 'round' : 'sharp',
    elbowed: s.currentItemArrowType === 'elbow',
    arrowKind: arrowKindOf(s.currentItemArrowType),
    noteColor: nextNoteFill(s),
  }
}

const STROKE_KEY_BY_WIDTH: Readonly<Record<number, 'thin' | 'medium' | 'bold'>> = {
  1: 'thin',
  2: 'medium',
  4: 'bold',
}

/**
 * The engine's app-state fields for a next-style patch. A connector's kind (`arrowKind`) is its arrow type;
 * `roundness` is the corners of the next shape or line, never the connector's. The older pair a caller may
 * still send, `elbowed` with `roundness` and no `arrowKind`, is one connector pick: elbow, curved (round)
 * or straight, and leaves the corners alone.
 */
export function nextStylePatch(p: StyleValues): Record<string, unknown> {
  const a: Record<string, unknown> = {}
  if (p.strokeColor !== undefined) a.currentItemStrokeColor = p.strokeColor
  if (p.backgroundColor !== undefined) a.currentItemBackgroundColor = p.backgroundColor
  if (p.fillStyle !== undefined) a.currentItemFillStyle = p.fillStyle
  if (p.strokeWidth !== undefined && STROKE_KEY_BY_WIDTH[p.strokeWidth])
    a.currentItemStrokeWidthKey = STROKE_KEY_BY_WIDTH[p.strokeWidth]
  if (p.strokeStyle !== undefined) a.currentItemStrokeStyle = p.strokeStyle
  if (p.roughness !== undefined) a.currentItemRoughness = p.roughness
  if (p.opacity !== undefined) a.currentItemOpacity = p.opacity
  if (p.fontFamily !== undefined) a.currentItemFontFamily = p.fontFamily
  if (p.fontSize !== undefined) a.currentItemFontSize = p.fontSize
  if (p.textAlign !== undefined) a.currentItemTextAlign = p.textAlign
  if (p.startArrowhead !== undefined) a.currentItemStartArrowhead = p.startArrowhead
  if (p.endArrowhead !== undefined) a.currentItemEndArrowhead = p.endArrowhead
  // CR-3A-7: the next note's fill is the engine's next sticky-note fill (Lobby's notes are its sticky notes)
  if (p.noteColor !== undefined) a.currentItemStickynoteBackgroundColor = p.noteColor
  if (p.arrowKind !== undefined) a.currentItemArrowType = ARROW_TYPE_OF[p.arrowKind]
  else if (p.elbowed !== undefined)
    a.currentItemArrowType = p.elbowed ? 'elbow' : p.roundness === 'round' ? 'round' : 'sharp'
  if (p.roundness !== undefined && (p.arrowKind !== undefined || p.elbowed === undefined))
    a.currentItemRoundness = p.roundness
  return a
}

/**
 * Lobby's own camera animation (Excalidraw's `updateScene` moves at once). CR 3b-9: while a tween changes
 * the zoom, the engine reuses its cached element bitmaps at the old zoom (`shouldCacheIgnoreZoom`, as its own
 * wheel zoom does) instead of re-rendering every element on every frame; the last frame draws them sharp.
 */
export class CameraTween {
  private frame: number | null = null
  private lastUserMove = 0
  private cacheIgnoring = false
  private readonly set: (v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>) => void
  private readonly get: () => Viewport
  private readonly ignoreZoomCache: (on: boolean) => void
  constructor(
    set: (v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>) => void,
    get: () => Viewport,
    ignoreZoomCache: (on: boolean) => void = () => {},
  ) {
    this.set = set
    this.get = get
    this.ignoreZoomCache = ignoreZoomCache
  }

  private cache(on: boolean): void {
    if (this.cacheIgnoring === on) return
    this.cacheIgnoring = on
    this.ignoreZoomCache(on)
  }

  userMoved(): void {
    this.lastUserMove = performance.now()
  }

  get animating(): boolean {
    return this.frame !== null
  }

  moving(): boolean {
    return this.frame !== null || performance.now() - this.lastUserMove < 150
  }

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.cache(false)
  }

  /** Moves to `to` (a scene rectangle's top-left and a zoom), animated over `ms`. */
  run(to: { x: number; y: number; zoom: number }, ms: number): void {
    this.stop()
    const from = this.get()
    const start = performance.now()
    // interpolate the scene point at the viewport centre and the zoom (log scale), like a camera move
    const cFrom = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const w = (from.width * from.zoom) / to.zoom
    const h = (from.height * from.zoom) / to.zoom
    const cTo = { x: to.x + w / 2, y: to.y + h / 2 }
    if (to.zoom !== from.zoom) this.cache(true)
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms)
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e)
      const cx = cFrom.x + (cTo.x - cFrom.x) * e
      const cy = cFrom.y + (cTo.y - cFrom.y) * e
      const cur = this.get()
      const vw = (cur.width * cur.zoom) / zoom
      const vh = (cur.height * cur.zoom) / zoom
      if (t >= 1) this.cache(false)
      this.set({ x: cx - vw / 2, y: cy - vh / 2, zoom })
      if (t < 1) this.frame = requestAnimationFrame(step)
      else this.frame = null
    }
    this.frame = requestAnimationFrame(step)
  }
}

/**
 * How long a camera move animates, or null for an immediate one. Under `prefers-reduced-motion: reduce`
 * every move is immediate, whoever asked for it (W5-21, WCAG 2.3.3): Follow and Gather, a presenter moving
 * everyone, a comment jump, an AI result, History, the mind map. One place, so no caller has to ask.
 */
export const durationOf = (m?: CameraMove): number | null => {
  if (!m?.animate) return null
  if (prefersReducedMotion()) return null
  return typeof m.animate === 'object' ? m.animate.durationMs : CAMERA_ANIMATION_MS
}

export function createBoardHandles(d: HandleDeps): BoardHandles & {
  /** Excalidraw's scroll moved (a pan or a zoom): `viewport.moving()` for the next 150 ms */
  userMoved(): void
  /** the text editor state changed (`text.edit` resolves on it) */
  editStateChanged(phase: string, leaseId: string | null): void
  dispose(): void
} {
  const { api, port } = d
  const tween = new CameraTween(
    (v) => port.viewport.set(v),
    () => port.viewport.get(),
    (on) => api.updateScene({ appState: { shouldCacheIgnoreZoom: on } }),
  )
  const editWaiters = new Set<(phase: string, leaseId: string | null) => void>()
  const pendingNext: Record<string, unknown> = {}
  const hiddenOwners = new Map<string, Set<string>>()

  const fitTarget = (ids?: readonly string[]) => {
    const list = ids?.length ? ids : port.items().map((e) => e.id)
    let x1 = Number.POSITIVE_INFINITY
    let y1 = Number.POSITIVE_INFINITY
    let x2 = Number.NEGATIVE_INFINITY
    let y2 = Number.NEGATIVE_INFINITY
    for (const id of list) {
      const b = port.bounds(id)
      if (!b) continue
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.width)
      y2 = Math.max(y2, b.y + b.height)
    }
    if (!Number.isFinite(x1)) return null
    const s = api.getAppState()
    const w = Math.max(1, x2 - x1)
    const h = Math.max(1, y2 - y1)
    const zoom = Math.max(0.1, Math.min(1, Math.min(s.width / w, s.height / h) * 0.8))
    return { x: x1 + w / 2 - s.width / zoom / 2, y: y1 + h / 2 - s.height / zoom / 2, zoom }
  }

  const gesture = (): CanvasGesture => {
    const s = api.getAppState()
    const editing = d.input.editorLease?.phase ?? 'idle'
    if (s.editingTextElement || editing !== 'idle') return 'editing-text'
    if (s.isResizing) return 'resizing'
    if (s.isRotating) return 'rotating'
    if (s.selectedElementsAreBeingDragged) return 'dragging'
    if (s.selectionElement) return 'box-selecting'
    if (s.newElement || s.multiElement) return 'drawing'
    const p = d.board.pointer()
    const tool = s.activeTool.type
    if (tool === 'hand' && p?.down) return 'panning'
    if (tool !== 'selection' && tool !== 'lasso') return 'tool'
    return p?.down ? 'pressing' : 'idle'
  }

  const labelTarget = (id: string): { leaseId: string; textId: string | null } | null => {
    const el = port.get(id)
    if (!el || el.isDeleted) return null
    if (el.type === 'text') return { leaseId: el.containerId || el.id, textId: el.id }
    const bound = (
      (el as { boundElements?: { id: string; type: string }[] | null }).boundElements ?? []
    ).find((b) => b.type === 'text')
    return { leaseId: el.id, textId: bound?.id ?? null }
  }

  const handles: BoardHandles & {
    userMoved(): void
    editStateChanged(phase: string, leaseId: string | null): void
    dispose(): void
  } = {
    subscribe: d.subscribe,
    on: d.on,
    readOnly: d.readOnly,
    container: () => d.root,
    focus(opts) {
      const el = excalidrawContainer(d.root)
      el?.focus({ preventScroll: opts?.preventScroll ?? true })
    },
    hasKeyboard: () => d.board.hasKeyboard(),
    setCursor(cursor) {
      if (cursor) api.setCursor(cursor)
      else api.resetCursor()
    },
    theme: d.theme,
    pointer: () => d.board.pointer(),
    gesture,
    hitTest: (point, opts = {}) => hitTest(api, point, opts, (id) => d.registries.hidden.isHidden(id)),
    hovered: () => d.board.hovered(),
    hide(owner, ids) {
      const set = new Set(ids)
      hiddenOwners.set(owner, set)
      d.overrides.setHidden(owner, set)
      return () => {
        if (hiddenOwners.get(owner) !== set) return
        hiddenOwners.delete(owner)
        d.overrides.setHidden(owner, null)
      }
    },
    viewport: {
      set(v, opts) {
        const ms = durationOf(opts)
        if (ms === null) {
          tween.stop()
          port.viewport.set(v)
          return
        }
        const cur = port.viewport.get()
        tween.run({ x: v.x ?? cur.x, y: v.y ?? cur.y, zoom: v.zoom ?? cur.zoom }, ms)
      },
      fit(ids, opts) {
        const ms = durationOf(opts)
        if (ms === null) {
          tween.stop()
          port.viewport.fit(ids)
          return
        }
        const to = fitTarget(ids)
        if (to) tween.run(to, ms)
      },
      stop: () => tween.stop(),
      moving: () => tween.moving(),
      screenRect(): Bounds {
        const s = api.getAppState()
        return { x: s.offsetLeft, y: s.offsetTop, width: s.width, height: s.height }
      },
      remeasure: () => api.refresh(),
    },
    text: {
      edit(id: string, opts: EditOptions): Promise<boolean> {
        const editor = d.input.editorLease
        const t = labelTarget(id)
        if (!editor || !t || d.readOnly()) return Promise.resolve(false)
        const first = opts.initialText ? [...opts.initialText] : []
        const key = (ch: string) => ({ key: ch, code: '', shiftKey: false })
        const started = editor.requestEdit(t.leaseId, {
          reason: `api:${opts.via}`,
          caretEnd: opts.caret !== 'all',
          ...(first[0] ? { firstKey: key(first[0]) } : {}),
        })
        if (!started) return Promise.resolve(editor.phase === 'open' && editor.leaseId === t.leaseId)
        for (const ch of first.slice(1)) editor.bufferKey(key(ch))
        if (editor.phase === 'open' && editor.leaseId === t.leaseId) return Promise.resolve(true)
        return new Promise((resolve) => {
          const done = (phase: string, leaseId: string | null) => {
            if (phase === 'open' && leaseId === t.leaseId) finish(true)
            else if (phase === 'idle' || (leaseId !== null && leaseId !== t.leaseId)) finish(false)
          }
          const finish = (ok: boolean) => {
            editWaiters.delete(done)
            resolve(ok)
          }
          editWaiters.add(done)
        })
      },
      stop(opts) {
        const editor = d.input.editorLease
        if (!editor) return
        if (editor.phase !== 'open') {
          editor.cancel()
          return
        }
        const ta = editor.textarea()
        if (!ta) return
        if (opts?.cancel) {
          const id = editor.leaseId
          const el = id ? port.get(id) : undefined
          const t = id ? labelTarget(id) : null
          const original = t?.textId ? port.engine?.confirmed(t.textId) : el
          const words = (original as { originalText?: string } | undefined)?.originalText
          if (words !== undefined && ta.value !== words) {
            ta.value = words
            ta.dispatchEvent(new Event('input', { bubbles: true }))
          }
        }
        const esc = new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
        })
        d.input.synthetic.add(esc)
        ta.dispatchEvent(esc)
      },
      editorElement() {
        const editor = d.input.editorLease
        if (editor?.phase !== 'open') return null
        const ta = editor.textarea()
        return ta && editor.isWritable(ta) ? ta : null
      },
      measure: (text, style) => measureText(text, style),
      async replace(id, text, label) {
        const t = labelTarget(id)
        if (!t?.textId || d.readOnly()) return false
        if (d.editingLease() === t.leaseId) return false // this tab's own editor is open on it
        const heldBefore = d.lease.isHeld(t.leaseId)
        const out = await d.lease.acquire(t.leaseId)
        if (!out.granted) return false
        try {
          const writes = layoutReplacement(api, t.textId, text)
          port.transact(label ?? 'text.replace', (tx) => {
            for (const [eid, patch] of writes) tx.update(eid, patch)
          })
          await d.pushed([...writes.keys()], 5_000)
        } finally {
          if (!heldBefore) d.lease.release(t.leaseId)
        }
        return true
      },
    },
    styles: {
      // Excalidraw applies an appState update on its next render: until then the values just set are
      // read from here, so a read right after setNext sees them
      next() {
        const base = nextStyles(api) as Record<string, unknown>
        for (const [k, v] of Object.entries(pendingNext)) if (base[k] === v) delete pendingNext[k]
        const out = { ...base, ...pendingNext }
        // the connector kind just set reads back as its elbow flag too
        if (typeof pendingNext.arrowKind === 'string') out.elbowed = pendingNext.arrowKind === 'elbow'
        return out as StyleValues
      },
      setNext(patch) {
        const appState = nextStylePatch(patch)
        if (!Object.keys(appState).length) return
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || k === 'strokeWidth') continue
          // a legacy elbowed / roundness pair is a connector pick: its roundness never reaches the engine's
          // corners, so it must not wait there to be read back
          if (k === 'roundness' && !('currentItemRoundness' in appState)) continue
          pendingNext[k] = v
        }
        api.updateScene({ appState: appState as never })
        d.changed('tool')
      },
    },
    presence: {
      peers: () => d.peers.peers(),
      peer: (sid) => d.peers.peer(sid),
    },
    history: {
      undo: () => d.runUndo('undo'),
      redo: () => d.runUndo('redo'),
      canUndo: () => d.undo.history.undoSize > 0,
      canRedo: () => d.undo.history.redoSize > 0,
      joinPrevious<T>(write: () => T): T {
        // anything the user did and was not recorded yet is its own step first
        d.undo.boundary()
        const mark = joinMark(d.undo.history)
        const result = write()
        joinInto(d.undo.history, mark)
        return result
      },
    },
    files: {
      status(id) {
        const el = port.get(id) as { type?: string; fileId?: string | null } | undefined
        if (el?.type !== 'image' || !el.fileId) return null
        const st = d.fileState(el.fileId)
        if (st === 'loaded') return 'loaded'
        if (st === 'failed') return 'failed'
        return st === undefined ? null : 'loading'
      },
    },
    settings: {
      get: () => d.settings.get(),
      set: (patch) => d.settings.set(patch),
    },
    room: { contractsRev: () => d.contractsRev() },
    docWritten: d.docWritten,
    newId: () => randomId(),
    userMoved: () => {
      if (!tween.animating) tween.userMoved()
    },
    editStateChanged(phase, leaseId) {
      for (const w of [...editWaiters]) w(phase, leaseId)
    },
    dispose() {
      tween.stop()
      editWaiters.clear()
      for (const owner of hiddenOwners.keys()) d.overrides.setHidden(owner, null)
      hiddenOwners.clear()
    },
  }
  return handles
}
