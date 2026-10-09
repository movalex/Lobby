// L4-2: the layered layout (./layered-layout.ts) over 300 random graphs with cycles: no two boxes overlap,
// every edge runs between non-decreasing layers once the back edges are reversed (strictly increasing, in
// fact), and the output is deterministic. Plus the named rules: the cycle breaking, the longest-path layers,
// the barycentric order and the label room.
import { describe, expect, it } from 'vitest'
import type { DiagramGraph, DiagramKind } from './graph.ts'
import { backEdges, LAYER_GAP, layeredLayout, NODE_GAP } from './layered-layout.ts'

/** A seeded PRNG (mulberry32): the same 300 graphs on every run. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KINDS: DiagramKind[] = ['process', 'decision', 'terminal', 'io']

function randomGraph(seed: number): DiagramGraph {
  const r = rng(seed)
  const n = 2 + Math.floor(r() * 39)
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i + 1}`,
    label: 'x'.repeat(1 + Math.floor(r() * 50)),
    kind: KINDS[Math.floor(r() * 4)] as DiagramKind,
  }))
  const m = Math.floor(r() * 61)
  const edges: { from: string; to: string; label: string }[] = []
  const seen = new Set<string>()
  for (let i = 0; i < m * 3 && edges.length < m; i++) {
    const a = Math.floor(r() * n)
    const b = Math.floor(r() * n)
    if (a === b || seen.has(`${a}>${b}`)) continue
    seen.add(`${a}>${b}`)
    edges.push({ from: `n${a + 1}`, to: `n${b + 1}`, label: r() < 0.3 ? 'yes' : '' })
  }
  // at least one cycle in most graphs: close a loop back to the first node
  if (n > 2 && r() < 0.8 && !seen.has(`${n - 1}>0`)) edges.push({ from: `n${n}`, to: 'n1', label: '' })
  return { direction: r() < 0.5 ? 'down' : 'right', nodes, edges: edges.slice(0, 60) }
}

/** Box sizes from the label length (a stand-in for canvas.text.measure), different per kind. */
const size = (node: { label: string; kind: DiagramKind }) => {
  const w = Math.min(260, 120 + node.label.length * 4)
  return node.kind === 'decision' ? { w: w + 40, h: 110 } : { w, h: 60 + (node.label.length > 25 ? 24 : 0) }
}
const labelSize = (e: { label: string }) => ({ w: e.label.length * 9, h: 22 })

const overlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('layeredLayout over 300 random graphs with cycles', () => {
  const graphs = Array.from({ length: 300 }, (_, i) => randomGraph(1000 + i))

  it('the graphs have cycles (the test is about them)', () => {
    const withCycles = graphs.filter((g) => backEdges(g).size > 0).length
    expect(withCycles).toBeGreaterThan(200)
  })

  it('no two node boxes overlap, and every box is inside the layout', () => {
    for (const g of graphs) {
      const out = layeredLayout(g, { size, labelSize })
      expect(out.boxes).toHaveLength(g.nodes.length)
      for (let i = 0; i < out.boxes.length; i++) {
        const a = out.boxes[i] as (typeof out.boxes)[number]
        expect(a.x).toBeGreaterThanOrEqual(-1e-6)
        expect(a.y).toBeGreaterThanOrEqual(-1e-6)
        expect(a.x + a.w).toBeLessThanOrEqual(out.width + 1e-6)
        expect(a.y + a.h).toBeLessThanOrEqual(out.height + 1e-6)
        for (let j = i + 1; j < out.boxes.length; j++)
          expect(overlap(a, out.boxes[j] as typeof a), `${a.id} and ${out.boxes[j]?.id}`).toBe(false)
      }
    }
  })

  it('after the cycle breaking, every edge runs from a lower layer to a higher one', () => {
    for (const g of graphs) {
      const out = layeredLayout(g, { size, labelSize })
      const layer = new Map(out.boxes.map((b) => [b.id, b.layer]))
      g.edges.forEach((e, i) => {
        const [a, b] = out.reversed.has(i) ? [e.to, e.from] : [e.from, e.to]
        expect(layer.get(b) as number).toBeGreaterThanOrEqual(layer.get(a) as number)
        expect(layer.get(b) as number).toBeGreaterThan(layer.get(a) as number)
      })
    }
  })

  it('layers follow one another along the direction, at least LAYER_GAP apart', () => {
    for (const g of graphs) {
      const out = layeredLayout(g, { size, labelSize })
      const down = g.direction === 'down'
      for (const a of out.boxes)
        for (const b of out.boxes) {
          if (b.layer !== a.layer + 1) continue
          if (down) expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + LAYER_GAP - 1e-6)
          else expect(b.x).toBeGreaterThanOrEqual(a.x + a.w + LAYER_GAP - 1e-6)
        }
    }
  })

  it('is deterministic: the same graph gives the same layout, every time', () => {
    for (const g of graphs.slice(0, 100)) {
      const a = JSON.stringify(layeredLayout(g, { size, labelSize }), (_k, v) =>
        v instanceof Set ? [...v] : v,
      )
      const b = JSON.stringify(layeredLayout(structuredClone(g), { size, labelSize }), (_k, v) =>
        v instanceof Set ? [...v] : v,
      )
      expect(a).toBe(b)
    }
  })
})

