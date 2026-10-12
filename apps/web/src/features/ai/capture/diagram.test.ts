// Wave N (WS5, N5-3): a diagram from a photo (./diagram.ts) through W4's graph and writer: the three shapes and their
// labels, labelled edges and plain lines as bound elbow connectors (their whole path unit in the creation only, both
// ends bound in the joined write, so the room derives the ends), the photo's own layout with no overlaps (W4's layered
// layout when the photo placed too few), and one undo step.
import { pathUnitProblem } from '@draftroom/canvas-schema/protocol'
import type { CaptureResult } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { fakeFlowCanvas, measure, testId } from '../../flow/test-canvas.ts'
import { applyDiagram, planDiagram } from '../diagram/apply.ts'
import { NODE_GAP } from '../diagram/layered-layout.ts'
import { directionOf, graphOfCapture, measureCaptureDiagram, photoPlaced } from './diagram.ts'

type Diagram = Extract<CaptureResult, { kind: 'diagram' }>
const box = (x: number, y: number, w = 0.14, h = 0.12) => ({ x, y, w, h })

/** The canned whiteboard flow of the e2e kit. */
const FLOW: Diagram = {
  kind: 'diagram',
  nodes: [
    { id: 'n1', label: 'Brief in', shape: 'ellipse', box: box(0.05, 0.4) },
    { id: 'n2', label: 'Sketch ideas', shape: 'rect', box: box(0.25, 0.4) },
    { id: 'n3', label: 'Client happy?', shape: 'diamond', box: box(0.45, 0.38, 0.16, 0.16) },
    { id: 'n4', label: 'Final art', shape: 'rect', box: box(0.68, 0.4) },
    { id: 'n5', label: 'Ship', shape: 'ellipse' },
  ],
  edges: [
    { from: 'n1', to: 'n2', kind: 'arrow' },
    { from: 'n2', to: 'n3', kind: 'arrow' },
    { from: 'n3', to: 'n4', kind: 'arrow', label: 'yes' },
    { from: 'n3', to: 'n2', kind: 'arrow', label: 'no' },
    { from: 'n4', to: 'n5', kind: 'line' },
  ],
}

const m = (t: string, o: { fontFamily: number; fontSize: number }) => measure(t, o)
const plan = (d: Diagram) => {
  const measured = measureCaptureDiagram(d, m)
  if (!measured) throw new Error('no diagram')
  return planDiagram(measured, {
    origin: { x: 0, y: 0 },
    frameId: null,
    provenance: { by: 'usr_me000000001', run: 'air_run' },
    newId: () => testId('d'),
  })
}

describe('the graph', () => {
  it('rect, ellipse and diamond are a process box, a terminal oval and a decision; a line has no arrowhead', () => {
    const g = graphOfCapture(FLOW)
    expect(g?.nodes.map((n) => n.kind)).toEqual(['terminal', 'process', 'decision', 'process', 'terminal'])
    expect(g?.edges.map((e) => [e.label, e.open === true])).toEqual([
      ['', false],
      ['', false],
      ['yes', false],
      ['no', false],
      ['', true],
    ])
    expect(directionOf(FLOW)).toBe('right')
    expect(
      graphOfCapture({ kind: 'diagram', nodes: [FLOW.nodes[0] as Diagram['nodes'][0]], edges: [] }),
    ).toBeNull()
  })
})

