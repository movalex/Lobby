// OWNER: W4 (wave L, L4-2 and L4-3). A diagram graph laid out (./layered-layout.ts) and written as native
// elements in ONE undo step, the L4-1 pattern at scale (features/flow/build.ts):
//
//  - transact 1 creates every node's shape with its bound label (process: a rounded rectangle; decision: a
//    diamond; terminal: an ellipse; io: a rectangle in the io style) and every connector, each connector's whole
//    path unit in its creation props (features/flow/connector.ts);
//  - transact 2 joins it (`joinPrevious`): both ends of every connector bound with LobbyTx.bind, and the edge
//    labels made as texts bound to their connectors.
// The room routes every bound elbow and lays out every connector label in the commit of the binds; the client
// never pushes an endpoint. At most DIAGRAM_MAX_NODES * 2 + DIAGRAM_MAX_EDGES * 2 = 200 elements.
//
// The AI path (./DiagramPrompt.tsx) stamps every element with its provenance (aiCustomData: the person and the
// run); the Mermaid paste (features/flow/MermaidPaste.tsx) makes the same diagram without it.
import type { ItemKind, LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Box, connectorProps, elbowGeometry, sidesFor } from '../../flow/connector.ts'
import { aiCustomData } from '../ported/public.ts'
import type { DiagramGraph, DiagramKind, DiagramNode } from './graph.ts'
import { type DiagramLayout, layeredLayout, type Size } from './layered-layout.ts'

export const NODE_FONT_FAMILY = 6
export const NODE_FONT_SIZE = 20
export const EDGE_FONT_SIZE = 16
const INK = '#1e1e1e'
/** Excalidraw's padding around a bound label (BOUND_TEXT_PADDING). */
const TEXT_PAD = 5

interface KindStyle {
  readonly type: 'rectangle' | 'diamond' | 'ellipse'
  readonly backgroundColor: string
  readonly strokeStyle: 'solid' | 'dashed'
  readonly roundness: { type: number } | null
  /** the widest a line of its label may be, scene px */
  readonly wrapAt: number
}

/** How each kind of node looks (Excalidraw's own light palette, so the dark-mode filter treats it as any shape). */
export const KIND_STYLE: Readonly<Record<DiagramKind, KindStyle>> = {
  process: {
    type: 'rectangle',
    backgroundColor: '#a5d8ff',
    strokeStyle: 'solid',
    roundness: { type: 3 },
    wrapAt: 200,
  },
  decision: {
    type: 'diamond',
    backgroundColor: '#ffec99',
    strokeStyle: 'solid',
    roundness: null,
    wrapAt: 140,
  },
  terminal: {
    type: 'ellipse',
    backgroundColor: '#b2f2bb',
    strokeStyle: 'solid',
    roundness: null,
    wrapAt: 170,
  },
  io: { type: 'rectangle', backgroundColor: '#d0bfff', strokeStyle: 'dashed', roundness: null, wrapAt: 200 },
}

export type Measure = (
  text: string,
  style: { fontFamily: number; fontSize: number },
) => {
  readonly width: number
  readonly height: number
}

/** `text` wrapped greedily at `maxWidth` (by words; a word longer than a line is cut), lines joined by '\n'. */
export function wrapLabel(
  text: string,
  maxWidth: number,
  measure: Measure,
  fontSize = NODE_FONT_SIZE,
): string {
  const style = { fontFamily: NODE_FONT_FAMILY, fontSize }
  const fits = (s: string) => measure(s, style).width <= maxWidth
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ').filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (fits(next)) {
        line = next
        continue
      }
      if (line) out.push(line)
      // a word wider than a line is cut into pieces that fit
      let rest = word
      while (!fits(rest) && [...rest].length > 1) {
        const chars = [...rest]
        let n = chars.length - 1
        while (n > 1 && !fits(chars.slice(0, n).join(''))) n--
        out.push(chars.slice(0, n).join(''))
        rest = chars.slice(n).join('')
      }
      line = rest
    }
    out.push(line)
  }
  return out.join('\n')
}

