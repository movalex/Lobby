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

/** A minimal ExcalidrawImperativeAPI: one element array, replaced by updateScene; app state merged. */
function fakeApi(initial: El[], state: Record<string, unknown> = {}) {
  let elements: El[] = initial
  let installs = 0
  let appState: Record<string, unknown> = {
    currentItemRoughness: 0,
    currentItemStrokeColor: '#1e1e1e',
    selectedElementIds: {},
    zoom: { value: 1 },
    scrollX: 0,
    scrollY: 0,
    width: 1000,
    height: 800,
    activeTool: { type: 'selection' },
    ...state,
  }
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElementsMapIncludingDeleted: () => new Map(elements.map((e) => [e.id, e])),
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getAppState: () => appState,
    updateScene(u: { elements?: El[]; appState?: Record<string, unknown> }) {
      if (u.elements) {
        elements = u.elements
        installs++
      }
      if (u.appState) appState = { ...appState, ...u.appState }
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

function portOn(initial: El[], state?: Record<string, unknown>) {
  const f = fakeApi(initial, state)
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

const arrow = (id: string, index: string, over: El = {}) =>
  X.newArrowElement({
    type: 'arrow',
    id,
    x: 0,
    y: 0,
    points: [
      [0, 0],
      [200, 0],
    ],
    index,
    ...over,
  })

describe('CanvasPort.select (W5-39, CR 3b-11)', () => {
  it('a lone arrow or line selected by code gets the engine’s point editor, as a click gives it', () => {
    const line = X.newLinearElement({
      type: 'line',
      id: 'l',
      x: 0,
      y: 300,
      points: [
        [0, 0],
        [100, 0],
      ],
      index: 'a2',
    })
    const { api, port } = portOn([arrow('a', 'a0'), rect('r', 'a1'), line])
    port.select(['a'])
    const s = () =>
      api.getAppState() as { selectedLinearElement?: { elementId: string; isEditing: boolean } | null }
    expect(api.getAppState().selectedElementIds).toEqual({ a: true })
    expect(s().selectedLinearElement?.elementId).toBe('a')
    // selected, not opened for point editing (Excalidraw's double-click)
    expect(s().selectedLinearElement?.isEditing).toBe(false)
    port.select(['l'])
    expect(s().selectedLinearElement?.elementId).toBe('l')
  })

  it('no point editor for anything else: a shape, several elements, a locked connector, nothing', () => {
    const { api, port } = portOn([arrow('a', 'a0'), rect('r', 'a1'), arrow('k', 'a2', { locked: true })])
    const editor = () => (api.getAppState() as { selectedLinearElement?: unknown }).selectedLinearElement
    port.select(['a'])
    expect(editor()).not.toBeNull()
    port.select(['r'])
    expect(editor()).toBeNull()
    port.select(['a'])
    port.select(['a', 'r'])
    expect(editor()).toBeNull()
    port.select(['k'])
    expect(editor()).toBeNull()
    port.select(['a'])
    port.select([])
    expect(editor()).toBeNull()
  })
})

// ---- CR-3A-7: the next note's colour and the next text's style -------------------------------------------

const { nextNoteFill, nextStylePatch, nextStyles, LOBBY_NOTE_FILL } = await import('./board/handles.ts')

describe('the next note and the next text (CR-3A-7)', () => {
  const noteOf = (els: El[], id: string) => els.find((e) => e.id === id)
  const sky = '#a6d8f3'

  it('a note made with no colour of its own takes the next note fill; one that names a colour keeps it', () => {
    const { port, elements } = portOn([], { currentItemStickynoteBackgroundColor: sky })
    const a = port.transact('note', (tx) => tx.create('note', { x: 0, y: 0, size: 200 }))
    const b = port.transact('note', (tx) => tx.create('note', { x: 300, y: 0, backgroundColor: '#f4a874' }))
    expect(noteOf(elements(), a)?.backgroundColor).toBe(sky)
    expect(noteOf(elements(), b)?.backgroundColor).toBe('#f4a874')
  })

  it('until a note colour is picked, a new note is Lobby’s default yellow, not the engine’s own default', () => {
    for (const state of [{}, { currentItemStickynoteBackgroundColor: '#ffdf6b' }]) {
      const { port, elements } = portOn([], state)
      const id = port.transact('note', (tx) => tx.create('note', { x: 0, y: 0 }))
      expect(noteOf(elements(), id)?.backgroundColor).toBe(LOBBY_NOTE_FILL)
    }
    expect(LOBBY_NOTE_FILL).toBe('#f8e48f')
  })

  it('a text takes the next font, size and alignment where its creator names none', () => {
    const { port, elements } = portOn([], {
      currentItemFontFamily: 8,
      currentItemFontSize: 36,
      currentItemTextAlign: 'center',
      currentItemStrokeColor: '#4465e9',
    })
    const t = port.transact('text', (tx) => tx.create('text', { x: 0, y: 0, text: 'hi' }))
    expect(noteOf(elements(), t)).toMatchObject({
      fontFamily: 8,
      fontSize: 36,
      textAlign: 'center',
      strokeColor: '#4465e9',
    })
    // a feature's own text style wins (the AI's theme labels, a duplicate's label)
    const own = port.transact('text', (tx) =>
      tx.create('text', { x: 0, y: 0, text: 'x', fontFamily: 6, fontSize: 20, textAlign: 'left' }),
    )
    expect(noteOf(elements(), own)).toMatchObject({ fontFamily: 6, fontSize: 20, textAlign: 'left' })
  })

  it('a text made before any pick is Nunito 20, left-aligned (the defaults before CR-3A-7)', () => {
    const { port, elements } = portOn([])
    const t = port.transact('text', (tx) => tx.create('text', { x: 0, y: 0, text: 'hi' }))
    expect(noteOf(elements(), t)).toMatchObject({ fontFamily: 6, fontSize: 20, textAlign: 'left' })
  })

  it('styles.setNext({ noteColor }) is the engine’s next sticky-note fill, and styles.next() reads it back', () => {
    expect(nextStylePatch({ noteColor: sky })).toEqual({ currentItemStickynoteBackgroundColor: sky })
    const api = (state: Record<string, unknown>) => ({ getAppState: () => state }) as never
    expect(nextStyles(api({ currentItemStickynoteBackgroundColor: sky })).noteColor).toBe(sky)
    expect(nextStyles(api({ currentItemStickynoteBackgroundColor: '#ffdf6b' })).noteColor).toBe(
      LOBBY_NOTE_FILL,
    )
    expect(nextNoteFill({})).toBe(LOBBY_NOTE_FILL)
  })
})

// ---- CR-3A-9: the port's tool names and its gesture-element hook ----------------------------------------------

describe('the port names Lobby’s tool modes (CR-3A-9)', () => {
  it('while a mode is on and the engine is on its tool, tool() is the Lobby name; any other tool ends the name', () => {
    const { api, port } = portOn([], { activeTool: { type: 'freedraw', customType: null } })
    expect(port.tool()).toBe('freedraw')
    port.setToolMode({ name: 'highlight', over: 'freedraw' })
    expect(port.tool()).toBe('highlight')
    api.updateScene({ appState: { activeTool: { type: 'rectangle', customType: null } } })
    expect(port.tool()).toBe('rectangle')
    api.updateScene({ appState: { activeTool: { type: 'freedraw', customType: null } } })
    port.setToolMode(null)
    expect(port.tool()).toBe('freedraw')
    // a read-only Hand: the neutral select state
    api.updateScene({ appState: { activeTool: { type: 'selection', customType: null } } })
    port.setToolMode({ name: 'hand', over: 'select' })
    expect(port.tool()).toBe('hand')
  })
})

describe('the gesture-element hook (CR-3A-9)', () => {
  const stroke = (id: string) =>
    X.newFreeDrawElement({ type: 'freedraw', id, x: 0, y: 0, points: [[0, 0]], strokeWidth: 2, index: 'a0' })

  it('stamps each element the engine starts drawing once, in place, on the scene change it appears in', () => {
    const a = stroke('s1')
    const { api, port } = portOn([a], { newElement: a })
    const seen: string[] = []
    const off = port.onGestureElement((el) => {
      seen.push(el.id)
      return el.type === 'freedraw' ? { strokeWidth: 9, opacity: 50 } : null
    })
    const before = a.version
    port.afterSceneChange()
    // the engine's own object (a copy would end the stroke), newer
    expect(api.getSceneElementsIncludingDeleted()[0]).toBe(a)
    expect([a.strokeWidth, a.opacity]).toEqual([9, 50])
    expect(a.version).toBeGreaterThan(before)
    port.afterSceneChange(false)
    port.afterSceneChange()
    expect(seen).toEqual(['s1'])
    // the next stroke, then none after the removal
    const b = stroke('s2')
    api.updateScene({ elements: [a, b], appState: { newElement: b } })
    port.afterSceneChange()
    expect(b.strokeWidth).toBe(9)
    off()
    const c = stroke('s3')
    api.updateScene({ elements: [a, b, c], appState: { newElement: c } })
    port.afterSceneChange()
    expect(c.strokeWidth).toBe(2)
    expect(seen).toEqual(['s1', 's2'])
  })

  it('a hook that returns nothing writes nothing', () => {
    const a = stroke('s1')
    const { port } = portOn([a], { newElement: a })
    port.onGestureElement(() => null)
    const v = a.version
    port.afterSceneChange()
    expect(a.version).toBe(v)
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

// ---- W5-26 (CR-3F-1): a transact outside the undo history ---------------------------------------------------

const { UndoController } = await import('./history/controller.ts')
const { createLobbyCanvas } = await import('./api/impl.ts')
const { createFeatureRegistries } = await import('./api/registries.ts')

/** A port with Lobby's undo on it; the core is a stand-in (no pushes or acks: no engine in this test). */
function portWithUndo(initial: El[]) {
  const f = fakeApi(initial)
  const core = {
    welcome: null,
    sid: 'me',
    on: () => () => {},
    onAck: () => () => {},
    leaseHolders: () => new Map(),
    isDerivedHeld: () => false,
    confirmed: () => undefined,
    onSceneChange: () => {},
  }
  const scene = {
    read: () => ({ elements: f.api.getSceneElementsIncludingDeleted(), gesture: {} }),
    apply: (elements: El[]) => f.api.updateScene({ elements }),
  }
  const undo = new UndoController({
    core: core as never,
    scene: scene as never,
    bump: (el, patch) => ({ ...el, ...patch, version: el.version + 1, versionNonce: el.versionNonce + 1 }),
  })
  undo.history.reset(new Map(f.elements().map((e) => [e.id, e])))
  const port = createCanvasPort({
    api: f.api as never,
    core: null,
    registries: createRegistries(),
    undo,
    readOnly: () => false,
    editingLease: () => null,
  })
  return { ...f, port, undo }
}

const lobbyOf = (e: El) => (e?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}

describe('CanvasPort.transact with skipUndo (W5-26)', () => {
  it('records no step: the next Ctrl+Z undoes the colour change before the +1, and the +1 stays', () => {
    const { port, undo, elements } = portWithUndo([rect('a', 'a0'), rect('n', 'a1')])
    port.transact('colour', (tx) => tx.update('a', { backgroundColor: '#a7b7f6' }))
    expect(undo.history.undoSize).toBe(1)
    port.transact('+1', (tx) => tx.update('n', { customData: { lobby: { 'plusOne:me': true } } }), {
      skipUndo: true,
    })
    expect(undo.history.undoSize).toBe(1)
    expect(undo.boundary()).toBeNull() // the board page's boundary at Excalidraw's onChange
    const r = undo.undo()
    expect([...(r?.result.patches.keys() ?? [])]).toEqual(['a'])
    const byId = (id: string) => elements().find((e) => e.id === id)
    expect(byId('a')?.backgroundColor).toBe('transparent')
    expect(lobbyOf(byId('n'))).toEqual({ 'plusOne:me': true })
    expect(undo.undo()).toBeNull()
  })

  it('a create and a delete (with its label) outside the history are no steps either', () => {
    const { port, undo, elements } = portWithUndo([rect('a', 'a0')])
    const id = port.transact('note', (tx) => tx.create('note', { x: 0, y: 0, text: 'hi' }), {
      skipUndo: true,
    })
    expect(elements().filter((e) => e.id === id || e.containerId === id)).toHaveLength(2)
    expect(undo.boundary()).toBeNull()
    port.transact('drop', (tx) => tx.delete(id), { skipUndo: true })
    expect(elements().filter((e) => (e.id === id || e.containerId === id) && e.isDeleted)).toHaveLength(2)
    expect(undo.boundary()).toBeNull()
    expect([undo.history.undoSize, undo.history.redoSize]).toEqual([0, 0])
  })

  it('the canvas API passes it through (and it wins over joinPrevious, even on a canvas with no board page)', () => {
    const { port, undo } = portWithUndo([rect('a', 'a0'), rect('n', 'a1')])
    const { canvas, dispose } = createLobbyCanvas({ port, registries: createFeatureRegistries() })
    canvas.transact('colour', (tx) => tx.update('a', { strokeColor: '#e03131' }))
    expect(undo.history.undoSize).toBe(1)
    canvas.transact('+1', (tx) => tx.update('n', { customData: { lobby: { 'plusOne:me': true } } }), {
      skipUndo: true,
    })
    expect(
      canvas.transact('+1 again', () => 7, {
        skipUndo: true,
        joinPrevious: true,
      }),
    ).toBe(7)
    expect(undo.boundary()).toBeNull()
    expect(undo.history.undoSize).toBe(1)
    expect(lobbyOf(canvas.get('n'))).toEqual({ 'plusOne:me': true })
    dispose()
  })
})
