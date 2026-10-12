// OWNER: WS5 (wave N, N5-3). A diagram from a photo as a real, editable diagram: W4's graph (../diagram/graph.ts,
// normalizeGraph: the one gate both diagram paths take) and W4's writer (../diagram/apply.ts planDiagram and
// applyDiagram: the node shapes with their bound labels, and connectors made through features/flow/connector.ts, whose
// bound ends the room derives in the commit of the binds; no client pushes an endpoint).
//
// Where the nodes go: the photo's own places when it gave most of them (each node centred where its box was, the
// photo scaled so a node is its measured size, nodes it gave no place set after a neighbour, then pushed apart until
// no two are closer than NODE_GAP), else W4's layered layout (../diagram/layered-layout.ts). Shapes: rect a process
// box, ellipse a terminal oval, diamond a decision; an edge of kind 'line' has no arrowhead.

import type { CaptureResult } from '@draftroom/contracts'
import {
  KIND_STYLE,
  type Measure,
  type MeasuredDiagram,
  measureDiagram,
  NODE_FONT_FAMILY,
  NODE_FONT_SIZE,
  nodeSize,
  wrapLabel,
} from '../diagram/apply.ts'
import {
  type DiagramDirection,
  type DiagramGraph,
  type DiagramKind,
  normalizeGraph,
} from '../diagram/graph.ts'
import { type DiagramLayout, NODE_GAP, type NodeBox } from '../diagram/layered-layout.ts'

type DiagramResult = Extract<CaptureResult, { kind: 'diagram' }>

const KIND_OF: Readonly<Record<DiagramResult['nodes'][number]['shape'], DiagramKind>> = {
  rect: 'process',
  ellipse: 'terminal',
  diamond: 'decision',
}

/** Which way the photo's diagram reads: across when its boxes spread wider than tall. */
export function directionOf(result: DiagramResult): DiagramDirection {
  const boxed = result.nodes.flatMap((n) => (n.box ? [n.box] : []))
  if (boxed.length < 2) return 'down'
  const xs = boxed.map((b) => b.x + b.w / 2)
  const ys = boxed.map((b) => b.y + b.h / 2)
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v)
  return spread(xs) >= spread(ys) ? 'right' : 'down'
}

/** The capture's diagram as W4's graph (null with fewer than two nodes: nothing to draw). */
export function graphOfCapture(result: DiagramResult): DiagramGraph | null {
  const g = normalizeGraph({
    direction: directionOf(result),
    nodes: result.nodes.map((n) => ({ id: n.id, label: n.label, kind: KIND_OF[n.shape] ?? 'process' })),
    edges: result.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label ?? '',
      ...(e.kind === 'line' ? { open: true } : {}),
    })),
  })
  return g.nodes.length >= 2 ? g : null
}

/** Whether the photo placed enough nodes to keep its layout (at least two, and half of them). */
export const photoPlaced = (result: DiagramResult): boolean => {
  const n = result.nodes.filter((x) => x.box && x.box.w > 0 && x.box.h > 0).length
  return n >= 2 && n * 2 >= result.nodes.length
}

