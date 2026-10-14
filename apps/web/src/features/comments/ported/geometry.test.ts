// OWNER: 3c. The comments anchor math on the Excalidraw canvas (./geometry.ts) on a fake canvas: element
// frames (rotation), click targets (a label hits its note, a frame's inside hits the frame, a file card
// gets a file anchor), one page (no page id on new anchors, legacy page ids shifted by lb_doc.import), and
// the labels of where a thread is.
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas, ScenePoint } from '../../../canvas/api/index.ts'
import {
  anchorAt,
  anchorForKeyboard,
  anchorPoint,
  cornerPinOffset,
  describeAnchor,
  elementFrame,
  pinCornerOf,
  pinPoint,
  placeOnBoard,
} from './geometry.ts'
import { readingOrder, stepLevel, stepSelection } from './keys.ts'

const el = (id: string, over: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type: 'stickynote',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: 'a0',
    boundElements: null,
    ...over,
  }) as unknown as CanvasElement

const inside = (e: CanvasElement, p: ScenePoint) =>
  p.x >= e.x && p.y >= e.y && p.x <= e.x + e.width && p.y <= e.y + e.height

function fakeCanvas(els: CanvasElement[], doc: Record<string, unknown> = {}) {
  let selection: string[] = []
  let view = { x: -100, y: -100, width: 1000, height: 800, zoom: 1 }
  const byId = new Map(els.map((e) => [e.id, e]))
  const canvas = {
    items: () => els,
    get: (id: string) => byId.get(id),
    isHidden: () => false,
    get selection() {
      return selection
    },
    select: (ids: string[]) => {
      selection = [...ids]
    },
    doc: { get: (k: string) => doc[k] },
    viewport: {
      get: () => view,
      set: (v: { x?: number; y?: number; zoom?: number }) => {
        view = { ...view, ...v }
      },
      screenRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    },
    sceneToOverlay: (p: ScenePoint) => ({ x: p.x - view.x, y: p.y - view.y }),
    // topmost element whose box holds the point; frames only on their edge (as Excalidraw hits them)
    hitTest: (p: ScenePoint) =>
      [...els].reverse().find((e) => e.type !== 'frame' && inside(e, p) && !(e.type === 'text' && false)) ??
      null,
  }
  return canvas as unknown as LobbyCanvas
}

describe('element frames', () => {
  it('maps a point into a rotated element and back', () => {
    const f = elementFrame(el('n', { x: 100, y: 50, width: 200, height: 100, angle: Math.PI / 2 }))
    // the top-left corner of the box, rotated a quarter turn about the centre (200, 100)
    const tl = f.toPage({ x: 0, y: 0 })
    expect(tl.x).toBeCloseTo(250)
    expect(tl.y).toBeCloseTo(0)
    const back = f.toLocal(tl)
    expect(back.x).toBeCloseTo(0)
    expect(back.y).toBeCloseTo(0)
  })
})

