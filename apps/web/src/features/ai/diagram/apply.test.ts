// L4-2 / L4-3: a diagram written as native elements in one undo step (./apply.ts): the shapes with their bound
// labels and the connectors in transact 1, the binds (LobbyTx.bind) and the edge labels in a joinPrevious
// transact 2; one undo removes every shape, connector and label; the AI path stamps provenance, the Mermaid
// path does not; a 40-node, 60-edge graph stays within 200 elements.
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import { pathUnitProblem } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { fakeFlowCanvas, measure, testId } from '../../flow/test-canvas.ts'
import {
  applyDiagram,
  DIAGRAM_UNDO_LABEL,
  measureDiagram,
  nodeSize,
  planDiagram,
  planSize,
  wrapLabel,
} from './apply.ts'
import { type DiagramGraph, normalizeGraph } from './graph.ts'

const m = (text: string, o: { fontFamily: number; fontSize: number }) => measure(text, o)
const newId = () => testId('d')

const FLOW: DiagramGraph = normalizeGraph({
  direction: 'down',
  nodes: [
    { id: 'n1', label: 'Start', kind: 'terminal' },
    { id: 'n2', label: 'Brief', kind: 'process' },
    { id: 'n3', label: 'Client approves?', kind: 'decision' },
    { id: 'n4', label: 'Upload assets', kind: 'io' },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: '' },
    { from: 'n2', to: 'n3', label: '' },
    { from: 'n3', to: 'n2', label: 'no' },
    { from: 'n3', to: 'n4', label: 'yes' },
  ],
})

const plan = (g: DiagramGraph, provenance: { by: string; run: string | null } | null = null) =>
  planDiagram(measureDiagram(g, m), { origin: { x: 100, y: 50 }, frameId: null, provenance, newId })

describe('planDiagram: the elements', () => {
  it('a shape per node by its kind, each with a bound label; a connector per edge; labels for labelled edges', () => {
    const p = plan(FLOW)
    const kinds = p.creates.map((c) => c.kind)
    expect(kinds).toEqual([
      'ellipse',
      'text',
      'rectangle',
      'text',
      'diamond',
      'text',
      'rectangle',
      'text',
      'arrow',
      'arrow',
      'arrow',
      'arrow',
    ])
    expect(p.edgeLabels.map((l) => l.create.props.text)).toEqual(['no', 'yes'])
    const io = p.creates[6]?.props as Record<string, unknown>
    expect(io.strokeStyle).toBe('dashed')
    // each label is its shape's
    for (let i = 0; i < 8; i += 2) {
      const shape = p.creates[i]?.props as Record<string, unknown>
      const label = p.creates[i + 1]?.props as Record<string, unknown>
      expect(label.containerId).toBe(shape.id)
      expect(shape.boundElements).toEqual([{ id: label.id, type: 'text' }])
    }
    expect(planSize(p)).toBe(4 * 2 + 4 + 2)
  })

  it("every connector carries its whole path unit as an elbow, and is bound by the plan's binds", () => {
    const p = plan(FLOW)
    for (const c of p.creates.filter((x) => x.kind === 'arrow')) {
      const a = c.props as Record<string, unknown>
      expect(a.elbowed).toBe(true)
      expect(
        pathUnitProblem({ ...a, fixedSegments: [], startIsSpecial: false, endIsSpecial: false }, 'arrow'),
      ).toBeNull()
      expect(a.startBinding).toBeUndefined()
    }
    expect(p.binds).toHaveLength(4)
    expect(p.binds[2]).toEqual({ arrowId: p.arrowIds[2], from: p.shapeOf.get('n3'), to: p.shapeOf.get('n2') })
  })

  it('the AI path stamps every element with its provenance (valid canvas-schema values); the paste path stamps none', () => {
    const p = plan(FLOW, { by: 'usr_alice', run: 'air_0123456789ABCDEFGHIJ' })
    const all = [...p.creates, ...p.edgeLabels.map((l) => l.create)]
    for (const c of all) {
      const lobby = (c.props.customData as { lobby: Record<string, unknown> }).lobby
      expect(lobby.ai).toEqual({ by: 'usr_alice', run: 'air_0123456789ABCDEFGHIJ' })
      expect(String(lobby.kind)).toMatch(/^ai-diagram-(node|edge|label)$/)
      expect(lobbyKeySpec('kind')?.value.safeParse(lobby.kind).success).toBe(true)
    }
    for (const c of [...plan(FLOW).creates, ...plan(FLOW).edgeLabels.map((l) => l.create)])
      expect(c.props.customData).toBeUndefined()
  })

  it('a 40-node, 60-edge graph is at most 200 elements', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i + 1}`,
      label: `Step ${i + 1}`,
      kind: 'process',
    }))
    const edges = Array.from({ length: 60 }, (_, i) => ({
      from: `n${(i % 40) + 1}`,
      to: `n${((i * 7 + 3) % 40) + 1}`,
      label: 'go',
    }))
    const g = normalizeGraph({ direction: 'right', nodes, edges })
    const p = plan(g)
    expect(planSize(p)).toBeLessThanOrEqual(200)
  })

  it('labels wrap to their shape, and a shape is big enough for its wrapped label', () => {
    expect(wrapLabel('Internal review before the client sees it', 200, m)).toBe(
      'Internal review\nbefore the client\nsees it',
    )
    expect(
      wrapLabel('Supercalifragilisticexpialidocious', 100, m)
        .split('\n')
        .every((l) => l.length <= 10),
    ).toBe(true)
    const t = measure('Internal review\nbefore the client\nsees it', { fontSize: 20 })
    const s = nodeSize('process', t)
    expect(s.w).toBeGreaterThanOrEqual(t.width + 10)
    expect(s.h).toBeGreaterThanOrEqual(t.height + 10)
    const d = nodeSize('decision', t)
    expect(d.w / 2 - 10).toBeGreaterThanOrEqual(t.width)
  })
})

describe('applyDiagram: one undo step', () => {
  it('transact 1 creates, transact 2 (joined) binds and adds the edge labels; one undo removes it all', () => {
    const f = fakeFlowCanvas([])
    const before = f.snapshot()
    const p = plan(FLOW)
    const made = applyDiagram(f.canvas, p)
    expect(f.transacts.map((t) => [t.label, t.joined])).toEqual([
      [DIAGRAM_UNDO_LABEL, false],
      [DIAGRAM_UNDO_LABEL, true],
    ])
    expect(f.transacts[0]?.ops.every((o) => o.startsWith('create '))).toBe(true)
    // transact 2 writes no connector geometry: only bindings, bound lists and the labels
    for (const op of f.transacts[1]?.ops ?? [])
      expect(op).toMatch(/^(create text|update \S+ (startBinding|endBinding|boundElements))/)
    expect(made).toHaveLength(planSize(p))
    expect(f.live()).toHaveLength(planSize(p))
    for (const id of p.arrowIds) {
      const a = f.els.get(id) as Record<string, unknown>
      expect((a.startBinding as { elementId: string }).elementId).toBeTruthy()
      expect((a.endBinding as { elementId: string }).elementId).toBeTruthy()
    }
    // an edge label is bound both ways
    const label = p.edgeLabels[0]
    expect(f.els.get(label?.arrowId as string)?.boundElements).toEqual([
      { id: label?.create.props.id, type: 'text' },
    ])
    expect(f.selected).toEqual(p.shapeIds)
    expect(f.steps()).toBe(1)
    expect(f.undo()).toBe(true)
    expect(f.snapshot()).toBe(before)
  })
})
