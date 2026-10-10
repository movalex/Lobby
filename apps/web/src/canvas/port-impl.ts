/**
 * `CanvasPort` (./port.ts, frozen at C0) on the Excalidraw host and the engine core (docs/EXCALIDRAW-
 * MIGRATION.md §2.3.1). Features (O5), the test facade (O3) and the installers only see the interface.
 *
 * Every write goes through `transact`: the writes of one call become new element versions installed with
 * one `updateScene` (captureUpdate NEVER), which the engine core scans at once (`syncScene`: Saved and
 * the offline queue know of the write before Excalidraw's onChange) and pushes as ordinary edits; the
 * call is one undo step (none with `skipUndo`). Nothing here calls `updateScene` with elements for any
 * other reason.
 *
 * Browser only.
 */
import type { LeaseHolder, RosterEntry } from '@draftroom/canvas-schema/protocol'
import * as el from '@excalidraw/element'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { generateKeyBetween } from '@excalidraw/fractional-indexing'
import type { TransactOptions } from './api/lobby-canvas.ts'
import type { UndoController } from './history/controller.ts'
import type {
  Bounds,
  CanvasElement,
  CanvasEventMap,
  CanvasPort,
  CanvasTx,
  ItemKind,
  ScenePoint,
  ScreenPoint,
  Viewport,
} from './port.ts'
import type { CanvasRegistries } from './registries.ts'
import type { LobbyEngineCore } from './sync/core/engine.ts'
import { compareIndexThenId } from './sync/index-keys.ts'
import type { SaveStatus } from './sync/types.ts'
import { buildNote, nextNoteFill } from './tools/notes.ts'
import { activeLobbyTool, CUSTOM_TOOLS, setTool as setLobbyTool } from './tools/tools.ts'

// biome-ignore lint/suspicious/noExplicitAny: the element package's constructors, typed loosely here
const X = el as any

export interface PortDeps {
  readonly api: ExcalidrawImperativeAPI
  readonly core: LobbyEngineCore | null
  readonly registries: CanvasRegistries
  readonly undo: UndoController | null
  readonly readOnly: () => boolean
  /** the lease id of this tab's granted open editor (EditorLease), or null */
  readonly editingLease: () => string | null
}

/**
 * The port's transaction: C0's `CanvasTx` plus `insert` (CR-2D-2, the canvas API's `LobbyTx.insert`).
 */
export interface LobbyCanvasTx extends CanvasTx {
  /**
   * Installs prepared elements (a template scene, pasted notes: `WireElement`-shaped) as new elements,
   * exactly as given, in this transaction (one undo step with its other writes). Ids are kept; `index`
   * is replaced by keys on top of the scene in the given order, and the server assigns the final ones.
   * Throws, writing nothing of the batch, on a missing id or type, a deleted element, a repeated id, or
   * an id the board already has. See `LobbyEngineCore.prepareInsert` for the rules. Returns the ids.
   */
  insert(elements: readonly Readonly<Record<string, unknown>>[]): string[]
  /**
   * An element as this transaction sees it: the scene with this step's writes on top, the elements it
   * created included (live or deleted). The canvas API's structural writes read through it (impl.ts
   * `txView`), so a `setFrame` or `group` of a note created in the same step sees the note and its label.
   */
  read(id: string): CanvasElement | undefined
}

/** `transact`'s options on this port: the canvas API's `skipUndo` (`joinPrevious` is the board page's). */
export type PortTransactOptions = Pick<TransactOptions, 'skipUndo'>

