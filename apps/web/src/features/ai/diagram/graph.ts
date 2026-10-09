// OWNER: W4 (wave L, L4-2 and L4-3). The one graph both diagram paths build: Diagram from words (the api's
// `diagram` result, L4-2) and a pasted Mermaid flowchart (./mermaid-lite.ts, L4-3, no AI). Pure.
//
// A graph is nodes (a label and a kind) and directed edges (with an optional label, dashed for Mermaid's
// `-.->`). `normalizeGraph` is the one gate both paths go through before anything is laid out or written:
// labels are cleaned and capped, edges to unknown nodes, self-loops and repeated edges are dropped, and the
// node and edge caps hold (the api's own caps, so a pasted chart is never bigger than an AI one).
import {
  AI_DIAGRAM_EDGE_LABEL_MAX_CHARS,
  AI_DIAGRAM_LABEL_MAX_CHARS,
  AI_DIAGRAM_MAX_EDGES,
  AI_DIAGRAM_MAX_NODES,
  type AiResult,
} from '@draftroom/contracts'

/** What a node is drawn as: process a rectangle, decision a diamond, terminal an ellipse, io a rectangle in the io style. */
export type DiagramKind = 'process' | 'decision' | 'terminal' | 'io'
export const DIAGRAM_KINDS: readonly DiagramKind[] = ['process', 'decision', 'terminal', 'io']

/** Which way the diagram reads: top to bottom, or left to right. */
export type DiagramDirection = 'down' | 'right'

export interface DiagramNode {
  /** unique within the graph (the api's n1..n40, or a Mermaid id) */
  readonly id: string
  readonly label: string
  readonly kind: DiagramKind
}

export interface DiagramEdge {
  readonly from: string
  readonly to: string
  /** '' for none */
  readonly label: string
  /** Mermaid's dotted link (`-.->`) */
  readonly dashed?: boolean
  /** Mermaid's open link (`---`): drawn without an arrowhead */
  readonly open?: boolean
}

export interface DiagramGraph {
  readonly direction: DiagramDirection
  readonly nodes: readonly DiagramNode[]
  readonly edges: readonly DiagramEdge[]
}

export const DIAGRAM_MAX_NODES = AI_DIAGRAM_MAX_NODES
export const DIAGRAM_MAX_EDGES = AI_DIAGRAM_MAX_EDGES
export const DIAGRAM_LABEL_MAX_CHARS = AI_DIAGRAM_LABEL_MAX_CHARS
export const DIAGRAM_EDGE_LABEL_MAX_CHARS = AI_DIAGRAM_EDGE_LABEL_MAX_CHARS

/** The most lines a label keeps. */
export const DIAGRAM_LABEL_MAX_LINES = 4

/**
 * Control characters other than a line break go; runs of spaces become one; at most `maxLines` lines (the rest
 * go) and `max` characters (an ellipsis ends a label cut for its length).
 */
export function cleanLabel(raw: string, max: number, maxLines = DIAGRAM_LABEL_MAX_LINES): string {
  const lines = String(raw)
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxLines)
  const text = lines.join('\n')
  const chars = [...text]
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

const isKind = (k: unknown): k is DiagramKind => DIAGRAM_KINDS.includes(k as DiagramKind)

/**
 * The graph as it may be drawn: node ids unique (the first of a repeated id wins), labels cleaned (a node
 * with no label is named by its id), at most DIAGRAM_MAX_NODES nodes (the first ones), edges only between
 * kept nodes, no self-loops, no repeated from→to pair (the first wins), at most DIAGRAM_MAX_EDGES edges.
 */
export function normalizeGraph(g: {
  direction: DiagramDirection
  nodes: readonly { id: string; label: string; kind: string }[]
  edges: readonly { from: string; to: string; label?: string; dashed?: boolean; open?: boolean }[]
}): DiagramGraph {
  const nodes: DiagramNode[] = []
  const seen = new Set<string>()
  for (const n of g.nodes) {
    if (nodes.length >= DIAGRAM_MAX_NODES) break
    const id = String(n.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = cleanLabel(n.label, DIAGRAM_LABEL_MAX_CHARS) || cleanLabel(id, DIAGRAM_LABEL_MAX_CHARS)
    nodes.push({ id, label, kind: isKind(n.kind) ? n.kind : 'process' })
  }
  const edges: DiagramEdge[] = []
  const pairs = new Set<string>()
  for (const e of g.edges) {
    if (edges.length >= DIAGRAM_MAX_EDGES) break
    const from = String(e.from)
    const to = String(e.to)
    if (from === to || !seen.has(from) || !seen.has(to)) continue
    const pair = `${from}\u0000${to}`
    if (pairs.has(pair)) continue
    pairs.add(pair)
    const label = cleanLabel(e.label ?? '', DIAGRAM_EDGE_LABEL_MAX_CHARS).replace(/\n/g, ' ')
    edges.push({ from, to, label, ...(e.dashed ? { dashed: true } : {}), ...(e.open ? { open: true } : {}) })
  }
  return { direction: g.direction === 'right' ? 'right' : 'down', nodes, edges }
}

type DiagramResult = Extract<AiResult, { action: 'diagram' }>

/** The api's `diagram` result as a graph, or null when it has fewer than two nodes (nothing to diagram). */
export function graphFromAi(
  result: Pick<DiagramResult, 'direction' | 'nodes' | 'edges'>,
): DiagramGraph | null {
  const g = normalizeGraph({
    direction: result.direction,
    nodes: result.nodes,
    edges: result.edges,
  })
  return g.nodes.length >= 2 ? g : null
}

/** Elements a graph becomes: a shape and its label per node, an arrow per edge and a text per edge label. */
export function elementCount(g: DiagramGraph): number {
  return g.nodes.length * 2 + g.edges.length + g.edges.filter((e) => e.label).length
}
