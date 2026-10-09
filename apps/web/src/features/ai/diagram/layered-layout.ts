// OWNER: W4 (wave L, L4-2). A layered ("Sugiyama-style") layout of a diagram graph: pure and deterministic,
// so the same graph always lands the same way on every tab and in every test.
//
//  1. Cycles are broken by reversing the back edges a depth-first search finds (nodes in input order, each
//     node's edges in input order), so the rest works on a DAG. The edge is still drawn from its real
//     source to its real target: only the layering treats it as reversed.
//  2. Layers: the longest path from a source (a node with no incoming edge is in layer 0), so every edge of
//     the DAG goes from a lower layer to a strictly higher one.
//  3. Order inside a layer: input order, then two barycentric sweeps (down, by the mean place of each node's
//     predecessors; then up, by its successors), ties kept in their previous order.
//  4. Coordinates: each layer is a row (direction 'down') or a column ('right'), its nodes packed with
//     NODE_GAP between them and centred on the widest layer; layers LAYER_GAP apart, more when an edge label
//     needs the room. Boxes never overlap.
//
// Box sizes come from the caller (`size`), which measures each label with canvas.text.measure.
import type { DiagramDirection, DiagramEdge, DiagramGraph, DiagramNode } from './graph.ts'

/** Space between two nodes of one layer, scene px. */
export const NODE_GAP = 60
/**
 * Least space between two layers, scene px (an edge label between them makes it larger): more than twice the room's
 * elbow router padding (40 px clear of each bound shape), so a connector between layers has a straight middle.
 */
export const LAYER_GAP = 100

export interface Size {
  readonly w: number
  readonly h: number
}

export interface NodeBox {
  readonly id: string
  /** top-left, relative to the diagram's own top-left (0, 0) */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly layer: number
  /** place inside its layer, from 0 */
  readonly order: number
}

export interface DiagramLayout {
  readonly direction: DiagramDirection
  /** one per node, in the graph's node order */
  readonly boxes: readonly NodeBox[]
  /** node ids per layer, in order */
  readonly layers: readonly (readonly string[])[]
  /** indexes (into graph.edges) of the edges the cycle breaking reversed */
  readonly reversed: ReadonlySet<number>
  readonly width: number
  readonly height: number
}

export interface LayoutOptions {
  /** each node's box (its label measured, padded for its shape) */
  readonly size: (node: DiagramNode) => Size
  /** each labelled edge's label size, so the layers leave it room (default: no room needed) */
  readonly labelSize?: (edge: DiagramEdge) => Size
}

/** Back edges of a DFS over the graph (indexes into `graph.edges`): reversing them leaves a DAG. */
export function backEdges(graph: DiagramGraph): Set<number> {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]))
  const out: { to: number; edge: number }[][] = graph.nodes.map(() => [])
  graph.edges.forEach((e, i) => {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) return
    out[a]?.push({ to: b, edge: i })
  })
  const state = new Uint8Array(graph.nodes.length) // 0 new, 1 on the stack, 2 done
  const back = new Set<number>()
  for (let root = 0; root < graph.nodes.length; root++) {
    if (state[root] !== 0) continue
    // an explicit stack: [node, next edge to look at]
    const stack: [number, number][] = [[root, 0]]
    state[root] = 1
    while (stack.length) {
      const top = stack[stack.length - 1] as [number, number]
      const [v, k] = top
      const edges = out[v] as { to: number; edge: number }[]
      if (k >= edges.length) {
        state[v] = 2
        stack.pop()
        continue
      }
      top[1] = k + 1
      const { to, edge } = edges[k] as { to: number; edge: number }
      if (state[to] === 1) back.add(edge)
      else if (state[to] === 0) {
        state[to] = 1
        stack.push([to, 0])
      }
    }
  }
  return back
}