export interface LobbyCanvasPort extends CanvasPort {
  /**
   * C0's transact. With `skipUndo` (W5-26, CR-3F-1) the write is no undo step: the history takes it in
   * like someone else's edit (`UndoController.outside`) instead of recording a step at its end.
   */
  transact<T>(label: string, fn: (tx: LobbyCanvasTx) => T, opts?: PortTransactOptions): T
  /** feeds the port's `pointer` event (the presence pointer listener) */
  emitPointer(point: ScenePoint | null): void
  /** the canvas changed size or place (CR-3A-10): `viewportChanged` for readers of the view and its rect */
  notifyViewport(): void
  /**
   * the adapter's hook after every scene change: `changed` and `selectionChanged` events, the hidden-ids
   * post-filter. `elementsChanged: false` (a camera move, CR 3b-8) skips the element scan
   */
  afterSceneChange(elementsChanged?: boolean): void
  /**
   * CR-3A-9, port tool names: while a mode is set and the engine is on its `over` tool, `tool()` reports the
   * mode's Lobby name instead (the highlighter is the engine's `freedraw`, a read-only Hand its neutral
   * `select` state), so every reader of the port (the board page's `toolChanged`, the cursor, the e2e facade)
   * sees `highlight` and `hand`. null ends it. The canvas API's tools part (api/parts/tools.ts) runs the modes.
   */
  setToolMode(mode: PortToolMode | null): void
  /**
   * CR-3A-7: the next font size of a kind of text, which the engine keeps in one (`currentItemFontSize`). A
   * note's label and a free text each have their own: 'note' is what the next note's label (and any other
   * label the engine or the lease makes) takes, 'text' what the next free text takes. The engine's own value
   * is the one of the tool in hand (the text's while the text tool is, the label's otherwise), so a pick the
   * style panel makes with `styles.setNext` lands in that tool's own.
   */
  nextFontSize(slot: NextSizeSlot): number
  /** CR-3A-7: sets the next font size of a kind of text (a pick on a selection of that kind); no undo step. */
  setNextFontSize(slot: NextSizeSlot, size: number): void
  /**
   * CR-3A-9, the gesture-element hook: `hook` sees each element the engine starts drawing (its `newElement`)
   * once, in the scene change it appears in, before the sync engine pushes anything of it (the core holds an
   * element being drawn and pushes it once, at the gesture's end). A patch it returns is written onto that
   * element in place: the port's one in-place write (the element is the engine's own, mid-gesture: a new copy
   * would end the stroke). The highlighter's stamp uses it. Returns the removal.
   */
  onGestureElement(hook: GestureElementHook): () => void
  dispose(): void
}

/** CR-3A-7: whose next font size: a note's label (and any other label), or a free text's. */
export type NextSizeSlot = 'note' | 'text'

/** Excalidraw's own default font size (DEFAULT_FONT_SIZE): what `currentItemFontSize` starts as. */
const DEFAULT_FONT_SIZE = 20

/** CR-3A-9: a Lobby tool that the engine runs as one of its own (see `LobbyCanvasPort.setToolMode`). */
export interface PortToolMode {
  /** the Lobby name `tool()` reports ('highlight', 'hand') */
  readonly name: string
  /** the port tool the engine is on meanwhile ('freedraw', 'select') */
  readonly over: string
}

/** CR-3A-9: what to write onto an element the engine starts drawing (null: nothing). */
export type GestureElementHook = (
  element: Readonly<ExcalidrawElement>,
) => Readonly<Record<string, unknown>> | null

const OFFLINE_STATUS: SaveStatus = { state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }

