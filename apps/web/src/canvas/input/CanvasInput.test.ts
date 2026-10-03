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
