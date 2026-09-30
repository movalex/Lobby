// OWNER: 3i. The accessible content list (docs/EXCALIDRAW-MIGRATION.md §4.8 (3)): the board's notes, frames
// and texts, in reading order, each frame with the notes and texts inside it. Pure (a level input), so the
// same list is testable in Node and renderable anywhere (./ContentsPanel.tsx; 3b's search panel may show it
// for an empty query).
import { type Bounds, type CanvasElement, items } from '../../../canvas/api/index.ts'
import { describeElement } from './describe.ts'
import { inReadingOrder, type LevelInput, type OrderEntry, readingOrder } from './reading-order.ts'

export type ContentKind = 'note' | 'frame' | 'text'

export interface ContentNode {
  readonly id: string
  readonly kind: ContentKind
  /** "Sticky note: Faster builds", "Frame: Retro", "Text: Agenda" */
  readonly label: string
  /** a frame's notes and texts, in reading order */
  readonly children: readonly ContentNode[]
}

export interface BoardContents {
  readonly nodes: readonly ContentNode[]
  readonly counts: { readonly notes: number; readonly frames: number; readonly texts: number }
}

const kindOf = (el: CanvasElement): ContentKind | null => {
  const k = items.itemKindOf(el)
  return k === 'note' || k === 'frame' || k === 'text' ? k : null
}

/** The elements of an entry in reading order (a group's members; an element entry is itself). */
function membersInOrder(entry: OrderEntry, input: LevelInput, byId: ReadonlyMap<string, CanvasElement>) {
  if (!entry.group) return [entry.lead]
  const members: { el: CanvasElement; bounds: Bounds }[] = []
  for (const id of entry.ids) {
    const el = byId.get(id)
    const bounds = el ? input.bounds(id) : null
    if (el && bounds) members.push({ el, bounds })
  }
  return inReadingOrder(members).map((m) => m.el)
}

export function boardContents(input: LevelInput): BoardContents {
  const byId = new Map(input.elements.map((e) => [e.id, e]))
  const lookup = (id: string) => byId.get(id)
  const counts = { notes: 0, frames: 0, texts: 0 }
  const leaf = (el: CanvasElement): ContentNode | null => {
    const kind = kindOf(el)
    if (kind !== 'note' && kind !== 'text') return null
    if (kind === 'note') counts.notes++
    else counts.texts++
    return { id: el.id, kind, label: describeElement(el, lookup), children: [] }
  }
  const nodes: ContentNode[] = []
  for (const entry of readingOrder(input, null)) {
    for (const el of membersInOrder(entry, input, byId)) {
      if (kindOf(el) !== 'frame') {
        const n = leaf(el)
        if (n) nodes.push(n)
        continue
      }
      counts.frames++
      const children: ContentNode[] = []
      for (const inner of readingOrder(input, el.id)) {
        for (const m of membersInOrder(inner, input, byId)) {
          const n = leaf(m)
          if (n) children.push(n)
        }
      }
      nodes.push({ id: el.id, kind: 'frame', label: describeElement(el, lookup), children })
    }
  }
  return { nodes, counts }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "3 notes, 1 frame, 2 texts" (only the kinds the board has), or the empty-board line. */
export function contentsSummary(c: BoardContents['counts']): string {
  const parts = [
    c.notes ? plural(c.notes, 'note', 'notes') : '',
    c.frames ? plural(c.frames, 'frame', 'frames') : '',
    c.texts ? plural(c.texts, 'text', 'texts') : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No notes, frames or text on this board yet.'
}

/** The rows as the list shows them, top to bottom (a frame, then its children), with their depth. */
export function flatten(
  nodes: readonly ContentNode[],
  limit = Number.POSITIVE_INFINITY,
): { node: ContentNode; depth: 0 | 1 }[] {
  const out: { node: ContentNode; depth: 0 | 1 }[] = []
  for (const n of nodes) {
    if (out.length >= limit) break
    out.push({ node: n, depth: 0 })
    for (const c of n.children) {
      if (out.length >= limit) break
      out.push({ node: c, depth: 1 })
    }
  }
  return out
}