export function createCanvasPort(deps: PortDeps): LobbyCanvasPort {
  const { api, registries } = deps
  const listeners = {
    changed: new Set(),
    selectionChanged: new Set(),
    viewportChanged: new Set(),
    pointer: new Set(),
  } as {
    [K in keyof CanvasEventMap]: Set<CanvasEventMap[K]>
  }
  const emit = <E extends keyof CanvasEventMap>(e: E, ...args: Parameters<CanvasEventMap[E]>) => {
    for (const l of [...listeners[e]]) (l as (...a: Parameters<CanvasEventMap[E]>) => void)(...args)
  }
  const versions = new Map<string, number>()
  let lastSelection = ''
  let toolMode: PortToolMode | null = null
  const gestureHooks = new Set<GestureElementHook>()
  /** the engine's element being drawn the hooks last saw */
  let lastDrawn: string | null = null
  /** CR-3A-9: the gesture-element hooks, once per element the engine starts drawing (see the interface) */
  const runGestureHooks = () => {
    const drawn = api.getAppState().newElement as ExcalidrawElement | null
    if (!drawn || drawn.id === lastDrawn) return
    lastDrawn = drawn.id
    if (!gestureHooks.size) return
    const patch: Record<string, unknown> = {}
    for (const hook of [...gestureHooks]) Object.assign(patch, hook(drawn) ?? {})
    if (Object.keys(patch).length) X.mutateElement(drawn, elementMap(), patch)
  }

  // ---- CR-3A-7: the next note label's and the next free text's font sizes ----------------------------------
  // The engine has one next font size, `currentItemFontSize`: it makes a note's label (its text editor, the
  // lease's own label) and, through `create('text')` below, a free text, so a note's L (26) became the next
  // text's size. Two sizes are kept over that one. The engine's is the tool in hand's: the text's while the
  // text tool is, the label's with any other tool (the note tool, and the select tool the note tool hands over
  // to while its label is made). A pick through `styles.setNext` (the style panel's next-style) writes the
  // engine's and is taken into the slot in hand on the next change; the tool changing swaps them
  // (`holdSizeSlot`, at once from `setTool` and from the engine's own change in `afterSceneChange`).
  const engineSize = (): number | null => {
    const n = api.getAppState().currentItemFontSize
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
  }
  const onTextTool = () => {
    const t = api.getAppState().activeTool
    return t?.type === 'custom' && t.customType === CUSTOM_TOOLS.text
  }
  const nextSizes: Record<NextSizeSlot, number> = {
    note: engineSize() ?? DEFAULT_FONT_SIZE,
    text: engineSize() ?? DEFAULT_FONT_SIZE,
  }
  let sizeSlot: NextSizeSlot = onTextTool() ? 'text' : 'note'
  const putEngineSize = (n: number) => {
    if (engineSize() !== n)
      api.updateScene({ appState: { currentItemFontSize: n } as Partial<AppState> as never })
  }
  /** The engine's next size is `slot`'s from now on: the slot in hand keeps what it holds (when `read`). */
  const holdSizeSlot = (slot: NextSizeSlot, read: boolean) => {
    if (slot === sizeSlot) return
    if (read) {
      const now = engineSize()
      if (now !== null) nextSizes[sizeSlot] = now
    }
    sizeSlot = slot
    putEngineSize(nextSizes[slot])
  }
  /** After an engine change: the tool in hand's slot, and a pick made while it is in hand is its size. */
  const syncNextSizes = () => {
    const want: NextSizeSlot = onTextTool() ? 'text' : 'note'
    if (want !== sizeSlot) return holdSizeSlot(want, true)
    const now = engineSize()
    if (now !== null) nextSizes[sizeSlot] = now
  }
  const nextSizeOf = (slot: NextSizeSlot): number =>
    slot === sizeSlot ? (engineSize() ?? nextSizes[slot]) : nextSizes[slot]

  const all = () => api.getSceneElementsIncludingDeleted()
  // CR 3b-7: one lookup in the engine's own map (a scan of every element per call made every per-element
  // caller quadratic on a heavy board)
  const elementMap = () =>
    api.getSceneElementsMapIncludingDeleted() as unknown as ReadonlyMap<string, ExcalidrawElement>
  const byId = (id: string) => elementMap().get(id)
  const selectedIds = (): string[] => {
    const s = api.getAppState().selectedElementIds
    return Object.keys(s).filter((k) => s[k] && !registries.hidden.isHidden(k))
  }
  const viewport = (): Viewport => {
    const s = api.getAppState()
    const z = s.zoom.value
    return { x: -s.scrollX, y: -s.scrollY, width: s.width / z, height: s.height / z, zoom: z }
  }
  const offViewport = api.onScrollChange(() => emit('viewportChanged', viewport()))

  /**
   * W5-39 (CR 3b-11): the engine's point editor for a selection of one arrow or line, as Excalidraw sets it
   * when it selects one itself (a click, Ctrl+A: `selectedLinearElement`); null for anything else. Without
   * it a code selection of a lone two-point connector (a `?el=` link, a search result, Alt+Arrow) drew no
   * box and no point handles, so it looked unselected and its points could not be dragged. None for a
   * read-only session either: its points cannot be dragged there, so handles would only look draggable;
   * the code selection's outline shows it instead (canvas-ux navigation/view-helpers.ts codeSelectionBoxes).
   */
  const linearEditorFor = (ids: readonly string[]): AppState['selectedLinearElement'] => {
    if (ids.length !== 1 || deps.readOnly()) return null
    const map = elementMap()
    const e = map.get(ids[0] as string)
    if (!e || e.isDeleted || e.locked || !X.isLinearElement(e)) return null
    return new X.LinearElementEditor(e, map) as AppState['selectedLinearElement']
  }

  const nextIndex = (lo: string | null) => generateKeyBetween(lo, null)
  const topIndex = () => {
    let top: string | null = null
    for (const e of all()) if (e.index && (top === null || e.index > top)) top = e.index
    return top
  }

  function create(
    kind: ItemKind,
    props: Readonly<Record<string, unknown>>,
    index: () => string,
  ): ExcalidrawElement[] {
    const s = api.getAppState()
    const base = {
      x: 0,
      y: 0,
      roughness: s.currentItemRoughness ?? 0,
      strokeColor: s.currentItemStrokeColor,
      ...props,
    } as Record<string, unknown>
    const withIndex = (els: ExcalidrawElement[]) =>
      els.map((e) => ({ ...e, index: index() }) as ExcalidrawElement)
    switch (kind) {
      case 'note': {
        const id =
          (props.id as string | undefined) ?? X.randomId?.() ?? `note-${Math.random().toString(36).slice(2)}`
        const els = buildNote(
          (sk, o) => convertToExcalidrawElements(sk as never, o) as unknown as ExcalidrawElement[],
          {
            id,
            x: Number(base.x),
            y: Number(base.y),
            size: props.size as number | undefined,
            text: props.text as string | undefined,
            // CR-3A-7: a note made with no colour of its own takes the next note's (the note tool's pick)
            backgroundColor: (props.backgroundColor as string | undefined) ?? nextNoteFill(s),
            fontFamily: 6,
            labelId: props.labelId as string | undefined,
          } as never,
        )
        // port.ts: create's props carry `customData` like every other kind (O5's mind map and tags create
        // notes with customData.lobby); it goes on the note, not its label (lead, M1/M2)
        const custom = props.customData
        const out = (els as ExcalidrawElement[]).map((e) =>
          custom !== undefined && e.id === id ? ({ ...e, customData: custom } as ExcalidrawElement) : e,
        )
        return withIndex(out)
      }
      case 'text':
        // CR-3A-7: a text takes the next text style (the text tool's font, size and alignment, as the style
        // panel sets them) where its creator names none; Nunito 20 left-aligned until one is picked. Its size
        // is the next text's own (`nextSizeOf`), not the next note label's.
        return withIndex([
          X.newTextElement({
            fontFamily: s.currentItemFontFamily ?? 6,
            fontSize: nextSizeOf('text'),
            textAlign: s.currentItemTextAlign ?? 'left',
            ...base,
            text: String(props.text ?? ''),
          }),
        ])
      case 'rectangle':
      case 'ellipse':
      case 'diamond':
        return withIndex([X.newElement({ type: kind, width: 100, height: 100, ...base })])
      case 'arrow':
        return withIndex([
          X.newArrowElement({
            type: 'arrow',
            points: [
              [0, 0],
              [100, 0],
            ],
            ...base,
          }),
        ])
      case 'line':
        return withIndex([
          X.newLinearElement({
            type: 'line',
            points: [
              [0, 0],
              [100, 0],
            ],
            ...base,
          }),
        ])
      case 'freedraw':
        return withIndex([
          X.newFreeDrawElement({ type: 'freedraw', points: [[0, 0]], simulatePressure: true, ...base }),
        ])
      case 'frame':
        return withIndex([X.newFrameElement({ width: 400, height: 300, ...base })])
      case 'image':
        return withIndex([X.newImageElement({ type: 'image', width: 100, height: 100, ...base })])
    }
  }

  const port: LobbyCanvasPort = {
    items: () => api.getSceneElements() as unknown as readonly CanvasElement[],
    get: (id) => byId(id) as unknown as CanvasElement | undefined,
    bounds(id): Bounds | null {
      const map = elementMap()
      const e = map.get(id)
      if (!e) return null
      const [x1, y1, x2, y2] = X.getCommonBounds([e], map) as [number, number, number, number]
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    },
    get selection() {
      return selectedIds()
    },
    select(ids) {
      const visible = ids.filter((id) => !registries.hidden.isHidden(id))
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(visible.map((id) => [id, true])),
          selectedGroupIds: {},
          selectedLinearElement: linearEditorFor(visible),
        } as Partial<AppState> as never,
      })
    },
    viewport: {
      get: viewport,
      set(v) {
        const s = api.getAppState()
        const zoom = v.zoom ?? s.zoom.value
        api.updateScene({
          appState: {
            scrollX: v.x !== undefined ? -v.x : s.scrollX,
            scrollY: v.y !== undefined ? -v.y : s.scrollY,
            zoom: { value: zoom as AppState['zoom']['value'] },
          },
        })
      },
      fit(ids) {
        const els = (
          ids?.length ? ids.map(byId).filter(Boolean) : api.getSceneElements()
        ) as ExcalidrawElement[]
        if (!els.length) return
        const [x1, y1, x2, y2] = X.getCommonBounds(els, elementMap()) as [number, number, number, number]
        const s = api.getAppState()
        const w = Math.max(1, x2 - x1)
        const h = Math.max(1, y2 - y1)
        // Excalidraw clamps below 0.1 (getNormalizedZoom); Lobby's own sub-0.1 fit is wave 3b (§4.2)
        // never above 100% (a fit of a few elements is not a magnifier), a margin for the chrome
        const zoom = Math.max(0.1, Math.min(1, Math.min(s.width / w, s.height / h) * 0.8))
        api.updateScene({
          appState: {
            zoom: { value: zoom as AppState['zoom']['value'] },
            scrollX: -(x1 + w / 2) + s.width / zoom / 2,
            scrollY: -(y1 + h / 2) + s.height / zoom / 2,
          },
        })
      },
    },
    sceneToScreen(p: ScenePoint): ScreenPoint {
      const v = sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, api.getAppState())
      return { x: v.x, y: v.y }
    },
    screenToScene(p: ScreenPoint): ScenePoint {
      const s = viewportCoordsToSceneCoords({ clientX: p.x, clientY: p.y }, api.getAppState())
      return { x: s.x, y: s.y }
    },
    transact<T>(label: string, fn: (tx: LobbyCanvasTx) => T, opts?: PortTransactOptions): T {
      const current = new Map(all().map((e) => [e.id, e as ExcalidrawElement]))
      // with skipUndo: each element this step writes, as it was before the step (undefined: created here)
      const outside = opts?.skipUndo && deps.undo ? new Map<string, ExcalidrawElement | undefined>() : null
      const touch = (id: string) => {
        if (outside && !outside.has(id)) outside.set(id, current.get(id))
      }
      const order = [...current.keys()]
      let lo = topIndex()
      const index = () => {
        lo = nextIndex(lo)
        return lo
      }
      // the ids this step created, in order: the scene gets their LAST copies (an update or a delete of an
      // element created in the same step was dropped when the first copies went in: the transact defect,
      // 3b F1, CR-3D-1, CR-3H-3, CR-3F-6)
      const created: string[] = []
      // an `index` write moves the element in the scene array too (Excalidraw keeps the array in paint
      // order and re-keys what is out of place, so a bare index write changed no paint order: CR-3A-3)
      let reindexed = false
      const tx: LobbyCanvasTx = {
        create(kind, props) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          const els = create(kind, props, index)
          for (const e of els) {
            touch(e.id)
            current.set(e.id, e)
            created.push(e.id)
          }
          return (els.find((e) => e.type !== 'text' || kind === 'text') ?? els[0])?.id as string
        },
        update(id, patch) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          const e = current.get(id)
          if (!e) throw new Error(`update: no element ${id}`)
          const next: Record<string, unknown> = { ...patch }
          if ('index' in patch && patch.index !== e.index) reindexed = true
          touch(id)
          if (patch.customData && typeof patch.customData === 'object') {
            const given = (patch.customData as { lobby?: Record<string, unknown> }).lobby ?? {}
            const lobby = {
              ...((e.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}),
            }
            for (const [k, v] of Object.entries(given)) {
              if (v === null) delete lobby[k]
              else lobby[k] = v
            }
            next.customData = { ...(e.customData ?? {}), lobby }
          }
          current.set(id, X.newElementWith(e, next))
        },
        delete(id) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          const e = current.get(id)
          if (!e) return
          touch(id)
          current.set(id, X.newElementWith(e, { isDeleted: true }))
          for (const b of e.boundElements ?? []) {
            const label = current.get(b.id)
            if (b.type === 'text' && label && !label.isDeleted) {
              touch(b.id)
              current.set(b.id, X.newElementWith(label, { isDeleted: true }))
            }
          }
        },
        insert(elements) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          for (const e of elements)
            if (typeof e.id === 'string' && current.has(e.id))
              throw new Error(`insert: ${e.id} exists on this board`)
          const copies = (deps.core
            ? deps.core.prepareInsert(elements, lo)
            : elements.map((e) => ({
                ...structuredClone(e),
                index: index(),
              }))) as unknown as ExcalidrawElement[]
          for (const e of copies) {
            touch(e.id)
            current.set(e.id, e)
            created.push(e.id)
            if (e.index) lo = e.index
          }
          return copies.map((e) => e.id)
        },
        read: (id) => current.get(id) as unknown as CanvasElement | undefined,
      }
      const result = fn(tx)
      const written = [
        ...order.map((id) => current.get(id) as ExcalidrawElement),
        ...created.map((id) => current.get(id) as ExcalidrawElement),
      ]
      const next = reindexed ? [...written].sort(compareIndexThenId) : written
      const install = () => {
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
        // the core scans the write now, not at Excalidraw's onChange after React's commit (spike B part 3)
        deps.core?.syncScene()
      }
      if (outside && deps.undo) deps.undo.outside(install, outside)
      else {
        install()
        deps.undo?.boundary(label)
      }
      return result
    },
    setTool(tool) {
      const spec = registries.pointerTools.get(tool)
      if (spec) {
        if (deps.readOnly() && !spec.readOnlyAllowed) return false
        api.setActiveTool({ type: 'custom', customType: spec.customType, locked: true })
        holdSizeSlot('note', false)
        return true
      }
      const done = setLobbyTool(api, tool, { readOnly: deps.readOnly() })
      // CR-3A-7: the engine's next size is the new tool's at once (the engine's own change follows)
      if (done) holdSizeSlot(tool === 'text' ? 'text' : 'note', false)
      return done
    },
    nextFontSize: (slot) => nextSizeOf(slot),
    setNextFontSize(slot, size) {
      if (!Number.isFinite(size) || size <= 0) return
      nextSizes[slot] = size
      if (slot === sizeSlot) putEngineSize(size)
    },
    tool() {
      const t = api.getAppState().activeTool
      let name: string | null
      if (t.type === 'custom') {
        const spec = registries.pointerTools.list().find((p) => p.customType === t.customType)
        const own = Object.entries(CUSTOM_TOOLS).find(([, v]) => v === t.customType)
        name = spec ? spec.id : own ? own[0] : null
      } else name = activeLobbyTool(api)
      // CR-3A-9: the highlighter and a read-only Hand by their Lobby names
      return toolMode && name === toolMode.over ? toolMode.name : name
    },
    setToolMode(mode) {
      toolMode = mode
    },
    onGestureElement(hook) {
      gestureHooks.add(hook)
      return () => gestureHooks.delete(hook)
    },
    on(event, listener) {
      ;(listeners[event] as Set<unknown>).add(listener)
      return () => (listeners[event] as Set<unknown>).delete(listener)
    },
    editingId: () => deps.editingLease(),
    leaseHolder: (id): LeaseHolder | null => deps.core?.leaseHolders().get(id) ?? null,
    collaborators: (): readonly RosterEntry[] => [...(deps.core?.roster().values() ?? [])],
    saveStatus: () => deps.core?.saveStatus ?? OFFLINE_STATUS,
    engine: deps.core,
    emitPointer(p) {
      emit('pointer', p)
    },
    notifyViewport() {
      emit('viewportChanged', viewport())
    },
    afterSceneChange(elementsChanged = true) {
      runGestureHooks()
      syncNextSizes()
      if (elementsChanged) {
        const changed: string[] = []
        const els = all()
        for (const e of els) {
          if (versions.get(e.id) === e.version) continue
          versions.set(e.id, e.version)
          changed.push(e.id)
        }
        // an element that left the scene is a change too, and forgotten: when it comes back at the same
        // version it is one again (a warm open's paint, then the room's older reset snapshot without it, then
        // its catch-up at the painted version: readers of `changed` kept the empty scene, wave M gate)
        if (versions.size > els.length) {
          const here = new Set(els.map((e) => e.id))
          for (const id of [...versions.keys()])
            if (!here.has(id)) {
              versions.delete(id)
              changed.push(id)
            }
        }
        if (changed.length) emit('changed', changed)
      }
      // the box/lasso post-filter (§2.3.3, B12): hidden ids never stay selected
      const s = api.getAppState().selectedElementIds
      const hidden = Object.keys(s).filter((k) => s[k] && registries.hidden.isHidden(k))
      if (hidden.length) {
        const keep = Object.fromEntries(
          Object.keys(s)
            .filter((k) => s[k] && !hidden.includes(k))
            .map((k) => [k, true as const]),
        )
        api.updateScene({ appState: { selectedElementIds: keep } })
      }
      const sel = selectedIds().sort().join(',')
      if (sel !== lastSelection) {
        lastSelection = sel
        emit('selectionChanged', sel ? sel.split(',') : [])
      }
    },
    dispose() {
      offViewport()
      gestureHooks.clear()
    },
  }
  return port
}

/** Non-deleted elements as Excalidraw's own `getSceneElements` returns them (a narrow re-export for callers). */
export type { NonDeletedExcalidrawElement }
