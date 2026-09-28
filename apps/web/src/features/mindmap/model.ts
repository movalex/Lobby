// The mind-map tree, as pure data (no editor, no DOM): built from the topics' validated meta
// (packages/contracts/src/mindmap.ts) and their page bounds, with the repairs every reader applies:
//  - a topic whose parent is gone (deleted, or refused by the sync server's text lease) hangs from the
//    root instead of floating away;
//  - a parent chain that loops, or runs deeper than MINDMAP_MAX_DEPTH, is cut at the root the same way;
//  - `side` only means something for first-level topics: deeper topics follow their first-level
//    ancestor, whatever their own meta says.
// Children are ordered by where they are on the page (centre y, then id): the layout keeps that order,
// so it is a fixed point, and two clients that see the same records compute the same tree.

import {
  MINDMAP_MAX_DEPTH,
  MINDMAP_MAX_TOPICS,
  type MindmapSide,
  type MindmapTopicMeta,
} from '@draftroom/contracts'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One topic as the editor sees it: its id, validated meta and page bounds. */
export interface TopicInput {
  id: string
  meta: MindmapTopicMeta
  box: Box
}

export interface TopicNode {
  id: string
  /** Effective parent (null for the root), after the orphan and loop repairs. */
  parentId: string | null
  /** Effective side ('right' for the root). */
  side: MindmapSide
  collapsed: boolean
  /** 0 for the root. */
  depth: number
  /** Ordered: top to bottom. The root's children are listed right side first, then left side. */
  children: string[]
  box: Box
}

export interface MindmapTree {
  rootId: string
  nodes: Map<string, TopicNode>
  /** Topics beyond MINDMAP_MAX_TOPICS (never laid out). */
  dropped: string[]
}

const centerY = (b: Box) => b.y + b.h / 2
const centerX = (b: Box) => b.x + b.w / 2

/** Stable order of siblings: by centre y on the page, then by id. */
export function compareByPosition(a: { id: string; box: Box }, b: { id: string; box: Box }): number {
  const dy = centerY(a.box) - centerY(b.box)
  if (Math.abs(dy) > 0.01) return dy
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The tree rooted at `rootId` from every topic that names it as root. Null when the root itself is not
 * among `topics` (the map is gone; its other topics are then plain shapes to everyone).
 */
export function buildTree(rootId: string, topics: readonly TopicInput[]): MindmapTree | null {
  const root = topics.find((t) => t.id === rootId && t.meta.parentId === null && t.meta.rootId === rootId)
  if (!root) return null
  const members = topics
    .filter((t) => t.id !== rootId && t.meta.rootId === rootId && t.meta.parentId !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const dropped =
    members.length > MINDMAP_MAX_TOPICS ? members.slice(MINDMAP_MAX_TOPICS).map((t) => t.id) : []
  const kept = dropped.length ? members.slice(0, MINDMAP_MAX_TOPICS) : members
  const byId = new Map<string, TopicInput>(kept.map((t) => [t.id, t]))

  // Effective parents: missing parent -> root.
  const parent = new Map<string, string>()
  for (const t of kept) {
    const p = t.meta.parentId as string
    parent.set(t.id, p === rootId || byId.has(p) ? p : rootId)
  }

  // Depths, cutting loops and over-deep chains at the root. Deterministic: ids in sorted order.
  const depth = new Map<string, number>([[rootId, 0]])
  for (const t of kept) {
    if (depth.has(t.id)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let cur = t.id
    while (!depth.has(cur)) {
      if (onPath.has(cur) || path.length > MINDMAP_MAX_DEPTH) {
        // `cur` closes a loop (or the chain is too deep): hang it from the root and resolve again.
        parent.set(cur, rootId)
        depth.set(cur, 1)
        break
      }
      onPath.add(cur)
      path.push(cur)
      cur = parent.get(cur) ?? rootId
    }
    // Unwind: each node is one deeper than its (now resolved) parent.
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i] as string
      if (depth.has(id)) continue
      const d = (depth.get(parent.get(id) ?? rootId) ?? 0) + 1
      if (d > MINDMAP_MAX_DEPTH) {
        parent.set(id, rootId)
        depth.set(id, 1)
      } else depth.set(id, d)
    }
  }

  const nodes = new Map<string, TopicNode>()
  nodes.set(rootId, {
    id: rootId,
    parentId: null,
    side: 'right',
    collapsed: root.meta.collapsed,
    depth: 0,
    children: [],
    box: root.box,
  })
  for (const t of kept) {
    nodes.set(t.id, {
      id: t.id,
      parentId: parent.get(t.id) ?? rootId,
      side: t.meta.side,
      collapsed: t.meta.collapsed,
      depth: depth.get(t.id) ?? 1,
      children: [],
      box: t.box,
    })
  }

  // Sides: first-level topics keep theirs; deeper ones follow their first-level ancestor (parents are
  // resolved in depth order).
  const byDepth = [...nodes.values()].sort((a, b) => a.depth - b.depth)
  for (const n of byDepth) {
    if (n.depth < 2 || n.parentId === null) continue
    const p = nodes.get(n.parentId)
    if (p) n.side = p.side
  }

  // Children, ordered on the page. The root lists its right side first.
  const kids = new Map<string, TopicNode[]>()
  for (const n of nodes.values()) {
    if (n.parentId === null) continue
    const list = kids.get(n.parentId) ?? []
    list.push(n)
    kids.set(n.parentId, list)
  }
  for (const [pid, list] of kids) {
    list.sort(compareByPosition)
    const p = nodes.get(pid)
    if (!p) continue
    p.children =
      pid === rootId
        ? [...list.filter((c) => c.side === 'right'), ...list.filter((c) => c.side === 'left')].map(
            (c) => c.id,
          )
        : list.map((c) => c.id)
  }
  return { rootId, nodes, dropped }
}

/** The ids of `id` and everything under it (collapsed branches included), parents first. */
export function subtreeIds(tree: MindmapTree, id: string): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop() as string
    const n = tree.nodes.get(cur)
    if (!n) continue
    out.push(cur)
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as string)
  }
  return out
}

