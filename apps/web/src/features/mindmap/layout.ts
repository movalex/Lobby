// Automatic horizontal tree layout (pure). The root stays where it is; its first-level branches stack
// on the right and on the left of it, and every topic's children stack beside it, away from the root:
// right-side children share their left edge, left-side children share their right edge. Each child's
// block (the child plus everything shown under it) is centred on its parent, so no two topics overlap
// whatever their sizes. Collapsed branches take the height of their topic alone.

import type { MindmapTree, TopicNode } from './model.ts'

export interface LayoutConfig {
  /** Horizontal gap between a parent's edge and its children at `depth` (1 = first level). */
  hGap(depth: number): number
  /** Vertical gap between the blocks of sibling topics at `depth`. */
  vGap(depth: number): number
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  hGap: (depth) => (depth <= 1 ? 88 : 56),
  vGap: (depth) => (depth <= 1 ? 28 : 14),
}

export interface Point {
  x: number
  y: number
}

/** Height of every shown topic's block: the topic, or its children's stack when that is taller. */
export function blockHeights(tree: MindmapTree, cfg: LayoutConfig = DEFAULT_LAYOUT): Map<string, number> {
  const out = new Map<string, number>()
  const visit = (id: string): number => {
    const cached = out.get(id)
    if (cached !== undefined) return cached
    const n = tree.nodes.get(id)
    if (!n) return 0
    let h = n.box.h
    if (!n.collapsed && n.children.length && n.parentId !== null) {
      const gaps = cfg.vGap(n.depth + 1) * (n.children.length - 1)
      h = Math.max(h, n.children.reduce((sum, c) => sum + visit(c), 0) + gaps)
    }
    out.set(id, h)
    return h
  }
  const root = tree.nodes.get(tree.rootId)
  if (root) {
    for (const c of root.collapsed ? [] : root.children) visit(c)
    out.set(tree.rootId, root.box.h)
  }
  return out
}

/**
 * Top-left page positions of every shown topic except the root (which does not move), rounded to whole
 * pixels. Topics inside a collapsed branch are not returned: they keep their place while hidden.
 */
export function layoutTree(tree: MindmapTree, cfg: LayoutConfig = DEFAULT_LAYOUT): Map<string, Point> {
  const heights = blockHeights(tree, cfg)
  const positions = new Map<string, Point>()
  const root = tree.nodes.get(tree.rootId)
  if (!root) return positions

  const place = (parent: TopicNode, at: Point, kids: string[], side: 'left' | 'right') => {
    if (!kids.length) return
    const depth = parent.depth + 1
    const gap = cfg.vGap(depth)
    const total = kids.reduce((sum, id) => sum + (heights.get(id) ?? 0), 0) + gap * (kids.length - 1)
    let top = at.y + parent.box.h / 2 - total / 2
    for (const id of kids) {
      const child = tree.nodes.get(id)
      if (!child) continue
      const block = heights.get(id) ?? child.box.h
      const x =
        side === 'right' ? at.x + parent.box.w + cfg.hGap(depth) : at.x - cfg.hGap(depth) - child.box.w
      const y = top + block / 2 - child.box.h / 2
      const p = { x: Math.round(x), y: Math.round(y) }
      positions.set(id, p)
      if (!child.collapsed) place(child, p, child.children, side)
      top += block + gap
    }
  }

  if (!root.collapsed) {
    const at = { x: root.box.x, y: root.box.y }
    const right = root.children.filter((c) => tree.nodes.get(c)?.side === 'right')
    const left = root.children.filter((c) => tree.nodes.get(c)?.side === 'left')
    place(root, at, right, 'right')
    place(root, at, left, 'left')
  }
  return positions
}

/** The positions that differ from where the topics are now by more than `eps` pixels. */
export function movedPositions(
  tree: MindmapTree,
  positions: ReadonlyMap<string, Point>,
  eps = 0.5,
): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const [id, p] of positions) {
    const b = tree.nodes.get(id)?.box
    if (!b) continue
    if (Math.abs(b.x - p.x) > eps || Math.abs(b.y - p.y) > eps) out.set(id, p)
  }
  return out
}

/** Returns a copy of `tree` with the boxes moved to `positions` (to measure the result of a layout). */
export function withPositions(tree: MindmapTree, positions: ReadonlyMap<string, Point>): MindmapTree {
  const nodes = new Map<string, TopicNode>()
  for (const [id, n] of tree.nodes) {
    const p = positions.get(id)
    nodes.set(id, p ? { ...n, box: { ...n.box, x: p.x, y: p.y } } : n)
  }
  return { ...tree, nodes }
}
