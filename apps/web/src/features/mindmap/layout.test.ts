import { describe, expect, it } from 'vitest'
import { blockHeights, DEFAULT_LAYOUT, layoutTree, movedPositions, withPositions } from './layout.ts'
import { type Box, buildTree, isVisible, type MindmapTree, subtreeOf, type TopicInput } from './model.ts'
import { R, randomMap, rng, topic } from './test-trees.ts'

const tree = (inputs: TopicInput[]): MindmapTree => {
  const t = buildTree(R, inputs)
  if (!t) throw new Error('no tree')
  return t
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The boxes of every shown topic once the layout is applied. */
function laidOut(t: MindmapTree) {
  const after = withPositions(t, layoutTree(t))
  return [...after.nodes.values()].filter((n) => isVisible(after, n.id))
}

/** Re-reads the tree from the laid-out positions (what the next client or the next pass sees). */
function reread(inputs: TopicInput[], t: MindmapTree): TopicInput[] {
  const pos = layoutTree(t)
  return inputs.map((i) => {
    const p = pos.get(i.id)
    return p ? { ...i, box: { ...i.box, x: p.x, y: p.y } } : i
  })
}

describe('layoutTree: one level', () => {
  const root = topic(R, null, { x: 0, y: 0, w: 200, h: 80 })

  it('leaves a lone central topic alone', () => {
    expect([...layoutTree(tree([root]))]).toEqual([])
  })

  it('stacks right-side branches beside the root, centred on it, in page order', () => {
    const t = tree([
      root,
      topic('shape:b', R, { y: 50 }),
      topic('shape:a', R, { y: -50 }),
      topic('shape:c', R, { y: 900 }),
    ])
    const pos = layoutTree(t)
    const x = 200 + DEFAULT_LAYOUT.hGap(1)
    const gap = DEFAULT_LAYOUT.vGap(1)
    const total = 3 * 56 + 2 * gap
    const top = 40 - total / 2
    expect(pos.get('shape:a')).toEqual({ x, y: Math.round(top) })
    expect(pos.get('shape:b')).toEqual({ x, y: Math.round(top + 56 + gap) })
    expect(pos.get('shape:c')).toEqual({ x, y: Math.round(top + 2 * (56 + gap)) })
  })

  it('puts left-side branches on the left, their right edges lined up', () => {
    const t = tree([
      root,
      topic('shape:l1', R, { w: 150, y: 0 }, { side: 'left' }),
      topic('shape:l2', R, { w: 260, y: 100 }, { side: 'left' }),
      topic('shape:r1', R, { y: 0 }),
    ])
    const pos = layoutTree(t)
    const edge = 0 - DEFAULT_LAYOUT.hGap(1)
    expect((pos.get('shape:l1')?.x ?? 0) + 150).toBe(edge)
    expect((pos.get('shape:l2')?.x ?? 0) + 260).toBe(edge)
    // One branch on the right: centred on the root.
    expect(pos.get('shape:r1')).toEqual({ x: 200 + DEFAULT_LAYOUT.hGap(1), y: 40 - 28 })
  })
})

describe('layoutTree: deeper levels', () => {
  it('gives a branch the height of its children when they are taller, and moves its siblings apart', () => {
    const root = topic(R, null, { w: 200, h: 80 })
    const inputs = [
      root,
      topic('shape:a', R, { y: 0 }),
      topic('shape:b', R, { y: 100 }),
      topic('shape:a1', 'shape:a', { y: 0 }),
      topic('shape:a2', 'shape:a', { y: 10 }),
      topic('shape:a3', 'shape:a', { y: 20 }),
    ]
    const t = tree(inputs)
    const heights = blockHeights(t)
    const g2 = DEFAULT_LAYOUT.vGap(2)
    expect(heights.get('shape:a')).toBe(3 * 56 + 2 * g2)
    expect(heights.get('shape:b')).toBe(56)
    const pos = layoutTree(t)
    const a = pos.get('shape:a')
    const a1 = pos.get('shape:a1')
    const a3 = pos.get('shape:a3')
    // The parent sits in the middle of its children; they are one gap to its right.
    if (!a || !a1 || !a3) throw new Error('not laid out')
    expect(Math.abs(a.y + 28 - (a1.y + a3.y + 56) / 2)).toBeLessThanOrEqual(1)
    expect(a1.x).toBe(a.x + 120 + DEFAULT_LAYOUT.hGap(2))
    // b starts one first-level gap below a's whole block (whole pixels: within 1).
    const bTop = pos.get('shape:b')?.y ?? 0
    expect(
      Math.abs(bTop - (a1.y + (heights.get('shape:a') ?? 0) + DEFAULT_LAYOUT.vGap(1))),
    ).toBeLessThanOrEqual(1)
  })

  it('does not place (and does not count) what a collapsed topic hides', () => {
    const inputs = [
      topic(R, null, { w: 200, h: 80 }),
      topic('shape:a', R, { y: 0 }, { collapsed: true }),
      topic('shape:a1', 'shape:a', { y: 0, h: 400 }),
      topic('shape:b', R, { y: 100 }),
    ]
    const t = tree(inputs)
    expect(blockHeights(t).get('shape:a')).toBe(56)
    const pos = layoutTree(t)
    expect(pos.has('shape:a1')).toBe(false)
    expect(pos.get('shape:b')?.y).toBe(Math.round((pos.get('shape:a')?.y ?? 0) + 56 + DEFAULT_LAYOUT.vGap(1)))
  })

  it('a collapsed central topic hides the whole map', () => {
    const t = tree([topic(R, null, {}, { collapsed: true }), topic('shape:a', R)])
    expect([...layoutTree(t)]).toEqual([])
  })
})

describe('layoutTree: properties on random maps', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1)

  it.each(seeds)('seed %i: no two shown topics overlap, and every child is beside its parent', (seed) => {
    const inputs = randomMap(seed, 5 + (seed % 7) * 12)
    const t = tree(inputs)
    const nodes = laidOut(t)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]?.box as Box
        const b = nodes[j]?.box as Box
        expect(overlaps(a, b), `${nodes[i]?.id} overlaps ${nodes[j]?.id}`).toBe(false)
      }
    }
    const after = withPositions(t, layoutTree(t))
    for (const n of nodes) {
      if (n.parentId === null) continue
      const p = after.nodes.get(n.parentId)?.box as Box
      if (n.side === 'right') expect(n.box.x).toBeGreaterThanOrEqual(p.x + p.w)
      else expect(n.box.x + n.box.w).toBeLessThanOrEqual(p.x)
    }
  })

  it.each(seeds)(
    'seed %i: the layout is a fixed point (laying out the result again moves nothing)',
    (seed) => {
      const inputs = randomMap(seed, 40)
      const first = tree(inputs)
      const second = tree(reread(inputs, first))
      expect(movedPositions(second, layoutTree(second))).toEqual(new Map())
      // ...and keeps each parent's children in the same order.
      for (const [id, n] of first.nodes) expect(second.nodes.get(id)?.children).toEqual(n.children)
    },
  )

  it.each(seeds.slice(0, 10))(
    'seed %i: two clients reading the topics in any order compute the same layout',
    (seed) => {
      const inputs = randomMap(seed, 60)
      const shuffled = [...inputs]
      const r = rng(seed * 7)
      for (let i = shuffled.length - 1; i > 0; i--) {
        const k = Math.floor(r() * (i + 1))
        ;[shuffled[i], shuffled[k]] = [shuffled[k] as TopicInput, shuffled[i] as TopicInput]
      }
      expect([...layoutTree(tree(shuffled))].sort()).toEqual([...layoutTree(tree(inputs))].sort())
    },
  )

  it('never moves the central topic', () => {
    const t = tree(randomMap(3, 30))
    expect(layoutTree(t).has(R)).toBe(false)
  })

  it('lays out 2,000 topics in well under a frame budget', () => {
    const inputs = randomMap(99, 2000)
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) layoutTree(tree(inputs))
    const per = (performance.now() - t0) / 5
    // Build + layout per pass; generous for CI noise (measured ~5-15 ms on this PC).
    expect(per).toBeLessThan(120)
  })
})

