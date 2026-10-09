// OWNER: W4 (wave L, L4-3). A small reader of Mermaid flowchart text: what "Paste as diagram" turns into
// native shapes and bound connectors, with no Mermaid bundle and no AI. Pure.
//
// The subset, and nothing else (any other statement makes the whole text "not a diagram": null, and the paste
// goes on to the next handler as before):
//   header   `flowchart TD` / `flowchart TB` / `flowchart LR` (or `graph …`), the first statement
//   nodes    `A`, `A[Process]`, `A(Process)`, `A{Decision}`, `A((Terminal))`, `A([Terminal])`, `A[/In or out/]`,
//            `A[\In or out\]`; a label may be quoted ("…") and `<br>` is a line break
//   links    `-->`, `-.->`, `==>`, `---` (no arrowhead), `-- text -->`, `-. text .->`, `== text ==>`, and a
//            `|text|` label after any of them; chains (`A --> B --> C`) and `;` between statements
//   ignored  `%%` comments and the styling statements `style`, `classDef`, `class`, `linkStyle`
// Refused (null): `subgraph`, `click`, `direction`, `&` fan-outs, the circle and cross ends (`--o`, `--x`,
// `==o`, …) and the open dotted and thick links (`-.-`, `===`), also where a texted link's words would swallow
// one (`A --o B --> C` is not a link "o B" from A to C), any other diagram type, fewer than two nodes, more than
// DIAGRAM_MAX_NODES nodes or DIAGRAM_MAX_EDGES edges.
//
// The graph goes through the AI path's gate (./graph.ts normalizeGraph): a label longer than its cap is
// shortened, and a repeated link or a link from a shape to itself is left out. `readMermaid` counts both, so the
// paste prompt says so before anything is written ("Paste as text" keeps every word).
import {
  cleanLabel,
  DIAGRAM_LABEL_MAX_CHARS,
  DIAGRAM_MAX_EDGES,
  DIAGRAM_MAX_NODES,
  type DiagramDirection,
  type DiagramGraph,
  type DiagramKind,
  normalizeGraph,
} from './graph.ts'

/** Longest text this reader looks at (a pasted chart of 40 nodes and 60 links is far below it). */
export const MERMAID_MAX_CHARS = 20_000

const HEADER = /^(?:flowchart|graph)\s+(TD|TB|LR)$/i
const IGNORED = /^(?:style|classDef|class|linkStyle)\s/
const REFUSED = /^(?:subgraph|end|click|direction|accTitle|accDescr)\b/
const ID = /^[A-Za-z0-9_]+/

/** A node shape's opening and closing tokens and the kind it is, longest openings first. */
const SHAPES: readonly { open: string; close: string; kind: DiagramKind }[] = [
  { open: '((', close: '))', kind: 'terminal' },
  { open: '([', close: '])', kind: 'terminal' },
  { open: '[/', close: '/]', kind: 'io' },
  { open: '[\\', close: '\\]', kind: 'io' },
  { open: '[', close: ']', kind: 'process' },
  { open: '(', close: ')', kind: 'process' },
  { open: '{', close: '}', kind: 'decision' },
]

/** Link tokens: the plain forms, and the texted forms' openings with their closings. */
const PLAIN_LINKS: readonly { token: string; dashed: boolean; open: boolean }[] = [
  { token: '-.->', dashed: true, open: false },
  { token: '-->', dashed: false, open: false },
  { token: '==>', dashed: false, open: false },
  { token: '---', dashed: false, open: true },
]
const TEXT_LINKS: readonly { start: string; end: string; dashed: boolean }[] = [
  { start: '-.', end: '.->', dashed: true },
  { start: '--', end: '-->', dashed: false },
  { start: '==', end: '==>', dashed: false },
]
/**
 * A texted link's words may not start with what makes Mermaid's link token longer (its circle and cross ends
 * `o` and `x`, or more of the line: `---`, `-.-`, `===`, `-->`) nor hold another link: such a statement is
 * a link this reader does not take, not words.
 */
const TEXT_LINK_BAD_START = /^[ox\-.=>]/
const TEXT_LINK_INNER_LINK = /--|==|-\.|\.-/

class Refused extends Error {}
const refuse = (): never => {
  throw new Refused()
}

/** `<br>` as a line break, quotes taken off, Mermaid's `#quot;` and the like left as they are. */
function labelText(raw: string): string {
  let s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  return s.replace(/<br\s*\/?>/gi, '\n').trim()
}