/** A node's box for its label's measured size (Excalidraw's bound-text area of each shape, plus a margin). */
export function nodeSize(kind: DiagramKind, text: { width: number; height: number }): Size {
  const tw = text.width + 2 * TEXT_PAD
  const th = text.height + 2 * TEXT_PAD
  switch (KIND_STYLE[kind].type) {
    case 'diamond':
      return { w: Math.max(180, Math.ceil(2 * tw + 24)), h: Math.max(110, Math.ceil(2 * th + 20)) }
    case 'ellipse':
      return {
        w: Math.max(160, Math.ceil(tw * Math.SQRT2 + 24)),
        h: Math.max(80, Math.ceil(th * Math.SQRT2 + 16)),
      }
    default:
      return { w: Math.max(160, Math.ceil(tw + 36)), h: Math.max(70, Math.ceil(th + 26)) }
  }
}

export interface MeasuredDiagram {
  readonly graph: DiagramGraph
  readonly layout: DiagramLayout
  /** each node's label as it is drawn (wrapped) */
  readonly wrapped: ReadonlyMap<string, string>
}

/** Measures every label and lays the graph out. */
export function measureDiagram(graph: DiagramGraph, measure: Measure): MeasuredDiagram {
  const wrapped = new Map<string, string>()
  for (const n of graph.nodes) wrapped.set(n.id, wrapLabel(n.label, KIND_STYLE[n.kind].wrapAt, measure))
  const textSize = (n: DiagramNode) =>
    measure(wrapped.get(n.id) ?? n.label, { fontFamily: NODE_FONT_FAMILY, fontSize: NODE_FONT_SIZE })
  const layout = layeredLayout(graph, {
    size: (n) => nodeSize(n.kind, textSize(n)),
    labelSize: (e) => {
      const m = measure(e.label, { fontFamily: NODE_FONT_FAMILY, fontSize: EDGE_FONT_SIZE })
      return { w: m.width + 2 * TEXT_PAD, h: m.height + 2 * TEXT_PAD }
    },
  })
  return { graph, layout, wrapped }
}

export interface DiagramPlanOptions {
  /** the diagram's top-left on the board */
  readonly origin: { readonly x: number; readonly y: number }
  /** the frame every element goes in, or null */
  readonly frameId: string | null
  /** the AI path's provenance (aiCustomData), or null for none (the Mermaid paste) */
  readonly provenance: { readonly by: string; readonly run: string | null } | null
  readonly newId: () => string
}

type Create = { readonly kind: ItemKind; readonly props: Readonly<Record<string, unknown>> }

export interface DiagramPlan {
  /** transact 1, in order: each node's shape then its label, then the connectors */
  readonly creates: readonly Create[]
  /** transact 2: each connector's two binds */
  readonly binds: readonly { readonly arrowId: string; readonly from: string; readonly to: string }[]
  /** transact 2: the edge labels and the connector each is bound to */
  readonly edgeLabels: readonly { readonly arrowId: string; readonly create: Create }[]
  /** node id → shape id */
  readonly shapeOf: ReadonlyMap<string, string>
  readonly shapeIds: readonly string[]
  readonly arrowIds: readonly string[]
  /** the diagram's bounds on the board */
  readonly bounds: Box
}

