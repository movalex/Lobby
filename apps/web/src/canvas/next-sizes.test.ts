// CR-3A-7 (wave D6): a note's label and a free text each have their own next font size. The engine keeps one
// (`currentItemFontSize`), so a note's L (26) became the next text's size; the port now keeps two over it
// (port-impl.ts `nextFontSize` / `setNextFontSize`, swapped when the tool changes) and the styles part sends a
// pick on a selection to the kind it was made on.
//
// The browser engine (@excalidraw/excalidraw) does not load in Node: the few names port-impl takes from it are
// given here from the element package, as port-impl.test.ts does.
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

;(globalThis as { window?: unknown }).window ??= globalThis
;(element as unknown as { setCustomTextMetricsProvider(p: unknown): void }).setCustomTextMetricsProvider({
  getLineWidth: (t: string) => t.length * 10,
})
const { createCanvasPort } = await import('./port-impl.ts')
const { createRegistries } = await import('./registries.ts')
const { createStylesPart } = await import('./api/parts/styles.ts')

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects, typed loosely in this test
type El = any

/**
 * A minimal engine API: one scene, app state merged by `updateScene`, and a tool that `setActiveTool` puts in
 * the state as the engine would. `change()` is the engine's onChange (what the board session forwards to
 * `afterSceneChange`).
 */
function portOn(state: Record<string, unknown> = {}) {
  let elements: El[] = []
  let appState: Record<string, unknown> = {
    currentItemRoughness: 0,
    currentItemStrokeColor: '#1e1e1e',
    // Excalidraw's own default: what a fresh engine holds
    currentItemFontSize: 20,
    selectedElementIds: {},
    zoom: { value: 1 },
    scrollX: 0,
    scrollY: 0,
    width: 1000,
    height: 800,
    activeTool: { type: 'selection', customType: null },
    ...state,
  }
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElementsMapIncludingDeleted: () => new Map(elements.map((e) => [e.id, e])),
    getSceneElements: () => elements.filter((e) => !e.isDeleted),
    getAppState: () => appState,
    updateScene(u: { elements?: El[]; appState?: Record<string, unknown> }) {
      if (u.elements) elements = u.elements
      if (u.appState) appState = { ...appState, ...u.appState }
    },
    onScrollChange: () => () => {},
    setActiveTool(t: { type: string; customType?: string }) {
      appState = { ...appState, activeTool: { type: t.type, customType: t.customType ?? null } }
    },
  }
  const port = createCanvasPort({
    api: api as never,
    core: null,
    registries: createRegistries(),
    undo: null,
    readOnly: () => false,
    editingLease: () => null,
  })
  return {
    api,
    port,
    elements: () => elements,
    /** the engine's own tool change (a key, a toolbar button that does not go through the port) */
    engineTool(t: { type: string; customType?: string }) {
      api.setActiveTool(t)
      port.afterSceneChange(false)
    },
    /** `styles.setNext({ fontSize })` as the engine receives it: the one next size */
    pick(size: number) {
      api.updateScene({ appState: { currentItemFontSize: size } })
      port.afterSceneChange(false)
    },
    engineSize: () => appState.currentItemFontSize as number,
    fontOfNewText() {
      const id = port.transact('text', (tx) => tx.create('text', { x: 0, y: 0, text: 'hi' }))
      return (api.getSceneElements().find((e) => e.id === id) as El).fontSize as number
    },
  }
}

const NOTE_TOOL = { type: 'custom', customType: 'lobby-note' }
const TEXT_TOOL = { type: 'custom', customType: 'lobby-text' }
const SELECT = { type: 'selection' }