/** The layered layout of `graph` (see the header). */
export function layeredLayout(graph: DiagramGraph, opts: LayoutOptions): DiagramLayout {
  const n = graph.nodes.length
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]))
  const reversed = backEdges(graph)

  // the DAG: each edge as the layering sees it (a reversed back edge runs the other way)
  const preds: number[][] = graph.nodes.map(() => [])
  const succs: number[][] = graph.nodes.map(() => [])
  graph.edges.forEach((e, i) => {
    let a = index.get(e.from)
    let b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) return
    if (reversed.has(i)) [a, b] = [b, a]
    succs[a]?.push(b)
    preds[b]?.push(a)
  })

  // 2. longest-path layers, in a topological order that takes ready nodes in input order
  const layer = new Array<number>(n).fill(0)
  const indegree = preds.map((p) => p.length)
  const ready: number[] = []
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i)
  let done = 0
  while (ready.length) {
    ready.sort((a, b) => a - b)
    const v = ready.shift() as number
    done++
    for (const w of succs[v] as number[]) {
      layer[w] = Math.max(layer[w] as number, (layer[v] as number) + 1)
      indegree[w] = (indegree[w] as number) - 1
      if (indegree[w] === 0) ready.push(w)
    }
  }
  // (a DAG always finishes; a defect elsewhere must not hang the page)
  if (done < n) for (let i = 0; i < n; i++) if ((indegree[i] as number) > 0) layer[i] = 0

  const count = n ? Math.max(...layer) + 1 : 0
  const layers: number[][] = Array.from({ length: count }, () => [])
  for (let i = 0; i < n; i++) layers[layer[i] as number]?.push(i)

  // 3. two barycentric sweeps
  const pos = new Array<number>(n).fill(0)
  const place = (row: number[]) => {
    row.forEach((v, i) => {
      pos[v] = i
    })
  }
  for (const row of layers) place(row)
  const sweep = (row: number[], by: number[][]) => {
    const bary = new Map<number, number>()
    for (const v of row) {
      const ns = by[v] as number[]
      bary.set(v, ns.length ? ns.reduce((s, u) => s + (pos[u] as number), 0) / ns.length : (pos[v] as number))
    }
    row.sort(
      (a, b) => (bary.get(a) as number) - (bary.get(b) as number) || (pos[a] as number) - (pos[b] as number),
    )
    place(row)
  }
  for (let l = 1; l < count; l++) sweep(layers[l] as number[], preds)
  for (let l = count - 2; l >= 0; l--) sweep(layers[l] as number[], succs)

  // 4. coordinates
  const sizes = graph.nodes.map((node) => {
    const s = opts.size(node)
    return { w: Math.max(1, s.w), h: Math.max(1, s.h) }
  })
  const down = graph.direction !== 'right'
  let labelRoom = 0
  if (opts.labelSize)
    for (const e of graph.edges) {
      if (!e.label) continue
      const s = opts.labelSize(e)
      labelRoom = Math.max(labelRoom, down ? s.h : s.w)
    }
  const gap = Math.max(LAYER_GAP, labelRoom + 40)
  // along: the axis the layers follow one another on; across: the axis a layer's nodes are packed on
  const alongOf = (i: number) => (down ? (sizes[i] as Size).h : (sizes[i] as Size).w)
  const acrossOf = (i: number) => (down ? (sizes[i] as Size).w : (sizes[i] as Size).h)
  const depth = layers.map((row) => Math.max(0, ...row.map(alongOf)))
  const span = layers.map(
    (row) => row.reduce((s, v) => s + acrossOf(v), 0) + NODE_GAP * Math.max(0, row.length - 1),
  )
  const widest = Math.max(0, ...span)
  const boxes: NodeBox[] = new Array(n)
  let along = 0
  layers.forEach((row, l) => {
    let across = (widest - (span[l] as number)) / 2
    for (const v of row) {
      const a = along + ((depth[l] as number) - alongOf(v)) / 2
      const s = sizes[v] as Size
      boxes[v] = {
        id: (graph.nodes[v] as DiagramNode).id,
        x: down ? across : a,
        y: down ? a : across,
        w: s.w,
        h: s.h,
        layer: l,
        order: pos[v] as number,
      }
      across += acrossOf(v) + NODE_GAP
    }
    along += (depth[l] as number) + gap
  })
  const total = Math.max(0, along - gap)
  return {
    direction: down ? 'down' : 'right',
    boxes,
    layers: layers.map((row) => row.map((v) => (graph.nodes[v] as DiagramNode).id)),
    reversed,
    width: down ? widest : total,
    height: down ? total : widest,
  }
}
