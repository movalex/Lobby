// OWNER: 3f. A small in-memory LobbyCanvas for the ported workshops unit tests (Node): elements, a
// selection, a viewport and the members these modules call. Members they never call throw.
import {
  type Bounds,
  type CanvasElement,
  type LobbyCanvas,
  type LobbyTx,
  NotImplementedError,
  type Viewport,
} from '../../../canvas/api/index.ts'

export interface FakeCanvas {
  readonly canvas: LobbyCanvas
  elements: CanvasElement[]
  selection: string[]
  viewport: Viewport
  readOnly: boolean
  /** every transact label, in order */
  readonly steps: string[]
  /** every viewport.set call */
  readonly moves: { x?: number; y?: number; zoom?: number }[]
  /** doc values set through doc.set */
  readonly doc: Record<string, unknown>
}

/** An element with the fields the readers use; `patch` overrides them. */
export function el(id: string, type: string, patch: Record<string, unknown> = {}): CanvasElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    boundElements: null,
    ...patch,
  } as unknown as CanvasElement
}

/** A sticky note and its bound label with `text`. */
export function note(id: string, text: string, patch: Record<string, unknown> = {}): CanvasElement[] {
  const labelId = `${id}-label`
  return [
    el(id, 'stickynote', {
      width: 200,
      height: 200,
      boundElements: [{ id: labelId, type: 'text' }],
      ...patch,
    }),
    el(labelId, 'text', { containerId: id, originalText: text, text }),
  ]
}

/** The engine's hit threshold at zoom 1, in scene units (about Excalidraw's collision threshold). */
const HIT_SLACK = 8

/**
 * Whether a point hits an element, roughly as the board page's hit test does (canvas/board/hit.ts): a
 * connector, line or drawing near its stroke (here the segment from its top-left to its bottom-right
 * corner), a frame near its outline (not inside: frames have no fill), anything else inside its bounds.
 */
function hitsElement(e: CanvasElement, p: { x: number; y: number }): boolean {
  if (e.type === 'arrow' || e.type === 'line' || e.type === 'freedraw') {
    const [dx, dy] = [e.width, e.height]
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - e.x) * dx + (p.y - e.y) * dy) / len2)) : 0
    return Math.hypot(p.x - (e.x + t * dx), p.y - (e.y + t * dy)) <= HIT_SLACK
  }
  const inside = (m: number) =>
    p.x >= e.x - m && p.y >= e.y - m && p.x <= e.x + e.width + m && p.y <= e.y + e.height + m
  if (e.type === 'frame') return inside(HIT_SLACK) && !inside(-HIT_SLACK)
  return inside(0)
}

const stub = (member: string) => () => {
  throw new NotImplementedError('2C', member)
}