interface Placed {
  x: number
  y: number
  w: number
  h: number
}
const overlap = (a: Placed, b: Placed, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/**
 * The photo's layout (see the header): one box per node of `graph`, in its order, top-left relative to (0, 0), no two
 * closer than `gap`. `boxes`: each node's box in the photo (by id), `sizes` each node's measured size.
 */
export function photoLayout(
  graph: DiagramGraph,
  boxes: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>,
  sizes: ReadonlyMap<string, { w: number; h: number }>,
  gap = NODE_GAP,
): DiagramLayout {
  const ratios = graph.nodes.flatMap((n) => {
    const b = boxes.get(n.id)
    const s = sizes.get(n.id)
    return b && s && b.w > 0 ? [s.w / b.w] : []
  })
  ratios.sort((a, b) => a - b)
  // the photo scaled so a node is its measured size (bounded: a speck of a box never blows the board up)
  const scale = Math.max(400, Math.min(8000, ratios[Math.floor(ratios.length / 2)] ?? 1200))
  const at = new Map<string, Placed>()
  const order: string[] = []
  for (const n of graph.nodes) {
    const b = boxes.get(n.id)
    const s = sizes.get(n.id) ?? { w: 160, h: 70 }
    if (!b) continue
    at.set(n.id, {
      x: Math.round((b.x + b.w / 2) * scale - s.w / 2),
      y: Math.round((b.y + b.h / 2) * scale - s.h / 2),
      w: s.w,
      h: s.h,
    })
    order.push(n.id)
  }
  // nodes the photo gave no place: after a neighbour already placed, in the way the diagram reads
  const right = graph.direction === 'right'
  for (const n of graph.nodes) {
    if (at.has(n.id)) continue
    const s = sizes.get(n.id) ?? { w: 160, h: 70 }
    const from = graph.edges.find((e) => e.to === n.id && at.has(e.from))?.from
    const to = graph.edges.find((e) => e.from === n.id && at.has(e.to))?.to
    const near = at.get(from ?? to ?? '')
    const all = [...at.values()]
    const far = all.length
      ? {
          x: Math.max(...all.map((p) => p.x + p.w)),
          y: Math.max(...all.map((p) => p.y + p.h)),
        }
      : { x: 0, y: 0 }
    const p: Placed = near
      ? right
        ? { x: near.x + (from ? near.w + gap * 2 : -s.w - gap * 2), y: near.y + (near.h - s.h) / 2, ...s }
        : { x: near.x + (near.w - s.w) / 2, y: near.y + (from ? near.h + gap * 2 : -s.h - gap * 2), ...s }
      : right
        ? { x: far.x + gap * 2, y: 0, ...s }
        : { x: 0, y: far.y + gap * 2, ...s }
    at.set(n.id, p)
    order.push(n.id)
  }
  // pushed apart until no two touch: across the way the diagram reads (a column of a left-to-right diagram grows
  // down, a row of a top-to-bottom one grows right), each node past the ones placed before it
  const settled: Placed[] = []
  for (const id of order) {
    const p = at.get(id) as Placed
    for (let guard = 0; guard < 500; guard++) {
      const hit = settled.find((q) => overlap(p, q, gap))
      if (!hit) break
      if (right) p.y = hit.y + hit.h + gap
      else p.x = hit.x + hit.w + gap
    }
    settled.push(p)
  }
  const x0 = Math.min(...settled.map((p) => p.x))
  const y0 = Math.min(...settled.map((p) => p.y))
  const nodeBoxes: NodeBox[] = graph.nodes.map((n, i) => {
    const p = at.get(n.id) as Placed
    return { id: n.id, x: p.x - x0, y: p.y - y0, w: p.w, h: p.h, layer: 0, order: i }
  })
  return {
    direction: graph.direction,
    boxes: nodeBoxes,
    layers: [graph.nodes.map((n) => n.id)],
    reversed: new Set(),
    width: Math.max(...nodeBoxes.map((b) => b.x + b.w)),
    height: Math.max(...nodeBoxes.map((b) => b.y + b.h)),
  }
}

/** The capture's diagram measured and laid out (see the header), for W4's planDiagram; null when there is none. */
export function measureCaptureDiagram(result: DiagramResult, measure: Measure): MeasuredDiagram | null {
  const graph = graphOfCapture(result)
  if (!graph) return null
  if (!photoPlaced(result)) return measureDiagram(graph, measure)
  const wrapped = new Map<string, string>()
  const sizes = new Map<string, { w: number; h: number }>()
  for (const n of graph.nodes) {
    const text = wrapLabel(n.label, KIND_STYLE[n.kind].wrapAt, measure)
    wrapped.set(n.id, text)
    sizes.set(
      n.id,
      nodeSize(n.kind, measure(text, { fontFamily: NODE_FONT_FAMILY, fontSize: NODE_FONT_SIZE })),
    )
  }
  const boxes = new Map(
    result.nodes.flatMap((n) => (n.box && n.box.w > 0 && n.box.h > 0 ? [[n.id, n.box]] : [])),
  )
  return { graph, layout: photoLayout(graph, boxes, sizes), wrapped }
}
