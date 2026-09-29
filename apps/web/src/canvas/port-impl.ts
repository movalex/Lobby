/**
 * `CanvasPort` (./port.ts, frozen at C0) on the Excalidraw host and the engine core (docs/EXCALIDRAW-
 * MIGRATION.md §2.3.1). Features (O5), the test facade (O3) and the installers only see the interface.
 *
 * Every write goes through `transact`: the writes of one call become new element versions installed with
 * one `updateScene` (captureUpdate NEVER), which the engine core then finds in its next scan and pushes as
 * ordinary edits; the call is one undo step. Nothing here calls `updateScene` with elements for any other
 * reason.
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
import type { SaveStatus } from './sync/types.ts'
import { buildNote } from './tools/notes.ts'
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

export interface LobbyCanvasPort extends CanvasPort {
  /** feeds the port's `pointer` event (the presence pointer listener) */
  emitPointer(point: ScenePoint | null): void
  /** the adapter's hook after every scene change: `changed` and `selectionChanged` events, the hidden-ids post-filter */
  afterSceneChange(): void
  dispose(): void
}

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

  const all = () => api.getSceneElementsIncludingDeleted()
  const byId = (id: string) => all().find((e) => e.id === id)
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
            backgroundColor: (props.backgroundColor as string | undefined) ?? '#f8e48f',
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
        return withIndex([
          X.newTextElement({ fontFamily: 6, fontSize: 20, ...base, text: String(props.text ?? '') }),
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
      const e = byId(id)
      if (!e) return null
      const map = new Map(all().map((x) => [x.id, x]))
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
        },
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
        const map = new Map(all().map((x) => [x.id, x]))
        const [x1, y1, x2, y2] = X.getCommonBounds(els, map) as [number, number, number, number]
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
    transact<T>(label: string, fn: (tx: CanvasTx) => T): T {
      const current = new Map(all().map((e) => [e.id, e as ExcalidrawElement]))
      const order = [...current.keys()]
      let lo = topIndex()
      const index = () => {
        lo = nextIndex(lo)
        return lo
      }
      const created: ExcalidrawElement[] = []
      const tx: CanvasTx = {
        create(kind, props) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          const els = create(kind, props, index)
          for (const e of els) {
            current.set(e.id, e)
            created.push(e)
          }
          return (els.find((e) => e.type !== 'text' || kind === 'text') ?? els[0])?.id as string
        },
        update(id, patch) {
          if (deps.readOnly()) throw new Error('read-only: no writes')
          const e = current.get(id)
          if (!e) throw new Error(`update: no element ${id}`)
          const next: Record<string, unknown> = { ...patch }
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
          current.set(id, X.newElementWith(e, { isDeleted: true }))
          for (const b of e.boundElements ?? []) {
            const label = current.get(b.id)
            if (b.type === 'text' && label && !label.isDeleted)
              current.set(b.id, X.newElementWith(label, { isDeleted: true }))
          }
        },
      }
      const result = fn(tx)
      const next = [...order.map((id) => current.get(id) as ExcalidrawElement), ...created]
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
      deps.undo?.boundary(label)
      return result
    },
    setTool(tool) {
      const spec = registries.pointerTools.get(tool)
      if (spec) {
        if (deps.readOnly() && !spec.readOnlyAllowed) return false
        api.setActiveTool({ type: 'custom', customType: spec.customType, locked: true })
        return true
      }
      return setLobbyTool(api, tool, { readOnly: deps.readOnly() })
    },
    tool() {
      const t = api.getAppState().activeTool
      if (t.type === 'custom') {
        const spec = registries.pointerTools.list().find((p) => p.customType === t.customType)
        if (spec) return spec.id
        const own = Object.entries(CUSTOM_TOOLS).find(([, v]) => v === t.customType)
        return own ? own[0] : null
      }
      return activeLobbyTool(api)
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
    afterSceneChange() {
      const changed: string[] = []
      for (const e of all()) {
        if (versions.get(e.id) === e.version) continue
        versions.set(e.id, e.version)
        changed.push(e.id)
      }
      if (changed.length) emit('changed', changed)
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
    },
  }
  return port
}

/** Non-deleted elements as Excalidraw's own `getSceneElements` returns them (a narrow re-export for callers). */
export type { NonDeletedExcalidrawElement }
