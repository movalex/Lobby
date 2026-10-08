// CR-W5-3G-4: a double-click a feature already took (`handled()`: stopped and prevented before this layer)
// never runs the lease flow; CR-3D-3: the key context carries a feature's type-to-edit rule and the open crop.
// Against a fake engine API: no DOM, no Excalidraw (its one function used here is stubbed).
import { describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => ({
  viewportCoordsToSceneCoords: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({
    x: clientX,
    y: clientY,
  }),
}))

const { CanvasInput } = await import('./CanvasInput.ts')

type Internals = {
  api: unknown
  editor: unknown
  onDblClick(e: MouseEvent): void
  keyContext(textEditor: null): Record<string, unknown>
}

const note = { id: 'n1', type: 'stickynote', x: 0, y: 0, width: 100, height: 100, angle: 0, groupIds: [] }
const image = { id: 'i1', type: 'image', x: 500, y: 0, width: 100, height: 100, angle: 0, groupIds: [] }

function appState(over: Record<string, unknown> = {}) {
  return {
    editingTextElement: null,
    multiElement: null,
    activeTool: { type: 'selection' },
    preferredSelectionTool: { type: 'selection' },
    selectedElementIds: {},
    selectedLinearElement: null,
    selectedGroupIds: {},
    zoom: { value: 1 },
    croppingElementId: null,
    ...over,
  }
}

function setup(opts: { selected?: string[]; app?: Record<string, unknown>; typeToEdit?: boolean } = {}) {
  const traces: { type: string; verdict?: string }[] = []
  const onEmpty = vi.fn()
  const requestEdit = vi.fn()
  const input = new CanvasInput({
    role: () => 'editor',
    lease: {} as never,
    setTool: () => true,
    onEmptyDoubleClick: onEmpty,
    trace: (t) => traces.push(t as never),
    ...(opts.typeToEdit === undefined
      ? {}
      : { typeToEdit: { applies: () => opts.typeToEdit === true, start: () => true } }),
  })
  const internals = input as unknown as Internals
  const selectedElementIds = Object.fromEntries((opts.selected ?? []).map((id) => [id, true]))
  internals.api = {
    getAppState: () => appState({ selectedElementIds, ...opts.app }),
    getSceneElements: () => [note, image],
  }
  internals.editor = { phase: 'idle', requestEdit, keyState: () => 'none' }
  return { input, internals, traces, onEmpty, requestEdit }
}

const dblclick = (over: Partial<MouseEvent> = {}) =>
  ({
    clientX: 50,
    clientY: 50,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
    ...over,
  }) as unknown as MouseEvent

describe('a double-click a feature took (CR-W5-3G-4)', () => {
  it('starts nothing: no lease request, no new text, and the event is left alone', () => {
    const t = setup()
    const e = dblclick({ defaultPrevented: true })
    t.internals.onDblClick(e)
    expect(t.requestEdit).not.toHaveBeenCalled()
    expect(t.onEmpty).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(t.traces.at(-1)).toMatchObject({ type: 'dblclick', verdict: 'handled' })
  })

  it('an untouched double-click on a note still runs the lease flow', () => {
    const t = setup()
    t.internals.onDblClick(dblclick())
    expect(t.requestEdit).toHaveBeenCalledWith('n1', expect.objectContaining({ reason: 'P3-dblclick' }))
  })

  it('and on empty canvas it makes a new text', () => {
    const t = setup()
    t.internals.onDblClick(dblclick({ clientX: 900, clientY: 900 }))
    expect(t.onEmpty).toHaveBeenCalledWith({ x: 900, y: 900 })
  })
})

describe('a double-tap a feature took (CR-W5-3G-4)', () => {
  class FakeCanvas {
    classList = { contains: (c: string) => c === 'interactive' }
  }
  const tap = (t: ReturnType<typeof setup>, time: number, x = 50, y = 50) => {
    const e = {
      target: new FakeCanvas(),
      timeStamp: time,
      touches: [{ clientX: x, clientY: y }],
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    }
    ;(t.internals as unknown as { onTouchStart(e: unknown): void }).onTouchStart(e)
    return e
  }
  const withTouch = (onDoubleTap?: (s: { x: number; y: number }) => boolean) => {
    vi.stubGlobal('HTMLCanvasElement', FakeCanvas)
    const t = setup()
    ;(t.input.opts as { onDoubleTap?: unknown }).onDoubleTap = onDoubleTap
    return t
  }

  it('is not a text edit: no lease request and no new text, and the touch is swallowed', () => {
    const took = vi.fn(() => true)
    const t = withTouch(took)
    tap(t, 0)
    const second = tap(t, 120)
    expect(took).toHaveBeenCalledWith({ x: 50, y: 50 }, { x: 50, y: 50 })
    expect(t.requestEdit).not.toHaveBeenCalled()
    expect(t.onEmpty).not.toHaveBeenCalled()
    expect(second.preventDefault).toHaveBeenCalled()
    expect(t.traces.map((x) => x.type)).toContain('doubletap-handled')
    vi.unstubAllGlobals()
  })

  it('a double-tap no feature took still runs the lease flow on a note, and makes a text on empty canvas', () => {
    const t = withTouch(() => false)
    tap(t, 0, 50, 50)
    tap(t, 100, 50, 50)
    expect(t.requestEdit).toHaveBeenCalledWith('n1', expect.objectContaining({ reason: 'P4-doubletap' }))
    const empty = withTouch(() => false)
    tap(empty, 1000, 900, 900)
    tap(empty, 1100, 900, 900)
    expect(empty.onEmpty).toHaveBeenCalledWith({ x: 900, y: 900 })
    vi.unstubAllGlobals()
  })
})