describe('layeredLayout: the rules', () => {
  const node = (id: string, kind: DiagramKind = 'process') => ({ id, label: id, kind })
  const fixed = () => ({ w: 100, h: 50 })

  it('a back edge found by the DFS is reversed, and only that one', () => {
    const g: DiagramGraph = {
      direction: 'down',
      nodes: ['a', 'b', 'c'].map((id) => node(id)),
      edges: [
        { from: 'a', to: 'b', label: '' },
        { from: 'b', to: 'c', label: '' },
        { from: 'c', to: 'a', label: 'again' },
      ],
    }
    expect([...backEdges(g)]).toEqual([2])
    const out = layeredLayout(g, { size: fixed })
    expect(out.layers).toEqual([['a'], ['b'], ['c']])
  })

  it('layers are longest paths from a source (a shortcut edge does not pull a node up)', () => {
    const g: DiagramGraph = {
      direction: 'down',
      nodes: ['a', 'b', 'c', 'd'].map((id) => node(id)),
      edges: [
        { from: 'a', to: 'b', label: '' },
        { from: 'b', to: 'c', label: '' },
        { from: 'a', to: 'c', label: '' },
        { from: 'c', to: 'd', label: '' },
      ],
    }
    expect(layeredLayout(g, { size: fixed }).layers).toEqual([['a'], ['b'], ['c'], ['d']])
  })

  it('the barycentric sweep puts children under their parents (no needless crossing)', () => {
    // a and b in layer 0; c is a's child and d is b's, but they come in the other order
    const g: DiagramGraph = {
      direction: 'down',
      nodes: ['a', 'b', 'd', 'c'].map((id) => node(id)),
      edges: [
        { from: 'a', to: 'c', label: '' },
        { from: 'b', to: 'd', label: '' },
      ],
    }
    const out = layeredLayout(g, { size: fixed })
    expect(out.layers).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    const box = new Map(out.boxes.map((b) => [b.id, b]))
    expect((box.get('c')?.x ?? 0) < (box.get('d')?.x ?? 0)).toBe(true)
  })

  it('packs a layer with NODE_GAP and centres it on the widest; right turns rows into columns', () => {
    const g: DiagramGraph = {
      direction: 'down',
      nodes: ['a', 'b', 'c'].map((id) => node(id)),
      edges: [
        { from: 'a', to: 'b', label: '' },
        { from: 'a', to: 'c', label: '' },
      ],
    }
    const down = layeredLayout(g, { size: fixed })
    const at = new Map(down.boxes.map((b) => [b.id, b]))
    expect(down.width).toBe(200 + NODE_GAP)
    expect(at.get('a')).toMatchObject({ x: (200 + NODE_GAP - 100) / 2, y: 0 })
    expect(at.get('b')).toMatchObject({ x: 0, y: 50 + LAYER_GAP })
    expect(at.get('c')).toMatchObject({ x: 100 + NODE_GAP, y: 50 + LAYER_GAP })
    const right = layeredLayout({ ...g, direction: 'right' }, { size: fixed })
    const rat = new Map(right.boxes.map((b) => [b.id, b]))
    expect(rat.get('b')).toMatchObject({ x: 100 + LAYER_GAP, y: 0 })
    expect(rat.get('c')).toMatchObject({ x: 100 + LAYER_GAP, y: 50 + NODE_GAP })
    expect(right.direction).toBe('right')
  })

  it('an edge label makes room between the layers', () => {
    const g: DiagramGraph = {
      direction: 'right',
      nodes: ['a', 'b'].map((id) => node(id)),
      edges: [{ from: 'a', to: 'b', label: 'a long edge label' }],
    }
    const out = layeredLayout(g, { size: fixed, labelSize: () => ({ w: 180, h: 20 }) })
    const b = out.boxes.find((x) => x.id === 'b')
    expect(b?.x).toBe(100 + 180 + 40)
  })

  it('an empty graph is an empty layout', () => {
    expect(layeredLayout({ direction: 'down', nodes: [], edges: [] }, { size: fixed })).toMatchObject({
      boxes: [],
      layers: [],
      width: 0,
      height: 0,
    })
  })
})
