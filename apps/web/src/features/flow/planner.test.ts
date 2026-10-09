// L4-1: the connected-shape planner (./planner.ts) and its apply (./build.ts): direction, gap, the obstacle step,
// the style copy and the frame parent; one transact plus a joinPrevious bind through LobbyTx.bind; one undo
// removes the shape and the connector. The geometry rules of the connector (./connector.ts): its whole path unit in
// the creation props, starting on the sides the binds name.
import { pathUnitProblem } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { applyConnected, applyConnector, FLOW_UNDO_LABEL } from './build.ts'
import { elbowGeometry, sidesFor } from './connector.ts'
import { flowKindOf, flowSourceOf, freeSlot, gapFor, planConnected, planConnector } from './planner.ts'
import { type El, fakeFlowCanvas, testId } from './test-canvas.ts'

const newId = () => testId('n')
const RECT: Partial<El> = {
  id: 'src',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  strokeColor: '#1971c2',
  backgroundColor: '#a5d8ff',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'dashed',
  roughness: 1,
  opacity: 90,
  roundness: { type: 3 },
  customData: { lobby: { tag: { key: 'x' }, ai: { by: 'usr_1' } } },
}

describe('planConnected: direction and gap', () => {
  for (const [dir, x, y] of [
    ['right', 200 + 100, 0],
    ['left', -100 - 200, 0],
    ['down', 0, 100 + 80],
    ['up', 0, -80 - 100],
  ] as const)
    it(`${dir}: the source's size, G = max(80, half the source along the direction) away, lined up`, () => {
      const f = fakeFlowCanvas([RECT])
      const plan = planConnected(f.canvas, 'src', dir, { newId })
      expect(plan?.box).toEqual({ x, y, w: 200, h: 100 })
    })

  it('the gap is at least 80 (twice the elbow router padding)', () => {
    expect(gapFor({ x: 0, y: 0, w: 30, h: 30 }, 'right')).toBe(80)
    expect(gapFor({ x: 0, y: 0, w: 300, h: 30 }, 'right')).toBe(150)
    expect(gapFor({ x: 0, y: 0, w: 300, h: 30 }, 'down')).toBe(80)
  })
})

describe('planConnected: the obstacle step', () => {
  it('a taken slot branches beside it (across the direction) first', () => {
    const f = fakeFlowCanvas([RECT, { id: 'b', type: 'rectangle', x: 300, y: 0, width: 200, height: 100 }])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    // one slot below: the shape's height plus the gap (100 + 100)
    expect(plan?.box).toEqual({ x: 300, y: 200, w: 200, h: 100 })
  })

  it('with both branches taken too, it steps along past them', () => {
    const f = fakeFlowCanvas([RECT, { id: 'b', type: 'rectangle', x: 300, y: -400, width: 200, height: 900 }])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    expect(plan?.box.y).toBe(0)
    expect(plan?.box.x).toBe(300 + 300)
  })

  it('a connector or a line in the way is crossed, not avoided; a label never counts', () => {
    const f = fakeFlowCanvas([
      RECT,
      {
        id: 'a',
        type: 'arrow',
        x: 250,
        y: 0,
        width: 300,
        height: 80,
        points: [
          [0, 0],
          [300, 80],
        ],
      },
      {
        id: 'l',
        type: 'line',
        x: 280,
        y: 20,
        width: 300,
        height: 0,
        points: [
          [0, 0],
          [300, 0],
        ],
      },
    ])
    expect(planConnected(f.canvas, 'src', 'right', { newId })?.box).toEqual({ x: 300, y: 0, w: 200, h: 100 })
  })

  it('freeSlot keeps a gap/2 margin from what is around', () => {
    // an obstacle 20 px under the aligned slot (the margin is 50): the branch above is taken instead
    const slot = freeSlot({ x: 0, y: 0, w: 200, h: 100 }, { w: 200, h: 100 }, 'right', [
      { x: 300, y: 120, w: 50, h: 50 },
    ])
    expect(slot).toEqual({ x: 300, y: -200, w: 200, h: 100 })
  })
})

