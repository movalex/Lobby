// W5-38 and W5-55 (./outlines.ts): the hover outline and the editing outline the board page draws.
import { describe, expect, it } from 'vitest'
import type { CanvasGesture } from '../api/lobby-canvas.ts'
import { editingOutline, hoverOutline, OUTLINE_PAD, type OutlineCanvas } from './outlines.ts'

type El = { id: string; type: string; x: number; y: number; width: number; height: number } & Record<
  string,
  unknown
>

function canvasWith(
  els: El[],
  state: Partial<{ gesture: CanvasGesture; tool: string; hovered: string | null }>,
) {
  const byId = new Map(els.map((e) => [e.id, e]))
  const s = {
    gesture: 'idle' as CanvasGesture,
    tool: 'select',
    hovered: null as string | null,
    selection: [] as string[],
    editing: null as string | null,
    zoom: 2,
    ...state,
  }
  const canvas = {
    get: (id: string) => byId.get(id),
    bounds: (id: string) => {
      const e = byId.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    get selection() {
      return s.selection
    },
    viewport: { get: () => ({ x: 0, y: 0, width: 500, height: 400, zoom: s.zoom }) },
    sceneToOverlay: (p: { x: number; y: number }) => ({ x: p.x * s.zoom, y: p.y * s.zoom }),
    gesture: () => s.gesture,
    hovered: () => s.hovered,
    tool: () => s.tool,
    editingId: () => s.editing,
    isLocked: (id: string) => !!byId.get(id)?.locked,
    isHidden: (id: string) => !!byId.get(id)?.hidden,
  } as unknown as OutlineCanvas
  return { canvas, s }
}

const note = (over: Partial<El> = {}): El => ({
  id: 'n',
  type: 'stickynote',
  x: 10,
  y: 20,
  width: 100,
  height: 100,
  angle: 0,
  ...over,
})

describe('the hover outline (W5-38)', () => {
  it('outlines the element under the pointer with the select tool at rest, as far out as the selection box', () => {
    const { canvas } = canvasWith([note()], { hovered: 'n' })
    expect(hoverOutline(canvas)).toEqual({
      id: 'n',
      x: 20 - OUTLINE_PAD,
      y: 40 - OUTLINE_PAD,
      w: 200 + 2 * OUTLINE_PAD,
      h: 200 + 2 * OUTLINE_PAD,
      angle: 0,
    })
  })

  it('none for a selected, locked or collapsed element, nothing under the pointer, or another gesture or tool', () => {
    const { canvas, s } = canvasWith(
      [note(), note({ id: 'k', locked: true }), note({ id: 'h', hidden: true })],
      {
        hovered: 'n',
      },
    )
    s.selection = ['n']
    expect(hoverOutline(canvas)).toBeNull()
    s.selection = []
    for (const id of ['k', 'h', null]) {
      s.hovered = id
      expect(hoverOutline(canvas), String(id)).toBeNull()
    }
    s.hovered = 'n'
    for (const g of ['pressing', 'dragging', 'drawing', 'editing-text', 'tool', 'panning'] as const) {
      s.gesture = g
      expect(hoverOutline(canvas), g).toBeNull()
    }
    s.gesture = 'idle'
    s.tool = 'hand' // a read-only Hand: the neutral engine state
    expect(hoverOutline(canvas)).toBeNull()
    s.tool = 'select'
    expect(hoverOutline(canvas)?.id).toBe('n')
  })

  it('a rotated shape’s outline turns with it; a connector’s is its bounds', () => {
    const { canvas, s } = canvasWith(
      [note({ angle: 0.5 }), { id: 'a', type: 'arrow', x: 0, y: 0, width: 50, height: 10, angle: 0.5 }],
      { hovered: 'n' },
    )
    expect(hoverOutline(canvas)?.angle).toBe(0.5)
    s.hovered = 'a'
    expect(hoverOutline(canvas)?.angle).toBe(0)
  })
})

describe('the editing outline (W5-55)', () => {
  it('outlines the note this tab is typing into, and nothing when no editor is open', () => {
    const { canvas, s } = canvasWith([note()], {})
    expect(editingOutline(canvas)).toBeNull()
    s.editing = 'n'
    s.gesture = 'editing-text'
    expect(editingOutline(canvas)?.id).toBe('n')
    // the hover outline steps aside while typing
    s.hovered = 'n'
    expect(hoverOutline(canvas)).toBeNull()
  })

  it('a free text too, but not a fixed-width one (the engine draws its own dashed box for it)', () => {
    const { canvas, s } = canvasWith(
      [
        { id: 't', type: 'text', x: 0, y: 0, width: 80, height: 20, autoResize: true },
        { id: 'w', type: 'text', x: 0, y: 0, width: 80, height: 20, autoResize: false },
      ],
      {},
    )
    s.editing = 't'
    expect(editingOutline(canvas)?.id).toBe('t')
    s.editing = 'w'
    expect(editingOutline(canvas)).toBeNull()
  })
})