/** Splits a line into statements at `;` outside quotes and brackets. */
function statements(line: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && '[({'.includes(ch)) depth++
    else if (!quoted && '])}'.includes(ch)) depth = Math.max(0, depth - 1)
    if (ch === ';' && !quoted && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

interface Parsed {
  nodes: Map<string, { label: string; kind: DiagramKind; shaped: boolean }>
  edges: { from: string; to: string; label: string; dashed: boolean; open: boolean }[]
}

/** Reads one node at `s[i]` (an id and an optional shape); returns its id and where it ends. */
function readNode(s: string, i: number, p: Parsed): { id: string; at: number } {
  const m = ID.exec(s.slice(i))
  if (!m) refuse()
  const id = (m as RegExpExecArray)[0]
  let at = i + id.length
  const shape = SHAPES.find((sh) => s.startsWith(sh.open, at))
  let label: string | null = null
  let kind: DiagramKind = 'process'
  if (shape) {
    const from = at + shape.open.length
    let end = -1
    if (s[from] === '"') {
      const q = s.indexOf('"', from + 1)
      if (q < 0) refuse()
      if (!s.startsWith(shape.close, q + 1)) refuse()
      end = q + 1
    } else end = s.indexOf(shape.close, from)
    if (end < 0) refuse()
    label = labelText(s.slice(from, end))
    kind = shape.kind
    at = end + shape.close.length
  }
  const had = p.nodes.get(id)
  if (!had) p.nodes.set(id, { label: label ?? id, kind, shaped: label !== null })
  else if (label !== null && !had.shaped) p.nodes.set(id, { label, kind, shaped: true })
  return { id, at }
}

const skipSpace = (s: string, i: number) => {
  let j = i
  while (j < s.length && /\s/.test(s[j] as string)) j++
  return j
}

/** Reads a link at `s[i]`; returns its label, style and where it ends, or null when there is none. */
function readLink(
  s: string,
  i: number,
): { label: string; dashed: boolean; open: boolean; at: number } | null {
  let label = ''
  let dashed = false
  let open = false
  let at = -1
  const plain = PLAIN_LINKS.find((l) => s.startsWith(l.token, i))
  if (plain) {
    dashed = plain.dashed
    open = plain.open
    at = i + plain.token.length
  } else {
    const texted = TEXT_LINKS.find((l) => s.startsWith(l.start, i))
    if (!texted) return null
    const from = i + texted.start.length
    const end = s.indexOf(texted.end, from)
    if (end < 0) refuse()
    const raw = s.slice(from, end)
    if (TEXT_LINK_BAD_START.test(raw) || TEXT_LINK_INNER_LINK.test(raw)) refuse()
    label = labelText(raw)
    if (!label) refuse()
    dashed = texted.dashed
    at = end + texted.end.length
  }
  const j = skipSpace(s, at)
  if (s[j] === '|') {
    const end = s.indexOf('|', j + 1)
    if (end < 0) refuse()
    label = labelText(s.slice(j + 1, end))
    at = end + 1
  }
  return { label, dashed, open, at }
}

/** One statement: a node, or a chain of nodes joined by links. */
function readStatement(s: string, p: Parsed): void {
  let { id: prev, at } = readNode(s, 0, p)
  for (;;) {
    at = skipSpace(s, at)
    if (at >= s.length) return
    if (s[at] === '&') refuse()
    const link = readLink(s, at)
    if (!link) refuse()
    const l = link as NonNullable<typeof link>
    at = skipSpace(s, l.at)
    if (at >= s.length) refuse()
    const next = readNode(s, at, p)
    p.edges.push({ from: prev, to: next.id, label: l.label, dashed: l.dashed, open: l.open })
    if (p.nodes.size > DIAGRAM_MAX_NODES || p.edges.length > DIAGRAM_MAX_EDGES) refuse()
    prev = next.id
    at = next.at
  }
}

/** A Mermaid flowchart (the subset above) as a graph, or null when the text is anything else. */
export function parseMermaidLite(text: string): DiagramGraph | null {
  return readMermaid(text)?.graph ?? null
}

/** What the paste turns a flowchart into, and what the graph's gate changed on the way (see the header). */
export interface MermaidRead {
  readonly graph: DiagramGraph
  /** node and link labels shortened to their caps (lines or characters) */
  readonly shortened: number
  /** links left out: repeated (the same from and to), or from a shape to itself */
  readonly dropped: number
}

/** Whether the gate kept a label as written (its words cleaned of spacing and control characters only). */
const kept = (raw: string, gated: string, oneLine: boolean) => {
  const full = cleanLabel(raw, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
  return (oneLine ? full.replace(/\n/g, ' ') : full) === gated
}

/** A Mermaid flowchart as `parseMermaidLite` reads it, with what the gate shortened and left out; or null. */
export function readMermaid(text: string): MermaidRead | null {
  if (typeof text !== 'string' || !text.trim() || text.length > MERMAID_MAX_CHARS) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let direction: DiagramDirection | null = null
  const p: Parsed = { nodes: new Map(), edges: [] }
  try {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('%%')) continue
      for (const st of statements(trimmed)) {
        if (direction === null) {
          const h = HEADER.exec(st)
          if (!h) return null
          direction = (h[1] as string).toUpperCase() === 'LR' ? 'right' : 'down'
          continue
        }
        if (st.startsWith('%%') || IGNORED.test(st)) continue
        if (REFUSED.test(st)) return null
        readStatement(st, p)
        if (p.nodes.size > DIAGRAM_MAX_NODES || p.edges.length > DIAGRAM_MAX_EDGES) return null
      }
    }
  } catch (e) {
    if (e instanceof Refused) return null
    throw e
  }
  if (direction === null || p.nodes.size < 2) return null
  const g = normalizeGraph({
    direction,
    nodes: [...p.nodes].map(([id, n]) => ({ id, label: n.label, kind: n.kind })),
    edges: p.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.open ? { open: true } : {}),
    })),
  })
  let shortened = 0
  for (const n of g.nodes) {
    const raw = p.nodes.get(n.id)?.label ?? n.id
    if (!kept(cleanLabel(raw, DIAGRAM_LABEL_MAX_CHARS) ? raw : n.id, n.label, false)) shortened++
  }
  // the edges kept are the first of each from-to pair, in order
  const firstOf = new Map<string, (typeof p.edges)[number]>()
  for (const e of p.edges) {
    const pair = `${e.from}\u0000${e.to}`
    if (e.from !== e.to && !firstOf.has(pair)) firstOf.set(pair, e)
  }
  for (const e of g.edges) {
    const raw = firstOf.get(`${e.from}\u0000${e.to}`)?.label ?? ''
    if (!kept(raw, e.label, true)) shortened++
  }
  return { graph: g, shortened, dropped: p.edges.length - g.edges.length }
}