describe('anchors on the one page', () => {
  const note = el('note1', { x: 0, y: 0, width: 200, height: 100 })
  const label = el('note1.t', { type: 'text', containerId: 'note1', x: 20, y: 30, width: 160, height: 40 })
  const frame = el('frame1', { type: 'frame', name: 'Concept B', x: -50, y: -50, width: 800, height: 600 })
  const inFrame = el('note2', { x: 400, y: 0, frameId: 'frame1' })
  const card = el('card1', {
    type: 'image',
    x: 0,
    y: 300,
    width: 240,
    height: 160,
    customData: {
      lobby: {
        file: {
          assetId: 'ast_0123456789ab',
          versionId: 'ver_0123456789ab',
          kind: 'pdf',
          name: 'brief.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        },
      },
    },
  })
  const canvas = fakeCanvas([frame, note, label, inFrame, card])

  it('a click on a note is a shape anchor at the clicked spot (u, v), named as the api does', () => {
    expect(anchorAt(canvas, { x: 50, y: 75 })).toEqual({
      kind: 'shape',
      shapeId: 'shape:note1',
      u: 0.25,
      v: 0.75,
    })
  })

  it('a click on a label anchors to its note', () => {
    const c = fakeCanvas([note, label])
    // the fake's hit test returns the label (the topmost); the anchor names its container
    expect(anchorAt(c, { x: 100, y: 50 })).toMatchObject({ kind: 'shape', shapeId: 'shape:note1' })
  })

  it('empty space inside a frame anchors to the frame; outside any, a point pin without a page id', () => {
    expect(anchorAt(canvas, { x: 700, y: 500 })).toMatchObject({ kind: 'shape', shapeId: 'shape:frame1' })
    expect(anchorAt(canvas, { x: 2000, y: 2000 })).toEqual({ kind: 'point', x: 2000, y: 2000 })
  })

  it('a file card gets a file anchor', () => {
    expect(anchorAt(canvas, { x: 10, y: 310 })).toEqual({
      kind: 'asset',
      shapeId: 'shape:card1',
      assetId: 'ast_0123456789ab',
      versionId: 'ver_0123456789ab',
    })
  })

  it('shape anchors follow the element; a deleted one is an orphan', () => {
    expect(anchorPoint(canvas, { kind: 'shape', shapeId: 'shape:note2', u: 0.5, v: 0.5 })).toEqual({
      x: 500,
      y: 50,
    })
    expect(placeOnBoard(canvas, { kind: 'shape', shapeId: 'shape:gone', u: 0.5, v: 0.5 })).toEqual({
      kind: 'orphan',
    })
    expect(describeAnchor(canvas, { kind: 'shape', shapeId: 'shape:gone', u: 0.5, v: 0.5 })).toBe(
      'On a deleted object',
    )
  })

  it('labels say which frame and which kind of object, or the file', () => {
    expect(describeAnchor(canvas, { kind: 'shape', shapeId: 'shape:note2', u: 0.5, v: 0.5 })).toBe(
      'Concept B · note',
    )
    expect(describeAnchor(canvas, { kind: 'point', x: 700, y: 500 })).toBe('In Concept B')
    expect(describeAnchor(canvas, { kind: 'point', x: 2000, y: 2000 })).toBe('On the board')
    expect(
      describeAnchor(canvas, {
        kind: 'asset',
        shapeId: 'shape:card1',
        assetId: 'ast_0123456789ab',
        versionId: 'ver_0123456789ab',
        page: 2,
      }),
    ).toBe('On brief.pdf, page 2')
  })

  it('a legacy point anchor is shifted by its page offset (lb_doc.import.legacyPages), never "another page"', () => {
    const converted = fakeCanvas([], {
      import: { legacyPages: { 'page:page': { dx: 0, dy: 0 }, 'page:two': { dx: 4000, dy: -20 } } },
    })
    expect(anchorPoint(converted, { kind: 'point', x: 10, y: 30, pageId: 'page:two' })).toEqual({
      x: 4010,
      y: 10,
    })
    expect(anchorPoint(converted, { kind: 'point', x: 10, y: 30, pageId: 'page:unknown' })).toEqual({
      x: 10,
      y: 30,
    })
    expect(describeAnchor(converted, { kind: 'point', x: 10, y: 30, pageId: 'page:two' })).toBe(
      'On the board',
    )
  })

  it('the keyboard anchor is the selected object’s top-right corner, else the middle of the view', () => {
    const c = fakeCanvas([note, label])
    ;(c as unknown as { select(ids: string[]): void }).select(['note1.t'])
    expect(anchorForKeyboard(c)).toEqual({ kind: 'shape', shapeId: 'shape:note1', u: 1, v: 0 })
    ;(c as unknown as { select(ids: string[]): void }).select([])
    expect(anchorForKeyboard(c)).toEqual({ kind: 'point', x: 400, y: 300 })
  })
})

describe('keyboard stepping in the comment tool', () => {
  it('reading order is top to bottom, then left to right', () => {
    const order = readingOrder([
      el('c', { x: 0, y: 200 }),
      el('b', { x: 300, y: 0 }),
      el('a', { x: 0, y: 0 }),
    ])
    expect(order.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('Tab steps among the selection’s siblings; Ctrl+Shift+↓ enters a frame and ↑ leaves it', () => {
    const frame = el('f', { type: 'frame', x: 1000, y: 0, width: 600, height: 400 })
    const inner = el('i', { x: 1100, y: 100, frameId: 'f' })
    const a = el('a', { x: 0, y: 0 })
    const c = fakeCanvas([a, frame, inner])
    const sel = () => (c as unknown as { selection: string[] }).selection
    stepSelection(c, 'next')
    expect(sel()).toEqual(['a'])
    stepSelection(c, 'next')
    expect(sel()).toEqual(['f'])
    stepSelection(c, 'next')
    expect(sel()).toEqual(['a'])
    stepSelection(c, 'prev')
    expect(sel()).toEqual(['f'])
    stepLevel(c, 'in')
    expect(sel()).toEqual(['i'])
    stepLevel(c, 'out')
    expect(sel()).toEqual(['f'])
  })
})

describe('P-037: where a pin sits (clear of an element’s words)', () => {
  const note = el('note1', { x: 0, y: 0, width: 200, height: 100 })
  const turned = el('note2', { x: 100, y: 50, width: 200, height: 100, angle: Math.PI / 2 })
  const text = el('text1', { type: 'text', x: 0, y: 400, width: 120, height: 30 })
  const boxed = el('rect1', {
    type: 'rectangle',
    x: 300,
    y: 300,
    width: 100,
    height: 80,
    boundElements: [{ id: 'rect1.t', type: 'text' }],
  })
  const bare = el('rect2', { type: 'rectangle', x: 600, y: 300, width: 100, height: 80 })
  const photo = el('img1', { type: 'image', x: 0, y: 600, width: 200, height: 100 })
  const canvas = fakeCanvas([note, turned, text, boxed, bare, photo])
  const on = (id: string, u = 0.5, v = 0.5) => ({ kind: 'shape' as const, shapeId: `shape:${id}`, u, v })

  it('on a note, a text or a labelled shape: the element’s top-right corner, wherever it was clicked', () => {
    expect(pinPoint(canvas, on('note1', 0.25, 0.75))).toEqual({ x: 200, y: 0 })
    expect(pinPoint(canvas, on('text1'))).toEqual({ x: 120, y: 400 })
    expect(pinPoint(canvas, on('rect1', 0.1, 0.9))).toEqual({ x: 400, y: 300 })
    const corner = pinPoint(canvas, on('note2'))
    // the box's top-right corner turned a quarter about its centre (200, 100)
    expect(corner?.x).toBeCloseTo(250)
    expect(corner?.y).toBeCloseTo(200)
  })

  it('inside a note’s or a labelled shape’s corner (more pins leftwards), beside a text (more rightwards)', () => {
    expect(pinCornerOf(canvas, on('note1'))).toEqual({ id: 'note1', side: 'inside' })
    expect(pinCornerOf(canvas, on('rect1'))).toEqual({ id: 'rect1', side: 'inside' })
    expect(pinCornerOf(canvas, on('text1'))).toEqual({ id: 'text1', side: 'beside' })
    expect(pinCornerOf(canvas, on('img1'))).toBeNull()
    // the pin's pointed bottom-left corner, from the element's top-right corner (30 px pins, 4 px apart)
    expect(cornerPinOffset('inside', 0, 30, 4)).toEqual({ dx: -34, dy: 34 })
    expect(cornerPinOffset('inside', 1, 30, 4)).toEqual({ dx: -68, dy: 34 })
    expect(cornerPinOffset('beside', 0, 30, 4)).toEqual({ dx: 4, dy: 30 })
    expect(cornerPinOffset('beside', 1, 30, 4)).toEqual({ dx: 38, dy: 30 })
  })

  it('on a picture, a bare shape or the board: the spot itself (the anchor)', () => {
    expect(pinPoint(canvas, on('img1', 0.25, 0.5))).toEqual(anchorPoint(canvas, on('img1', 0.25, 0.5)))
    expect(pinPoint(canvas, on('rect2', 0.25, 0.5))).toEqual({ x: 625, y: 340 })
    expect(pinPoint(canvas, { kind: 'point', x: 5, y: 6 } as never)).toEqual({ x: 5, y: 6 })
    expect(pinPoint(canvas, on('gone'))).toBeNull()
  })
})