describe('planConnected: what the next shape is', () => {
  it("copies the source's shape style and size, never its customData", () => {
    const f = fakeFlowCanvas([RECT])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    expect(plan?.shape.kind).toBe('rectangle')
    expect(plan?.shape.props).toMatchObject({
      strokeColor: '#1971c2',
      backgroundColor: '#a5d8ff',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'dashed',
      roughness: 1,
      opacity: 90,
      roundness: { type: 3 },
      width: 200,
      height: 100,
    })
    expect(plan?.shape.props.customData).toBeUndefined()
  })

  it('a diamond makes a diamond, an ellipse an ellipse, a note a note of its colour and size', () => {
    for (const type of ['diamond', 'ellipse'] as const) {
      const f = fakeFlowCanvas([{ ...RECT, type }])
      expect(planConnected(f.canvas, 'src', 'down', { newId })?.shape.kind).toBe(type)
    }
    const f = fakeFlowCanvas([
      { id: 'n', type: 'stickynote', x: 0, y: 0, width: 200, height: 200, backgroundColor: '#f8e48f' },
    ])
    const plan = planConnected(f.canvas, 'n', 'right', { newId })
    expect(plan?.shape.kind).toBe('note')
    expect(plan?.shape.props).toMatchObject({ size: 200, backgroundColor: '#f8e48f', x: 300, y: 0, text: '' })
  })

  it('the kind asked for wins (Ctrl/Cmd+Shift+Arrow repeats the last created kind)', () => {
    const f = fakeFlowCanvas([RECT])
    const plan = planConnected(f.canvas, 'src', 'right', { newId, kind: 'diamond' })
    expect(plan?.shape.kind).toBe('diamond')
  })

  it('off for frames, locked elements, mind-map topics, connectors and free text', () => {
    const f = fakeFlowCanvas([
      { id: 'fr', type: 'frame', x: 0, y: 0, width: 400, height: 300 },
      { ...RECT, id: 'locked', locked: true },
      {
        ...RECT,
        id: 'topic',
        customData: {
          lobby: { mindmap: { rootId: 'topic', parentId: null, side: 'right', collapsed: false } },
        },
      },
      {
        id: 'arr',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 10,
        height: 0,
        points: [
          [0, 0],
          [10, 0],
        ],
      },
      { id: 'txt', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x', originalText: 'x' },
    ])
    for (const id of ['fr', 'locked', 'topic', 'arr', 'txt']) {
      expect(flowKindOf(f.canvas, f.canvas.get(id)), id).toBeNull()
      expect(planConnected(f.canvas, id, 'right', { newId }), id).toBeNull()
    }
  })

  it('the source is the one selected shape; a selected label stands for its container', () => {
    const f = fakeFlowCanvas([
      { ...RECT, boundElements: [{ id: 'lbl', type: 'text' }] },
      {
        id: 'lbl',
        type: 'text',
        containerId: 'src',
        x: 10,
        y: 10,
        width: 50,
        height: 25,
        text: 'a',
        originalText: 'a',
      },
      { ...RECT, id: 'other', x: 900 },
    ])
    expect(flowSourceOf(f.canvas, ['lbl'])).toBe('src')
    expect(flowSourceOf(f.canvas, ['src', 'lbl'])).toBe('src')
    expect(flowSourceOf(f.canvas, ['src', 'other'])).toBeNull()
    expect(flowSourceOf(f.canvas, [])).toBeNull()
  })
})

describe('planConnected: the frame parent', () => {
  const FRAME: Partial<El> = { id: 'fr', type: 'frame', x: -50, y: -50, width: 400, height: 300 }

  it("goes in the source's frame, which grows right to hold it", () => {
    const f = fakeFlowCanvas([FRAME, { ...RECT, frameId: 'fr' }])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    expect(plan?.frameId).toBe('fr')
    expect(plan?.shape.props.frameId).toBe('fr')
    expect(plan?.arrow.frameId).toBe('fr')
    // the shape ends at x 500; the frame (from -50) needs 500 + 20 - (-50) = 570
    expect(plan?.frameGrow).toEqual({ id: 'fr', x: -50, y: -50, width: 570, height: 300 })
  })

  it("the frame's own elements are its obstacles; a locked frame does not grow, so the shape stays outside it", () => {
    const f = fakeFlowCanvas([
      { ...FRAME, locked: true },
      { ...RECT, frameId: 'fr' },
    ])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    expect(plan?.frameGrow).toBeNull()
    expect(plan?.frameId).toBeNull()
  })

  it('going left out of the frame, the frame grows left to hold it (only its own box changes)', () => {
    const f = fakeFlowCanvas([
      { id: 'fr', type: 'frame', x: -50, y: -50, width: 900, height: 600 },
      { ...RECT, frameId: 'fr' },
    ])
    const plan = planConnected(f.canvas, 'src', 'left', { newId })
    expect(plan?.frameId).toBe('fr')
    expect(plan?.box.x).toBe(-300)
    expect(plan?.frameGrow).toEqual({ id: 'fr', x: -320, y: -50, width: 1170, height: 600 })
  })

  it('a + handle dropped outside the frame: the shape and its connector go on the open canvas, the frame stays', () => {
    // the frame spans -50..350 x -50..250; the source is inside it
    const f = fakeFlowCanvas([FRAME, { ...RECT, frameId: 'fr' }])
    const plan = planConnected(f.canvas, 'src', 'right', { newId, at: { x: 1200, y: 400 } })
    expect(plan?.box).toEqual({ x: 1100, y: 350, w: 200, h: 100 })
    expect(plan?.frameId).toBeNull()
    expect(plan?.frameGrow).toBeNull()
    expect(plan?.shape.props.frameId).toBeNull()
    expect(plan?.arrow.frameId).toBeNull()
    // a note too (it joins no frame in the bind)
    const n = fakeFlowCanvas([
      FRAME,
      { id: 'nt', type: 'stickynote', x: 0, y: 0, width: 200, height: 200, frameId: 'fr' },
    ])
    const notePlan = planConnected(n.canvas, 'nt', 'right', { newId, at: { x: 1200, y: 400 } })
    expect(notePlan?.frameId).toBeNull()
    expect(notePlan?.frameGrow).toBeNull()
  })

  it('a + handle dropped inside the frame: the shape is the frame’s, which grows only to hold it', () => {
    const f = fakeFlowCanvas([FRAME, { ...RECT, frameId: 'fr' }])
    // dropped at (300, 200), inside; the shape (200 x 100 centred there) reaches 400 x 250
    const plan = planConnected(f.canvas, 'src', 'right', { newId, at: { x: 300, y: 200 } })
    expect(plan?.frameId).toBe('fr')
    expect(plan?.arrow.frameId).toBe('fr')
    expect(plan?.frameGrow).toEqual({ id: 'fr', x: -50, y: -50, width: 470, height: 320 })
  })
})

describe('the connector', () => {
  it('carries its whole path unit, an elbow, from the facing side to the facing side', () => {
    const f = fakeFlowCanvas([RECT])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    const a = plan?.arrow as Record<string, unknown>
    expect(a).toMatchObject({
      x: 200,
      y: 50,
      width: 100,
      height: 0,
      angle: 0,
      elbowed: true,
      points: [
        [0, 0],
        [100, 0],
      ],
    })
    expect(a.strokeColor).toBe('#1971c2')
    expect(a.endArrowhead).toBe('arrow')
    expect(a.startArrowhead).toBeNull()
    // the client part of the unit (the engine adds fixedSegments' value, startIsSpecial and endIsSpecial)
    expect(
      pathUnitProblem({ ...a, fixedSegments: [], startIsSpecial: false, endIsSpecial: false }, 'arrow'),
    ).toBeNull()
  })

  it('elbowGeometry bends once between sides of the same axis, at a corner between crossing axes', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 }
    const b = { x: 300, y: 200, w: 100, h: 50 }
    expect(elbowGeometry(a, 'right', b, 'left').points).toEqual([
      [0, 0],
      [100, 0],
      [100, 200],
      [200, 200],
    ])
    expect(elbowGeometry(a, 'bottom', b, 'top').points).toEqual([
      [0, 0],
      [0, 75],
      [300, 75],
      [300, 150],
    ])
    expect(elbowGeometry(a, 'right', b, 'top').points).toEqual([
      [0, 0],
      [250, 0],
      [250, 175],
    ])
  })

  it('sidesFor: down a layer bottom to top, a back edge out of and into the side', () => {
    const top = { x: 0, y: 0, w: 100, h: 50 }
    const low = { x: 0, y: 200, w: 100, h: 50 }
    expect(sidesFor(top, low, 'down')).toEqual({ from: 'bottom', to: 'top' })
    expect(sidesFor(low, top, 'down')).toEqual({ from: 'right', to: 'right' })
    expect(sidesFor(top, { x: 300, y: 0, w: 100, h: 50 }, 'right')).toEqual({ from: 'right', to: 'left' })
  })
})