export function fakeCanvas(elements: CanvasElement[] = []): FakeCanvas {
  const state: FakeCanvas = {
    canvas: null as unknown as LobbyCanvas,
    elements: [...elements],
    selection: [],
    viewport: { x: 0, y: 0, width: 1000, height: 800, zoom: 1 },
    readOnly: false,
    steps: [],
    moves: [],
    doc: {},
  }
  const get = (id: string) => state.elements.find((e) => e.id === id)
  const bounds = (id: string): Bounds | null => {
    const e = get(id)
    return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
  }
  const tx: LobbyTx = {
    // LobbyTx.insert (CR-2D-2, the wave-3 integration): not used by these tests
    insert() {
      throw new Error('insert: not in this in-memory canvas')
    },
    create(kind, props) {
      const id = String(props.id ?? `new-${state.elements.length}`)
      state.elements.push(el(id, kind === 'note' ? 'stickynote' : kind, { ...props, id }))
      return id
    },
    update(id, patch) {
      const i = state.elements.findIndex((e) => e.id === id)
      const cur = state.elements[i]
      if (!cur) throw new Error(`no ${id}`)
      const next = { ...cur, ...patch } as Record<string, unknown>
      if (patch.customData) {
        const given = (patch.customData as { lobby?: Record<string, unknown> }).lobby ?? {}
        const lobby = { ...(cur.customData?.lobby ?? {}) } as Record<string, unknown>
        for (const [k, v] of Object.entries(given)) {
          if (v === null) delete lobby[k]
          else lobby[k] = v
        }
        next.customData = { ...(cur.customData ?? {}), lobby }
      }
      state.elements[i] = next as unknown as CanvasElement
    },
    delete(id) {
      const i = state.elements.findIndex((e) => e.id === id)
      const cur = state.elements[i]
      if (cur) state.elements[i] = { ...cur, isDeleted: true } as CanvasElement
    },
    createMany: stub('tx.createMany') as never,
    reorder: stub('tx.reorder'),
    setFrame: stub('tx.setFrame'),
    group: stub('tx.group') as never,
    ungroup: stub('tx.ungroup'),
    bind: stub('tx.bind'),
    duplicate: stub('tx.duplicate') as never,
  }
  const canvas = {
    items: () => state.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted),
    get,
    bounds,
    get selection() {
      return state.selection
    },
    select(ids: readonly string[]) {
      state.selection = [...ids]
    },
    isHidden: () => false,
    isLocked: (id: string) => !!get(id)?.locked,
    readOnly: () => state.readOnly,
    transact<T>(label: string, fn: (t: LobbyTx) => T): T {
      if (state.readOnly) throw new Error('read-only')
      state.steps.push(label)
      return fn(tx)
    },
    sceneToOverlay: (p: { x: number; y: number }) => ({
      x: (p.x - state.viewport.x) * state.viewport.zoom,
      y: (p.y - state.viewport.y) * state.viewport.zoom,
    }),
    container: () => null,
    viewport: {
      get: () => state.viewport,
      set(v: { x?: number; y?: number; zoom?: number }) {
        state.moves.push(v)
        const zoom = v.zoom ?? state.viewport.zoom
        state.viewport = {
          x: v.x ?? state.viewport.x,
          y: v.y ?? state.viewport.y,
          width: (state.viewport.width * state.viewport.zoom) / zoom,
          height: (state.viewport.height * state.viewport.zoom) / zoom,
          zoom,
        }
      },
      screenRect: () => ({
        x: 0,
        y: 0,
        width: state.viewport.width * state.viewport.zoom,
        height: state.viewport.height * state.viewport.zoom,
      }),
      zoomTo: () => {
        throw new NotImplementedError('3b', 'viewport.zoomTo')
      },
      ensureVisible: () => {
        throw new NotImplementedError('3b', 'viewport.ensureVisible')
      },
      remeasure: () => {},
    },
    follow: {
      current: () => {
        throw new NotImplementedError('3c', 'follow.current')
      },
      start: () => {
        throw new NotImplementedError('3c', 'follow.start')
      },
      stop: () => {
        throw new NotImplementedError('3c', 'follow.stop')
      },
    },
    doc: {
      get: (key: string) => state.doc[key],
      entries: () => new Map(Object.entries(state.doc)),
      set(entries: Record<string, unknown>) {
        for (const [k, v] of Object.entries(entries)) {
          if (v === null) delete state.doc[k]
          else state.doc[k] = v
        }
      },
    },
    hitTest(p: { x: number; y: number }, opts: { filter?: (e: CanvasElement) => boolean } = {}) {
      const hits = state.elements.filter(
        (e) =>
          !(e as { isDeleted?: boolean }).isDeleted &&
          !(e.type === 'text' && e.containerId) &&
          hitsElement(e, p) &&
          (!opts.filter || opts.filter(e)),
      )
      return hits[hits.length - 1] ?? null
    },
  }
  ;(state as { canvas: LobbyCanvas }).canvas = canvas as unknown as LobbyCanvas
  return state
}