describe('the next note label size and the next text size (CR-3A-7)', () => {
  it('a note’s L is not the next text’s size: the text tool starts from the text’s own', () => {
    const t = portOn()
    t.engineTool(NOTE_TOOL)
    t.pick(26)
    // the note tool hands over to select while the label is made: it keeps the label's size
    t.engineTool(SELECT)
    expect(t.engineSize()).toBe(26)
    t.engineTool(TEXT_TOOL)
    expect(t.engineSize()).toBe(20)
    expect(t.fontOfNewText()).toBe(20)
    expect(t.port.nextFontSize('note')).toBe(26)
    expect(t.port.nextFontSize('text')).toBe(20)
  })

  it('each tool keeps its own pick: text 44, note 26, back and forth', () => {
    const t = portOn()
    t.engineTool(NOTE_TOOL)
    t.pick(26)
    t.engineTool(TEXT_TOOL)
    t.pick(44)
    expect(t.fontOfNewText()).toBe(44)
    t.engineTool(NOTE_TOOL)
    expect(t.engineSize()).toBe(26)
    expect(t.port.nextFontSize('note')).toBe(26)
    expect(t.port.nextFontSize('text')).toBe(44)
    t.engineTool(TEXT_TOOL)
    expect(t.engineSize()).toBe(44)
    expect(t.fontOfNewText()).toBe(44)
    // a smaller text pick does not touch the note's either
    t.pick(18)
    t.engineTool(NOTE_TOOL)
    expect(t.engineSize()).toBe(26)
  })

  it('a text made right after a pick, before the engine has reported it, is the picked size', () => {
    const t = portOn()
    t.engineTool(TEXT_TOOL)
    t.api.updateScene({ appState: { currentItemFontSize: 36 } })
    expect(t.fontOfNewText()).toBe(36)
  })

  it('setTool through the port swaps at once, with no engine change in between', () => {
    const t = portOn()
    expect(t.port.setTool('note')).toBe(true)
    t.pick(26)
    expect(t.port.setTool('text')).toBe(true)
    // the engine's next size is already the text's
    expect(t.engineSize()).toBe(20)
    expect(t.fontOfNewText()).toBe(20)
    t.pick(44)
    expect(t.port.setTool('note')).toBe(true)
    expect(t.engineSize()).toBe(26)
    expect(t.port.setTool('rectangle')).toBe(true)
    expect(t.engineSize()).toBe(26)
    expect(t.port.setTool('text')).toBe(true)
    expect(t.engineSize()).toBe(44)
    // a refused tool changes nothing
    expect(t.port.setTool('image')).toBe(false)
    expect(t.engineSize()).toBe(44)
  })

  it('setNextFontSize sets one kind’s size: the other is untouched, the engine shows the tool in hand’s', () => {
    const t = portOn()
    t.engineTool(NOTE_TOOL)
    t.port.setNextFontSize('text', 44)
    expect(t.engineSize()).toBe(20)
    expect(t.port.nextFontSize('text')).toBe(44)
    t.port.setNextFontSize('note', 32)
    expect(t.engineSize()).toBe(32)
    t.engineTool(TEXT_TOOL)
    expect(t.engineSize()).toBe(44)
    t.port.setNextFontSize('note', 22)
    expect(t.engineSize()).toBe(44)
    t.engineTool(SELECT)
    expect(t.engineSize()).toBe(22)
    // nonsense is ignored
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) t.port.setNextFontSize('note', bad)
    expect(t.port.nextFontSize('note')).toBe(22)
  })

  it('both start from the engine’s size, as they did when it was the one (a restored 36)', () => {
    const t = portOn({ currentItemFontSize: 36 })
    expect(t.port.nextFontSize('note')).toBe(36)
    expect(t.port.nextFontSize('text')).toBe(36)
    expect(t.fontOfNewText()).toBe(36)
    // and a port that starts with the text tool in hand holds the text's slot
    const u = portOn({ currentItemFontSize: 30, activeTool: { type: 'custom', customType: 'lobby-text' } })
    u.pick(44)
    u.engineTool(NOTE_TOOL)
    expect(u.engineSize()).toBe(30)
    expect(u.port.nextFontSize('text')).toBe(44)
  })

  it('a creator’s own size wins, and a text made with the select tool in hand takes the text’s', () => {
    const t = portOn()
    t.engineTool(NOTE_TOOL)
    t.pick(26)
    t.engineTool(SELECT)
    const id = t.port.transact('text', (tx) => tx.create('text', { x: 0, y: 0, text: 'x', fontSize: 18 }))
    expect((t.elements().find((e) => e.id === id) as El).fontSize).toBe(18)
    // the text slot was never picked: the default, whatever the note's size
    expect(t.fontOfNewText()).toBe(20)
  })

  it('a note made with no text of its own takes no size from either (its label is made when it is typed in)', () => {
    const t = portOn()
    t.engineTool(TEXT_TOOL)
    t.pick(44)
    const id = t.port.transact('note', (tx) => tx.create('note', { x: 0, y: 0, size: 200 }))
    const note = t.elements().find((e) => e.id === id) as El
    expect(note.type).toBe('stickynote')
    // the engine's next size at that point (the select tool, after the note tool's click) is the label's
    t.engineTool(SELECT)
    expect(t.engineSize()).toBe(20)
  })
})

// ---- a pick on a selection goes to the kind it was made on ---------------------------------------------------

