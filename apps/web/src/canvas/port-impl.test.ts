// CanvasPort.transact on a fake engine API (wave 5, 2C): the scene a transaction installs.
//
// The browser engine (@excalidraw/excalidraw) does not load in Node, so the few names port-impl takes from
// it are given here from the element package (the same functions it re-exports).
import * as element from '@excalidraw/element'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', async () => {
  const el = await import('@excalidraw/element')
  return {
    CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
    convertToExcalidrawElements: (el as unknown as { convertToExcalidrawElements: unknown })
      .convertToExcalidrawElements,
    sceneCoordsToViewportCoords: ({ sceneX, sceneY }: { sceneX: number; sceneY: number }) => ({
      x: sceneX,
      y: sceneY,
    }),
    viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
      x: clientX,
      y: clientY,
    }),
  }
})

// the element package's scene helpers read a few `window` flags (convertToExcalidrawElements builds a Scene)
;(globalThis as { window?: unknown }).window ??= globalThis
// and text needs a measure (no canvas in Node)
;(element as unknown as { setCustomTextMetricsProvider(p: unknown): void }).setCustomTextMetricsProvider({
  getLineWidth: (t: string) => t.length * 10,
})
const { createCanvasPort } = await import('./port-impl.ts')
const { createRegistries } = await import('./registries.ts')

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects, typed loosely in this test
type El = any
// biome-ignore lint/suspicious/noExplicitAny: the element package's constructors
const X = element as any

/** A minimal ExcalidrawImperativeAPI: one element array, replaced by updateScene. */
function fakeApi(initial: El[]) {
  let elements: El[] = initial
  let installs = 0
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElementsMapIncludingDeleted: () => new Map(elements.map((e) => [e.id, e])),
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getAppState: () => ({
      currentItemRoughness: 0,
      currentItemStrokeColor: '#1e1e1e',
      selectedElementIds: {},
      zoom: { value: 1 },
      scrollX: 0,
      scrollY: 0,
      width: 1000,
      height: 800,
      activeTool: { type: 'selection' },
    }),
    updateScene(u: { elements?: El[] }) {
      if (u.elements) {
        elements = u.elements
        installs++
      }
    },
    onScrollChange: () => () => {},
    setActiveTool: () => {},
  }
  return {
    api,
    elements: () => elements,
    installs: () => installs,
  }
}

function portOn(initial: El[]) {
  const f = fakeApi(initial)
  const port = createCanvasPort({
    api: f.api as never,
    core: null,
    registries: createRegistries(),
    undo: null,
    readOnly: () => false,
    editingLease: () => null,
  })
  return { ...f, port }
}

const rect = (id: string, index: string, over: El = {}) =>
  X.newElement({ type: 'rectangle', id, x: 0, y: 0, width: 100, height: 100, roughness: 0, index, ...over })

describe('CanvasPort.transact', () => {
  it('keeps an update to an element created in the same transaction (the transact defect)', () => {
    const { port, elements } = portOn([rect('a', 'a0')])
    const id = port.transact('create and move', (tx) => {
      const n = tx.create('rectangle', { x: 10, y: 10 })
      tx.update(n, { x: 500, backgroundColor: '#ffd966' })
      return n
    })
    const made = elements().find((e) => e.id === id)
    expect(made?.x).toBe(500)
    expect(made?.backgroundColor).toBe('#ffd966')
    // one copy of it, after the scene's own
    expect(elements().filter((e) => e.id === id)).toHaveLength(1)
    expect(elements().map((e) => e.id)).toEqual(['a', id])
  })

  it('keeps a frame set on a note created in the same transaction, label included', () => {
    const frame = X.newFrameElement({ id: 'f', x: 0, y: 0, width: 600, height: 600, index: 'a0' })
    const { port, elements } = portOn([frame])
    const id = port.transact('note in frame', (tx) => {
      const n = tx.create('note', { x: 50, y: 50, size: 200, text: 'hi' })
      const note = tx.read(n)
      const label = (note?.boundElements as { id: string }[] | null)?.[0]?.id as string
      tx.update(n, { frameId: 'f' })
      tx.update(label, { frameId: 'f' })
      return n
    })
    const note = elements().find((e) => e.id === id)
    const label = elements().find((e) => e.containerId === id)
    expect(note?.frameId).toBe('f')
    expect(label?.frameId).toBe('f')
  })

  it('keeps a delete of an element created in the same transaction', () => {
    const { port, elements } = portOn([])
    const id = port.transact('create and drop', (tx) => {
      const n = tx.create('rectangle', {})
      tx.delete(n)
      return n
    })
    expect(elements().find((e) => e.id === id)?.isDeleted).toBe(true)
  })

  it('reads what this step wrote (read)', () => {
    const { port } = portOn([rect('a', 'a0')])
    port.transact('read', (tx) => {
      tx.update('a', { x: 42 })
      expect(tx.read('a')?.x).toBe(42)
      const n = tx.create('ellipse', { x: 7 })
      expect(tx.read(n)?.type).toBe('ellipse')
      expect(tx.read('missing')).toBeUndefined()
    })
  })

  it('an index write moves the element in paint order (CR-3A-3)', () => {
    const { port, elements } = portOn([rect('a', 'a0'), rect('b', 'a1'), rect('c', 'a2')])
    port.transact('send to back', (tx) => tx.update('c', { index: 'Zz' }))
    expect(elements().map((e) => e.id)).toEqual(['c', 'a', 'b'])
    port.transact('bring to front', (tx) => tx.update('c', { index: 'a3' }))
    expect(elements().map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('a write that changes no index keeps the array as it is', () => {
    const { port, elements } = portOn([rect('a', 'a0'), rect('b', 'a1')])
    port.transact('recolour', (tx) => tx.update('a', { strokeColor: '#e03131' }))
    expect(elements().map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('CanvasPort reads (CR 3b-7)', () => {
  it('get and bounds read the engine map, not a scan of the scene', () => {
    const { api, port } = portOn([rect('a', 'a0', { x: 10, y: 20, width: 30, height: 40 })])
    const scan = vi.spyOn(api, 'getSceneElementsIncludingDeleted')
    expect(port.get('a')?.x).toBe(10)
    expect(port.bounds('a')).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    expect(port.get('nope')).toBeUndefined()
    expect(port.bounds('nope')).toBeNull()
    expect(scan).not.toHaveBeenCalled()
  })
})
