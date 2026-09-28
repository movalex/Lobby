import { MINDMAP_MAX_DEPTH, MINDMAP_MAX_TOPICS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  balancedSides,
  buildTree,
  clockwiseBranches,
  descendantCount,
  dropTarget,
  isVisible,
  type MindmapTree,
  navigate,
  siblingsOf,
  sideForNewBranch,
  sideOfPoint,
  subtreeIds,
  type TopicInput,
} from './model.ts'
import { R, topic } from './test-trees.ts'

const tree = (inputs: TopicInput[]): MindmapTree => {
  const t = buildTree(R, inputs)
  if (!t) throw new Error('no tree')
  return t
}

const root = topic(R, null, { x: 0, y: 0, w: 200, h: 80 })

describe('buildTree', () => {
  it('is null without its central topic (the rest are then plain shapes)', () => {
    expect(buildTree(R, [topic('shape:a', R)])).toBeNull()
    // A "root" whose meta names another root is not this map's root.
    expect(buildTree(R, [topic(R, null, {}, { rootId: 'shape:other' })])).toBeNull()
  })

  it('orders children by where they are on the page (then by id), right side first on the root', () => {
    const t = tree([
      root,
      topic('shape:low', R, { y: 300 }),
      topic('shape:high', R, { y: -300 }),
      topic('shape:left', R, { y: -900 }, { side: 'left' }),
      topic('shape:tie-b', R, { y: 0 }),
      topic('shape:tie-a', R, { y: 0 }),
    ])
    expect(t.nodes.get(R)?.children).toEqual([
      'shape:high',
      'shape:tie-a',
      'shape:tie-b',
      'shape:low',
      'shape:left',
    ])
  })

  it('hangs a topic whose parent is gone from the central topic', () => {
    const t = tree([root, topic('shape:orphan', 'shape:deleted')])
    expect(t.nodes.get('shape:orphan')).toMatchObject({ parentId: R, depth: 1 })
  })

  it('ignores topics of other maps', () => {
    const t = tree([root, topic('shape:x', R, {}, { rootId: 'shape:other-root' })])
    expect(t.nodes.has('shape:x')).toBe(false)
  })

  it('cuts a parent loop at the central topic, deterministically', () => {
    const inputs = [
      root,
      topic('shape:a', 'shape:c'),
      topic('shape:b', 'shape:a'),
      topic('shape:c', 'shape:b'),
    ]
    const t = tree(inputs)
    const shape = (m: MindmapTree) =>
      [...m.nodes.values()].map((n) => `${n.id}<${n.parentId}@${n.depth}`).sort()
    expect(shape(tree([...inputs].reverse()))).toEqual(shape(t))
    // Everyone is reachable from the root, with consistent depths.
    for (const n of t.nodes.values()) {
      if (n.parentId === null) continue
      expect(t.nodes.get(n.parentId)?.depth).toBe(n.depth - 1)
    }
    expect(subtreeIds(t, R).sort()).toEqual([R, 'shape:a', 'shape:b', 'shape:c'].sort())
  })

  it('cuts a chain deeper than MINDMAP_MAX_DEPTH', () => {
    const inputs = [root]
    let parent = R
    for (let i = 0; i < MINDMAP_MAX_DEPTH + 5; i++) {
      const id = `shape:d${String(i).padStart(3, '0')}`
      inputs.push(topic(id, parent))
      parent = id
    }
    const t = tree(inputs)
    expect(Math.max(...[...t.nodes.values()].map((n) => n.depth))).toBeLessThanOrEqual(MINDMAP_MAX_DEPTH)
    expect(t.nodes.size).toBe(inputs.length)
  })

  it('deeper topics follow their first-level branch side, whatever their own meta says', () => {
    const t = tree([
      root,
      topic('shape:l', R, {}, { side: 'left' }),
      topic('shape:l1', 'shape:l', {}, { side: 'right' }),
      topic('shape:l11', 'shape:l1', {}, { side: 'right' }),
    ])
    expect(t.nodes.get('shape:l1')?.side).toBe('left')
    expect(t.nodes.get('shape:l11')?.side).toBe('left')
  })

  it('keeps at most MINDMAP_MAX_TOPICS topics and reports the rest', () => {
    const inputs = [root]
    for (let i = 0; i < MINDMAP_MAX_TOPICS + 3; i++)
      inputs.push(topic(`shape:n${String(i).padStart(5, '0')}`, R))
    const t = tree(inputs)
    expect(t.nodes.size).toBe(MINDMAP_MAX_TOPICS + 1)
    expect(t.dropped).toHaveLength(3)
  })
})