describe('applyConnected: one undo step', () => {
  it('one transact (the shape and the connector), then a joinPrevious bind of both ends through LobbyTx.bind', () => {
    const f = fakeFlowCanvas([RECT])
    const plan = planConnected(f.canvas, 'src', 'right', { newId })
    if (!plan) throw new Error('no plan')
    applyConnected(f.canvas, plan)
    expect(f.transacts.map((t) => [t.label, t.joined])).toEqual([
      [FLOW_UNDO_LABEL, false],
      [FLOW_UNDO_LABEL, true],
    ])
    expect(f.transacts[0]?.ops).toEqual([`create rectangle ${plan.shapeId}`, `create arrow ${plan.arrowId}`])
    expect(f.binds).toEqual([
      { arrow: plan.arrowId, end: 'start', target: 'src' },
      { arrow: plan.arrowId, end: 'end', target: plan.shapeId },
    ])
    // the bind wrote only the bindings and the targets' lists: no geometry of the arrow after its creation
    expect(f.transacts[1]?.ops.filter((o) => o.startsWith(`update ${plan.arrowId}`))).toEqual([
      `update ${plan.arrowId} startBinding`,
      `update ${plan.arrowId} endBinding`,
    ])
    const arrow = f.els.get(plan.arrowId) as Record<string, unknown>
    expect(arrow.startBinding).toEqual({ elementId: 'src', fixedPoint: [1, 0.5], mode: 'orbit' })
    expect(arrow.endBinding).toEqual({ elementId: plan.shapeId, fixedPoint: [0, 0.5], mode: 'orbit' })
    expect(f.els.get('src')?.boundElements).toEqual([{ id: plan.arrowId, type: 'arrow' }])
    expect(f.els.get(plan.shapeId)?.boundElements).toEqual([{ id: plan.arrowId, type: 'arrow' }])
    expect(f.steps()).toBe(1)
  })

  it('one undo removes the shape and the connector, and the board is as it was', () => {
    const f = fakeFlowCanvas([RECT])
    const before = f.snapshot()
    const plan = planConnected(f.canvas, 'src', 'down', { newId })
    if (!plan) throw new Error('no plan')
    applyConnected(f.canvas, plan)
    expect(f.live()).toHaveLength(3)
    expect(f.undo()).toBe(true)
    expect(f.snapshot()).toBe(before)
    expect(f.steps()).toBe(0)
  })

  it('a frame that grows grows in the same step; a note joins its frame in the joined bind', () => {
    const f = fakeFlowCanvas([
      { id: 'fr', type: 'frame', x: -50, y: -50, width: 300, height: 300 },
      {
        id: 'n',
        type: 'stickynote',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        frameId: 'fr',
        backgroundColor: '#f8e48f',
      },
    ])
    const before = f.snapshot()
    const plan = planConnected(f.canvas, 'n', 'down', { newId })
    if (!plan) throw new Error('no plan')
    applyConnected(f.canvas, plan)
    expect(f.els.get('fr')?.height).toBeGreaterThan(300)
    expect(f.els.get(plan.shapeId)?.frameId).toBe('fr')
    expect(f.els.get(`${plan.shapeId}.t`)?.frameId).toBe('fr')
    f.undo()
    expect(f.snapshot()).toBe(before)
  })

  it('applyConnector joins two existing shapes in one step', () => {
    const f = fakeFlowCanvas([RECT, { ...RECT, id: 'b', x: 600, y: 300, customData: undefined }])
    const plan = planConnector(f.canvas, 'src', 'b', { newId })
    if (!plan) throw new Error('no plan')
    applyConnector(f.canvas, 'src', 'b', plan)
    expect(f.steps()).toBe(1)
    const arrow = f.els.get(plan.arrowId) as Record<string, unknown>
    expect((arrow.startBinding as { elementId: string }).elementId).toBe('src')
    expect((arrow.endBinding as { elementId: string }).elementId).toBe('b')
    expect(planConnector(f.canvas, 'src', 'src', { newId })).toBeNull()
  })
})