describe('graph to elements', () => {
  it('3 shapes with their labels and labelled edges: native shapes, bound elbows, the provenance on everything', () => {
    const p = plan(FLOW)
    const kinds = p.creates.filter((c) => c.kind !== 'text' && c.kind !== 'arrow').map((c) => c.kind)
    expect(kinds).toEqual(['ellipse', 'rectangle', 'diamond', 'rectangle', 'ellipse'])
    const labels = p.creates.filter((c) => c.kind === 'text').map((c) => c.props.originalText)
    expect(labels).toEqual(['Brief in', 'Sketch ideas', 'Client happy?', 'Final art', 'Ship'])
    const arrows = p.creates.filter((c) => c.kind === 'arrow')
    expect(arrows).toHaveLength(5)
    for (const a of arrows) {
      expect(a.props.elbowed).toBe(true)
      expect(
        pathUnitProblem(
          { ...a.props, fixedSegments: [], startIsSpecial: false, endIsSpecial: false },
          'arrow',
        ),
      ).toBeNull()
    }
    // the plain line has no arrowhead
    expect(arrows.map((a) => a.props.endArrowhead)).toEqual(['arrow', 'arrow', 'arrow', 'arrow', null])
    expect(p.edgeLabels.map((l) => l.create.props.text)).toEqual(['yes', 'no'])
    // both ends of every connector are bound (the joined write): the room derives the ends
    expect(p.binds).toHaveLength(5)
    for (const c of [...p.creates, ...p.edgeLabels.map((l) => l.create)])
      expect((c.props.customData as { lobby: { ai: unknown } }).lobby.ai).toEqual({
        by: 'usr_me000000001',
        run: 'air_run',
      })
  })

  it('the photo’s layout: left to right as drawn, the unplaced node after its neighbour, no two closer than NODE_GAP', () => {
    expect(photoPlaced(FLOW)).toBe(true)
    const measured = measureCaptureDiagram(FLOW, m)
    const boxes = measured?.layout.boxes ?? []
    expect(boxes).toHaveLength(5)
    const [b1, b2, b3, b4, b5] = boxes as [
      (typeof boxes)[0],
      (typeof boxes)[0],
      (typeof boxes)[0],
      (typeof boxes)[0],
      (typeof boxes)[0],
    ]
    expect(b1.x).toBeLessThan(b2.x)
    expect(b2.x).toBeLessThan(b3.x)
    expect(b3.x).toBeLessThan(b4.x)
    expect(b5.x).toBeGreaterThan(b4.x)
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as (typeof boxes)[0]
        const b = boxes[j] as (typeof boxes)[0]
        const apart =
          a.x + a.w + NODE_GAP <= b.x ||
          b.x + b.w + NODE_GAP <= a.x ||
          a.y + a.h + NODE_GAP <= b.y ||
          b.y + b.h + NODE_GAP <= a.y
        expect(apart, `${a.id} and ${b.id}`).toBe(true)
      }
    // crowded boxes on top of each other are pushed apart too
    const crowded: Diagram = {
      kind: 'diagram',
      nodes: Array.from({ length: 6 }, (_, i) => ({
        id: `n${i + 1}`,
        label: `Step ${i}`,
        shape: 'rect' as const,
        box: box(0.3, 0.3),
      })),
      edges: [],
    }
    const cb = measureCaptureDiagram(crowded, m)?.layout.boxes ?? []
    for (let i = 0; i < cb.length; i++)
      for (let j = i + 1; j < cb.length; j++) {
        const a = cb[i] as (typeof cb)[0]
        const b = cb[j] as (typeof cb)[0]
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
  })

  it('too few placed nodes: W4’s layered layout instead', () => {
    const loose: Diagram = {
      ...FLOW,
      nodes: FLOW.nodes.map((n, i) => (i < 2 ? n : { id: n.id, label: n.label, shape: n.shape })),
    }
    expect(photoPlaced(loose)).toBe(false)
    const layout = measureCaptureDiagram(loose, m)?.layout
    expect((layout?.layers.length ?? 0) > 1).toBe(true)
  })

  it('applies as one undo step: the shapes and connectors in one transact, the binds joined to it', () => {
    const f = fakeFlowCanvas()
    const before = f.snapshot()
    applyDiagram(f.canvas, plan(FLOW), 'ai: capture diagram')
    expect(f.transacts.map((t) => [t.label, t.joined])).toEqual([
      ['ai: capture diagram', false],
      ['ai: capture diagram', true],
    ])
    expect(f.binds).toHaveLength(10)
    expect(f.steps()).toBe(1)
    f.undo()
    expect(f.snapshot()).toBe(before)
  })
})