describe('queries', () => {
  const t = tree([
    root,
    topic('shape:a', R, { y: -100 }, { collapsed: true }),
    topic('shape:a1', 'shape:a', { y: -100 }),
    topic('shape:a11', 'shape:a1', { y: -100 }),
    topic('shape:b', R, { y: 100 }),
    topic('shape:l', R, { y: 0 }, { side: 'left' }),
  ])

  it('subtree, descendant count and visibility include collapsed parts', () => {
    expect(subtreeIds(t, 'shape:a')).toEqual(['shape:a', 'shape:a1', 'shape:a11'])
    expect(descendantCount(t, 'shape:a')).toBe(2)
    expect(isVisible(t, 'shape:a')).toBe(true)
    expect(isVisible(t, 'shape:a1')).toBe(false)
    expect(isVisible(t, 'shape:a11')).toBe(false)
  })

  it('siblings of a first-level topic are the branches on its side', () => {
    expect(siblingsOf(t, 'shape:b')).toEqual({ list: ['shape:a', 'shape:b'], index: 1 })
    expect(siblingsOf(t, 'shape:l')).toEqual({ list: ['shape:l'], index: 0 })
  })

  it('clockwise order: right side top to bottom, then left side bottom to top', () => {
    const m = tree([
      root,
      topic('shape:r1', R, { y: -50 }),
      topic('shape:r2', R, { y: 50 }),
      topic('shape:l1', R, { y: -50 }, { side: 'left' }),
      topic('shape:l2', R, { y: 50 }, { side: 'left' }),
    ])
    expect(clockwiseBranches(m)).toEqual(['shape:r1', 'shape:r2', 'shape:l2', 'shape:l1'])
  })
})

describe('navigate (arrow keys)', () => {
  const t = tree([
    root,
    topic('shape:a', R, { y: -200 }),
    topic('shape:b', R, { y: 40 }),
    topic('shape:c', R, { y: 300 }),
    topic('shape:b1', 'shape:b', { y: 0 }),
    topic('shape:b2', 'shape:b', { y: 100 }),
    topic('shape:l', R, { y: 0 }, { side: 'left' }),
    topic('shape:l1', 'shape:l', { y: 0 }),
    topic('shape:k', R, { y: 600 }, { collapsed: true }),
    topic('shape:k1', 'shape:k', { y: 600 }),
  ])

  it('away from the centre goes to the child nearest in height; toward it goes to the parent', () => {
    expect(navigate(t, R, 'right')).toEqual({ select: 'shape:b' })
    expect(navigate(t, R, 'left')).toEqual({ select: 'shape:l' })
    expect(navigate(t, 'shape:b', 'right')).toEqual({ select: 'shape:b1' })
    expect(navigate(t, 'shape:b1', 'left')).toEqual({ select: 'shape:b' })
    expect(navigate(t, 'shape:l', 'left')).toEqual({ select: 'shape:l1' })
    expect(navigate(t, 'shape:l', 'right')).toEqual({ select: R })
    expect(navigate(t, 'shape:a', 'right')).toEqual({})
  })

  it('up and down go through the siblings and stop at the ends', () => {
    expect(navigate(t, 'shape:b', 'up')).toEqual({ select: 'shape:a' })
    expect(navigate(t, 'shape:b', 'down')).toEqual({ select: 'shape:c' })
    expect(navigate(t, 'shape:a', 'up')).toEqual({})
    expect(navigate(t, 'shape:b2', 'up')).toEqual({ select: 'shape:b1' })
  })

  it('toward the children of a collapsed topic expands it first', () => {
    expect(navigate(t, 'shape:k', 'right')).toEqual({ expand: 'shape:k' })
  })
})