describe('styles.apply: a font size picked on a selection is the next size of that kind (CR-3A-7)', () => {
  const rect = (id: string, over: El = {}) =>
    element.newElement({ type: 'rectangle', id, x: 0, y: 0, width: 100, height: 100, roughness: 0, ...over })

  function stylesOn(world: El[]) {
    const t = portOn()
    const byId = new Map<string, El>(world.map((e) => [e.id, e]))
    const nextCalls: Record<string, unknown>[] = []
    const canvas = {
      get: (id: string) => byId.get(id),
      selection: [] as string[],
      // read-only: the next style is set, no element is written (the layout of text needs a browser's canvas)
      readOnly: () => true,
      styles: { setNext: (p: Record<string, unknown>) => nextCalls.push(p) },
    }
    const part = createStylesPart({
      port: t.port,
      registries: createRegistries(),
      self: () => canvas,
    } as never)
    return { ...t, part, nextCalls }
  }
  /** a sticky note (the engine's type: the element package's typings name only its own shapes) */
  const note = (id: string): El =>
    (element as unknown as { newElement(p: Record<string, unknown>): El }).newElement({
      type: 'stickynote',
      id,
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    })
  const text = (id: string, over: El = {}) =>
    element.newTextElement({ id, x: 0, y: 0, text: 'free', fontSize: 20, ...over })

  it('texts: the next text’s size, not the note label’s', () => {
    const s = stylesOn([text('t1')])
    s.part.apply({ fontSize: 36 }, ['t1'])
    expect(s.port.nextFontSize('text')).toBe(36)
    expect(s.port.nextFontSize('note')).toBe(20)
    // the engine's own (the select tool is in hand: the label's) is not the text's size
    expect(s.engineSize()).toBe(20)
    expect(s.nextCalls).toEqual([])
  })

  it('a note or a shape with a label: the next label size, not the text’s', () => {
    for (const container of [note('n1'), rect('r1')]) {
      const s = stylesOn([container])
      s.part.apply({ fontSize: 26 }, [container.id])
      expect(s.port.nextFontSize('note')).toBe(26)
      expect(s.port.nextFontSize('text')).toBe(20)
      expect(s.engineSize()).toBe(26)
    }
  })

  it('a label’s own id counts as its container’s kind', () => {
    const n1 = note('n1')
    const label = text('l1', { containerId: 'n1' })
    const s = stylesOn([n1, label])
    s.part.apply({ fontSize: 22 }, ['l1'])
    expect(s.port.nextFontSize('note')).toBe(22)
    expect(s.port.nextFontSize('text')).toBe(20)
  })

  it('one pick on both kinds is both kinds’ next size; the rest of the patch is the next style as before', () => {
    const s = stylesOn([text('t1'), note('n1')])
    s.part.apply({ fontSize: 30, strokeColor: '#e03131' }, ['t1', 'n1'])
    expect(s.port.nextFontSize('text')).toBe(30)
    expect(s.port.nextFontSize('note')).toBe(30)
    expect(s.nextCalls).toEqual([{ strokeColor: '#e03131' }])
  })

  it('with no text on the targets (none, or a frame) the pick is the engine’s next style as before', () => {
    const s = stylesOn([])
    s.part.apply({ fontSize: 44 }, [])
    expect(s.nextCalls).toEqual([{ fontSize: 44 }])
    expect(s.port.nextFontSize('text')).toBe(20)
    expect(s.port.nextFontSize('note')).toBe(20)
  })

  it('a port without next sizes (a bare canvas) keeps the whole patch as the next style', () => {
    const t = stylesOn([text('t1')])
    const calls: Record<string, unknown>[] = []
    const canvas = {
      get: (id: string) => (id === 't1' ? text('t1') : undefined),
      selection: [] as string[],
      readOnly: () => true,
      styles: { setNext: (p: Record<string, unknown>) => calls.push(p) },
    }
    const part = createStylesPart({
      port: {} as never,
      registries: createRegistries(),
      self: () => canvas,
    } as never)
    part.apply({ fontSize: 36 }, ['t1'])
    expect(calls).toEqual([{ fontSize: 36 }])
    expect(t.port.nextFontSize('text')).toBe(20)
  })

  it('a pick on notes while the text tool is in hand does not move the text tool’s size', () => {
    const n1 = note('n1')
    const s = stylesOn([n1])
    s.engineTool(TEXT_TOOL)
    s.pick(44)
    s.part.apply({ fontSize: 26 }, ['n1'])
    expect(s.engineSize()).toBe(44)
    expect(s.port.nextFontSize('text')).toBe(44)
    expect(s.port.nextFontSize('note')).toBe(26)
    s.engineTool(NOTE_TOOL)
    expect(s.engineSize()).toBe(26)
  })
})

describe('the next note’s size (P-011): the note tool’s Size', () => {
  it('starts at Lobby’s 200 px note, takes a side, and ignores nonsense', () => {
    const t = portOn()
    expect(t.port.nextNoteSide()).toBe(200)
    t.port.setNextNoteSide(400)
    expect(t.port.nextNoteSide()).toBe(400)
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) t.port.setNextNoteSide(bad)
    expect(t.port.nextNoteSide()).toBe(400)
  })

  it('is the note’s own: no tool change or font pick touches it', () => {
    const t = portOn()
    t.port.setNextNoteSide(300)
    t.engineTool(NOTE_TOOL)
    t.pick(33)
    t.engineTool(TEXT_TOOL)
    t.pick(44)
    t.engineTool(SELECT)
    expect(t.port.nextNoteSide()).toBe(300)
  })
})