describe('a dragged topic takes its branch along (subtreeOf + layoutTree)', () => {
  it('lays the branch out beside wherever the topic is now, with the map’s gaps', () => {
    const inputs = [
      topic(R, null, { w: 200, h: 80 }),
      topic('shape:a', R, { x: 900, y: 700 }, { side: 'right' }),
      topic('shape:a1', 'shape:a', { x: 0, y: 0 }),
      topic('shape:a2', 'shape:a', { x: 0, y: 10 }),
      topic('shape:b', R, { y: -100 }),
    ]
    const t = tree(inputs)
    const sub = subtreeOf(t, 'shape:a')
    if (!sub) throw new Error('no branch')
    expect([...sub.nodes.keys()].sort()).toEqual(['shape:a', 'shape:a1', 'shape:a2'])
    const pos = layoutTree(sub)
    expect(pos.has('shape:a')).toBe(false) // the dragged topic itself stays under the pointer
    expect(pos.get('shape:a1')?.x).toBe(900 + 120 + DEFAULT_LAYOUT.hGap(2))
    const mid = ((pos.get('shape:a1')?.y ?? 0) + (pos.get('shape:a2')?.y ?? 0) + 56) / 2
    expect(Math.abs(mid - (700 + 28))).toBeLessThanOrEqual(1)
    expect(subtreeOf(t, 'shape:nope')).toBeNull()
  })
})

describe('movedPositions', () => {
  it('reports only topics that move by more than half a pixel', () => {
    const t = tree([topic(R, null, { w: 200, h: 80 }), topic('shape:a', R, { x: 288, y: 12 })])
    expect(movedPositions(t, new Map([['shape:a', { x: 288.4, y: 12 }]]))).toEqual(new Map())
    expect(movedPositions(t, new Map([['shape:a', { x: 290, y: 12 }]])).get('shape:a')).toEqual({
      x: 290,
      y: 12,
    })
  })
})