describe('dropTarget (drag a topic onto another to move it there)', () => {
  const inputs = [
    root,
    topic('shape:a', R, { x: 300, y: -100, w: 120, h: 56 }),
    topic('shape:a1', 'shape:a', { x: 500, y: -100, w: 120, h: 56 }),
    topic('shape:b', R, { x: 300, y: 100, w: 120, h: 56 }),
    topic('shape:c', R, { x: 300, y: 300, w: 120, h: 56 }, { collapsed: true }),
    topic('shape:c1', 'shape:c', { x: 320, y: 110, w: 60, h: 30 }),
  ]
  const moved = (id: string, x: number, y: number) =>
    tree(inputs.map((t) => (t.id === id ? { ...t, box: { ...t.box, x, y } } : t)))

  it('is the topic under the dropped topic’s centre', () => {
    // b's centre lands inside a1.
    expect(dropTarget(moved('shape:b', 510, -90), 'shape:b')).toBe('shape:a1')
    // ...inside the central topic.
    expect(dropTarget(moved('shape:b', 20, 10), 'shape:b')).toBe(R)
  })

  it('is null on empty canvas, and never the topic itself or its own branch', () => {
    expect(dropTarget(moved('shape:b', 900, 900), 'shape:b')).toBeNull()
    expect(dropTarget(moved('shape:a', 505, -95), 'shape:a')).toBeNull()
  })

  it('ignores topics hidden in a collapsed branch', () => {
    // c1 (hidden under the collapsed c) sits inside b's area: dropping a there hits b, not c1.
    expect(dropTarget(moved('shape:a', 300, 100), 'shape:a')).toBe('shape:b')
  })
})

describe('sides', () => {
  it('a new branch goes to the lighter side, right on a tie (so they alternate)', () => {
    const h = () => 56
    expect(sideForNewBranch(tree([root]), h)).toBe('right')
    expect(sideForNewBranch(tree([root, topic('shape:a', R)]), h)).toBe('left')
    expect(
      sideForNewBranch(tree([root, topic('shape:a', R), topic('shape:b', R, {}, { side: 'left' })]), h),
    ).toBe('right')
  })

  it('Tidy up balances by height and keeps the clockwise order', () => {
    const t = tree([
      root,
      topic('shape:1', R, { y: 0 }),
      topic('shape:2', R, { y: 100 }),
      topic('shape:3', R, { y: 200 }),
      topic('shape:4', R, { y: 300 }),
    ])
    const sides = balancedSides(t, () => 56)
    expect(Object.fromEntries(sides)).toEqual({
      'shape:1': 'right',
      'shape:2': 'right',
      'shape:3': 'left',
      'shape:4': 'left',
    })
    // A tall first branch balances two short ones; one branch alone stays right.
    const heights: Record<string, number> = { 'shape:1': 300, 'shape:2': 56, 'shape:3': 56, 'shape:4': 190 }
    expect(Object.fromEntries(balancedSides(t, (id) => heights[id] ?? 0))).toEqual({
      'shape:1': 'right',
      'shape:2': 'left',
      'shape:3': 'left',
      'shape:4': 'left',
    })
    expect(Object.fromEntries(balancedSides(tree([root, topic('shape:1', R)]), () => 56))).toEqual({
      'shape:1': 'right',
    })
  })

  it('a dropped first-level topic takes the side of the centre it lands on', () => {
    expect(sideOfPoint({ x: 0, y: 0, w: 200, h: 80 }, 99)).toBe('left')
    expect(sideOfPoint({ x: 0, y: 0, w: 200, h: 80 }, 101)).toBe('right')
  })
})