/**
 * The branch under `id` as a tree of its own with `id` as its root (depths and sides kept, so the gaps
 * are the map's): laying it out places the branch beside wherever `id` is now (a topic being dragged
 * takes its branch along).
 */
export function subtreeOf(tree: MindmapTree, id: string): MindmapTree | null {
  if (!tree.nodes.has(id)) return null
  const nodes = new Map<string, TopicNode>()
  for (const t of subtreeIds(tree, id)) {
    const n = tree.nodes.get(t)
    if (n) nodes.set(t, t === id ? { ...n, parentId: null } : n)
  }
  return { rootId: id, nodes, dropped: [] }
}

/** Topics under `id` (not counting it). */
export function descendantCount(tree: MindmapTree, id: string): number {
  return Math.max(0, subtreeIds(tree, id).length - 1)
}

/** Whether `id` is shown: no ancestor of it is collapsed. */
export function isVisible(tree: MindmapTree, id: string): boolean {
  let n = tree.nodes.get(id)
  let guard = 0
  while (n && n.parentId !== null && guard++ <= MINDMAP_MAX_DEPTH + 1) {
    const p = tree.nodes.get(n.parentId)
    if (!p) return true
    if (p.collapsed) return false
    n = p
  }
  return true
}

/** Children of `id` on one side (only the root has two). */
export function childrenOnSide(tree: MindmapTree, id: string, side: MindmapSide): string[] {
  const n = tree.nodes.get(id)
  if (!n) return []
  if (n.parentId !== null) return n.side === side ? n.children : []
  return n.children.filter((c) => tree.nodes.get(c)?.side === side)
}

/** The side a new first-level topic goes to: the lighter side (total branch height), right on a tie. */
export function sideForNewBranch(tree: MindmapTree, blockHeight: (id: string) => number): MindmapSide {
  const total = (side: MindmapSide) =>
    childrenOnSide(tree, tree.rootId, side).reduce((sum, id) => sum + blockHeight(id), 0)
  return total('left') < total('right') ? 'left' : 'right'
}

/**
 * The siblings of `id` in display order (for the root's children: the ones on the same side), and its
 * position among them.
 */