// Wave K round 1 refix (K5-3): a phone editor rests on Hand, where a one-finger drag pans. Excalidraw's own
// double-tap does nothing on Hand (handleCanvasDoubleClick returns for a tool that is not the selection
// tool, dist/dev/index.js:44733). Lobby keeps "double-tap a note to edit it" there only when both touches
// ended as taps (no move past TAP_SLOP_PX, no longer than TAP_MAX_MS), and never makes a new text on Hand.
describe('a double-tap on the Hand tool (wave K round 1 refix)', () => {
  class FakeCanvas {
    classList = { contains: (c: string) => c === 'interactive' }
  }
  type Touch = { clientX: number; clientY: number }
  const call = (t: ReturnType<typeof setup>, name: string, e: unknown) =>
    (t.internals as unknown as Record<string, (e: unknown) => void>)[name]?.(e)
  const ev = (time: number, touches: Touch[]) => ({
    target: new FakeCanvas(),
    timeStamp: time,
    touches,
    changedTouches: touches,
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  })
  const start = (t: ReturnType<typeof setup>, time: number, x: number, y: number) => {
    const e = ev(time, [{ clientX: x, clientY: y }])
    call(t, 'onTouchStart', e)
    return e
  }
  const move = (t: ReturnType<typeof setup>, time: number, x: number, y: number) =>
    call(t, 'onTouchMove', ev(time, [{ clientX: x, clientY: y }]))
  const end = (t: ReturnType<typeof setup>, time: number) => call(t, 'onTouchEnd', ev(time, []))
  const onHand = (onDoubleTap: (s: { x: number; y: number }) => boolean = () => false) => {
    vi.stubGlobal('HTMLCanvasElement', FakeCanvas)
    const t = setup({ app: { activeTool: { type: 'hand' } } })
    ;(t.input.opts as { onDoubleTap?: unknown }).onDoubleTap = onDoubleTap
    return t
  }

  it('two quick touchstarts (two pan swipes) make no new text on empty canvas and open no note', () => {
    const empty = onHand()
    start(empty, 0, 900, 900)
    start(empty, 250, 910, 905)
    expect(empty.onEmpty).not.toHaveBeenCalled()
    expect(empty.requestEdit).not.toHaveBeenCalled()
    const over = onHand()
    start(over, 0, 50, 50)
    start(over, 250, 60, 55)
    expect(over.requestEdit).not.toHaveBeenCalled()
    expect(over.onEmpty).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('two quick swipes that end (each moved well past a tap) do nothing either', () => {
    const t = onHand()
    start(t, 0, 50, 50)
    move(t, 60, 120, 50)
    end(t, 120)
    start(t, 250, 60, 55)
    move(t, 300, 140, 55)
    end(t, 370)
    expect(t.requestEdit).not.toHaveBeenCalled()
    expect(t.onEmpty).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('two real taps on a note open it (after the second tap ends); on empty canvas they make no text', () => {
    const t = onHand()
    start(t, 0, 50, 50)
    end(t, 40)
    start(t, 100, 52, 51)
    expect(t.requestEdit).not.toHaveBeenCalled() // not yet: the second touch may still become a pan
    end(t, 140)
    expect(t.requestEdit).toHaveBeenCalledWith('n1', expect.objectContaining({ reason: 'P4-doubletap' }))
    const empty = onHand()
    start(empty, 0, 900, 900)
    end(empty, 40)
    start(empty, 100, 900, 900)
    end(empty, 140)
    expect(empty.onEmpty).not.toHaveBeenCalled()
    expect(empty.requestEdit).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a second touch that turns into a pan cancels the edit; a feature that takes a double-tap still gets real taps', () => {
    const t = onHand()
    start(t, 0, 50, 50)
    end(t, 40)
    start(t, 100, 50, 50)
    move(t, 130, 90, 50)
    end(t, 200)
    expect(t.requestEdit).not.toHaveBeenCalled()
    const took = vi.fn(() => true)
    const f = onHand(took)
    start(f, 0, 50, 50)
    end(f, 40)
    start(f, 100, 50, 50)
    end(f, 140)
    expect(took).toHaveBeenCalledWith({ x: 50, y: 50 }, { x: 50, y: 50 })
    expect(f.requestEdit).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('the key context', () => {
  it('says when a crop is open, and what a feature’s type-to-edit rule says about the one selected element', () => {
    const open = setup({ selected: ['i1'], app: { croppingElementId: 'i1' } }).internals.keyContext(null)
    expect(open.cropping).toBe(true)
    const closed = setup({ selected: ['i1'] }).internals.keyContext(null)
    expect(closed.cropping).toBe(false)

    expect(setup({ selected: ['i1'], typeToEdit: true }).internals.keyContext(null).typeToEdit).toBe(true)
    expect(setup({ selected: ['i1'], typeToEdit: false }).internals.keyContext(null).typeToEdit).toBe(false)
    expect(setup({ selected: ['i1'] }).internals.keyContext(null).typeToEdit).toBe(false)
    // never with nothing or several selected
    expect(setup({ selected: [], typeToEdit: true }).internals.keyContext(null).typeToEdit).toBe(false)
    expect(setup({ selected: ['i1', 'n1'], typeToEdit: true }).internals.keyContext(null).typeToEdit).toBe(
      false,
    )
  })
})