/** The elements of a measured diagram at `opts.origin` (see the header). Pure. */
export function planDiagram(d: MeasuredDiagram, opts: DiagramPlanOptions): DiagramPlan {
  const { graph, layout } = d
  const stamp = (kind: string) =>
    opts.provenance ? { customData: aiCustomData(opts.provenance.by, kind, opts.provenance.run) } : {}
  const frameId = opts.frameId
  const creates: Create[] = []
  const shapeOf = new Map<string, string>()
  const boxOf = new Map<string, Box>()
  graph.nodes.forEach((node, i) => {
    const lb = layout.boxes[i]
    if (!lb) return
    const box: Box = { x: opts.origin.x + lb.x, y: opts.origin.y + lb.y, w: lb.w, h: lb.h }
    const style = KIND_STYLE[node.kind]
    const id = opts.newId()
    const labelId = opts.newId()
    shapeOf.set(node.id, id)
    boxOf.set(node.id, box)
    creates.push({
      kind: style.type,
      props: {
        id,
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        angle: 0,
        strokeColor: INK,
        backgroundColor: style.backgroundColor,
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: style.strokeStyle,
        roughness: 0,
        opacity: 100,
        roundness: style.roundness,
        frameId,
        boundElements: [{ id: labelId, type: 'text' }],
        ...stamp('diagram-node'),
      },
    })
    const text = d.wrapped.get(node.id) ?? node.label
    creates.push({
      kind: 'text',
      props: {
        id: labelId,
        // newTextElement places a centred label by its centre and measures it itself
        x: box.x + box.w / 2,
        y: box.y + box.h / 2,
        text,
        originalText: node.label,
        fontFamily: NODE_FONT_FAMILY,
        fontSize: NODE_FONT_SIZE,
        textAlign: 'center',
        verticalAlign: 'middle',
        strokeColor: INK,
        containerId: id,
        frameId,
        autoResize: true,
        ...stamp('diagram-label'),
      },
    })
  })
  const binds: { arrowId: string; from: string; to: string }[] = []
  const edgeLabels: { arrowId: string; create: Create }[] = []
  const arrowIds: string[] = []
  for (const e of graph.edges) {
    const from = shapeOf.get(e.from)
    const to = shapeOf.get(e.to)
    const a = boxOf.get(e.from)
    const b = boxOf.get(e.to)
    if (!from || !to || !a || !b) continue
    const sides = sidesFor(a, b, layout.direction)
    const geometry = elbowGeometry(a, sides.from, b, sides.to)
    const arrowId = opts.newId()
    arrowIds.push(arrowId)
    creates.push({
      kind: 'arrow',
      props: connectorProps(arrowId, geometry, {
        strokeStyle: e.dashed ? 'dashed' : 'solid',
        endArrowhead: e.open ? null : 'arrow',
        frameId,
        ...stamp('diagram-edge'),
      }),
    })
    binds.push({ arrowId, from, to })
    if (e.label) {
      const mid = geometry.points[Math.floor(geometry.points.length / 2)] ?? [0, 0]
      edgeLabels.push({
        arrowId,
        create: {
          kind: 'text',
          props: {
            id: opts.newId(),
            x: geometry.x + mid[0],
            y: geometry.y + mid[1],
            text: e.label,
            originalText: e.label,
            fontFamily: NODE_FONT_FAMILY,
            fontSize: EDGE_FONT_SIZE,
            textAlign: 'center',
            verticalAlign: 'middle',
            strokeColor: INK,
            containerId: arrowId,
            frameId,
            autoResize: true,
            ...stamp('diagram-label'),
          },
        },
      })
    }
  }
  return {
    creates,
    binds,
    edgeLabels,
    shapeOf,
    shapeIds: [...shapeOf.values()],
    arrowIds,
    bounds: { x: opts.origin.x, y: opts.origin.y, w: layout.width, h: layout.height },
  }
}

export const DIAGRAM_UNDO_LABEL = 'diagram: add'

/** Writes a plan as one undo step (see the header); selects the shapes; returns every id it made. */
export function applyDiagram(
  canvas: Pick<LobbyCanvas, 'transact' | 'select'>,
  plan: DiagramPlan,
  label = DIAGRAM_UNDO_LABEL,
): string[] {
  const made: string[] = []
  canvas.transact(label, (tx) => {
    for (const c of plan.creates) made.push(tx.create(c.kind, c.props))
  })
  canvas.transact(
    label,
    (tx) => {
      for (const b of plan.binds) {
        tx.bind(b.arrowId, 'start', b.from)
        tx.bind(b.arrowId, 'end', b.to)
      }
      for (const l of plan.edgeLabels) {
        made.push(tx.create(l.create.kind, l.create.props))
        tx.update(l.arrowId, { boundElements: [{ id: String(l.create.props.id), type: 'text' }] })
      }
    },
    { joinPrevious: true },
  )
  canvas.select(plan.shapeIds)
  return made
}

/** How many elements a plan makes (shapes, their labels, connectors and edge labels). */
export const planSize = (plan: DiagramPlan) => plan.creates.length + plan.edgeLabels.length