export function siblingsOf(tree: MindmapTree, id: string): { list: string[]; index: number } {
  const n = tree.nodes.get(id)
  if (!n || n.parentId === null) return { list: [id], index: 0 }
  const p = tree.nodes.get(n.parentId)
  if (!p) return { list: [id], index: 0 }
  const list = p.parentId === null ? childrenOnSide(tree, p.id, n.side) : p.children
  return { list, index: list.indexOf(id) }
}

export type NavDirection = 'left' | 'right' | 'up' | 'down'

export interface NavResult {
  /** Select this topic... */
  select?: string
  /** ...or expand this collapsed topic (Right/Left toward its hidden children). */
  expand?: string
}

/**
 * Arrow-key navigation from `id`: away from the root goes to the child nearest in height (expanding a
 * collapsed topic first), toward the root goes to the parent, up and down go to the previous and next
 * sibling. The root goes right or left into that side's branches.
 */
export function navigate(tree: MindmapTree, id: string, dir: NavDirection): NavResult {
  const n = tree.nodes.get(id)
  if (!n) return {}
  if (dir === 'up' || dir === 'down') {
    const { list, index } = siblingsOf(tree, id)
    const next = list[index + (dir === 'up' ? -1 : 1)]
    return next ? { select: next } : {}
  }
  const outward: MindmapSide = dir
  if (n.parentId !== null && n.side !== outward) return { select: n.parentId }
  const kids = childrenOnSide(tree, id, outward)
  if (!kids.length) return {}
  if (n.collapsed) return { expand: id }
  const cy = centerY(n.box)
  let best = kids[0] as string
  let bestD = Number.POSITIVE_INFINITY
  for (const k of kids) {
    const b = tree.nodes.get(k)?.box
    if (!b) continue
    const d = Math.abs(centerY(b) - cy)
    if (d < bestD - 0.01) {
      best = k
      bestD = d
    }
  }
  return { select: best }
}

/**
 * The first-level topics in clockwise order (right side top to bottom, then left side bottom to top):
 * the reading order of the map, used by the outline and by Tidy up.
 */
export function clockwiseBranches(tree: MindmapTree): string[] {
  const right = childrenOnSide(tree, tree.rootId, 'right')
  const left = childrenOnSide(tree, tree.rootId, 'left')
  return [...right, ...[...left].reverse()]
}

/**
 * Tidy up's side balance: keeps the clockwise order and puts the first k branches on the right and the
 * rest on the left, choosing k so the two sides' heights are as equal as possible (ties: more on the
 * right). Returns the new side of every first-level topic.
 */
export function balancedSides(
  tree: MindmapTree,
  blockHeight: (id: string) => number,
): Map<string, MindmapSide> {
  const order = clockwiseBranches(tree)
  const heights = order.map((id) => blockHeight(id))
  const total = heights.reduce((a, b) => a + b, 0)
  let best = order.length
  let bestDiff = Number.POSITIVE_INFINITY
  let right = 0
  for (let k = 0; k <= order.length; k++) {
    const diff = Math.abs(right - (total - right))
    if (diff < bestDiff - 0.01 || (Math.abs(diff - bestDiff) <= 0.01 && k > best)) {
      bestDiff = diff
      best = k
    }
    right += heights[k] ?? 0
  }
  const sides = new Map<string, MindmapSide>()
  order.forEach((id, i) => {
    sides.set(id, i < best ? 'right' : 'left')
  })
  return sides
}

/**
 * Where a dragged topic was dropped: the shown topic whose box holds the dragged topic's centre (the
 * smallest, if several do), never the topic itself or anything in its own branch. Null when it was
 * dropped on empty canvas (the map then re-sorts it among its siblings).
 */
export function dropTarget(tree: MindmapTree, id: string): string | null {
  const n = tree.nodes.get(id)
  if (!n) return null
  const cx = n.box.x + n.box.w / 2
  const cy = centerY(n.box)
  const own = new Set(subtreeIds(tree, id))
  let best: string | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const t of tree.nodes.values()) {
    if (own.has(t.id) || !isVisible(tree, t.id)) continue
    const b = t.box
    if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue
    const area = b.w * b.h
    if (area < bestArea) {
      best = t.id
      bestArea = area
    }
  }
  return best
}

/** Which side of the root a point is on (used when a first-level topic is dropped). */
export function sideOfPoint(rootBox: Box, x: number): MindmapSide {
  return x < centerX(rootBox) ? 'left' : 'right'
}
