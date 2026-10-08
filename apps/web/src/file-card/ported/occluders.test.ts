// K1-8 (wave K): the file cards' holes from a grid of the opaque elements (./occluders.ts) are the old
// quadratic scan's, hole for hole and in paint order, on 200 random boards with rotated, hidden, locked,
// huge and malformed elements; and the grid answers a 5,000-element board with 100 cards inside a stated
// budget (measured and printed; the budget is generous, so the test catches a return to quadratic work,
// not a slow machine).
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../canvas/api/index.ts'
import { type Box, holesAboveScan, Occluders, opaque } from './occluders.ts'

/** mulberry32: a small seeded generator, so a failure names its board. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = [
  'stickynote',
  'image',
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'line',
  'arrow',
  'frame',
  'freedraw',
]

function randomBoard(seed: number, n: number) {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T
  const items: CanvasElement[] = []
  const hidden = new Set<string>()
  for (let i = 0; i < n; i++) {
    const id = `el-${seed}-${i}`
    const type = pick(TYPES)
    const big = r() < 0.03
    const malformed = r() < 0.02
    const w = big ? 4000 + r() * 6000 : 10 + r() * 700
    const h = big ? 4000 + r() * 6000 : 10 + r() * 700
    const el = {
      id,
      type,
      x: (r() - 0.5) * 6000,
      y: (r() - 0.5) * 6000,
      width: malformed ? (r() < 0.5 ? -w : Number.NaN) : w,
      height: h,
      angle: r() < 0.3 ? r() * Math.PI * 2 : 0,
      locked: r() < 0.2,
      backgroundColor: r() < 0.25 ? 'transparent' : '#ffc9c9',
      fillStyle: pick(['solid', 'solid', 'hachure', 'cross-hatch']),
      opacity: r() < 0.15 ? 60 : 100,
    }
    if (r() < 0.1) hidden.add(id)
    items.push(el as unknown as CanvasElement)
  }
  return { items, isHidden: (id: string) => hidden.has(id) }
}

const boxOf = (el: CanvasElement): Box => ({ x: el.x, y: el.y, w: el.width, h: el.height })

describe('file-card occluders: the grid answers what the scan answered', () => {
  it('200 random boards: every unrotated element as a card gets the same holes, in the same order', () => {
    let compared = 0
    let withHoles = 0
    for (let seed = 1; seed <= 200; seed++) {
      const { items, isHidden } = randomBoard(seed, 20 + (seed % 7) * 40)
      const grid = new Occluders(items, isHidden)
      items.forEach((el, index) => {
        if (el.angle) return // a rotated card has no holes (CardLayer)
        const box = boxOf(el)
        const want = holesAboveScan(items, index, box, isHidden)
        const got = grid.holesAbove(index, box)
        expect(got, `board ${seed}, card ${index}`).toEqual(want)
        compared++
        if (want.length) withHoles++
      })
    }
    // positive control: the boards really cut holes, many of them
    expect(compared).toBeGreaterThan(10_000)
    expect(withHoles).toBeGreaterThan(2_000)
  })

  it('hidden elements cut nothing; locked ones and other cards do; frames, texts and unfilled shapes never', () => {
    const el = (id: string, type: string, extra: Record<string, unknown> = {}) =>
      ({
        id,
        type,
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        angle: 0,
        backgroundColor: '#ffc9c9',
        fillStyle: 'solid',
        opacity: 100,
        ...extra,
      }) as unknown as CanvasElement
    const card = el('card', 'image', { x: 0, y: 0, width: 400, height: 300 })
    const items = [
      card,
      el('note', 'stickynote'),
      el('locked', 'rectangle', { locked: true, x: 200 }),
      el('hidden', 'image', { x: 300 }),
      el('frame', 'frame'),
      el('text', 'text'),
      el('hollow', 'ellipse', { backgroundColor: 'transparent' }),
      el('faded', 'diamond', { opacity: 50 }),
    ]
    expect(items.map(opaque)).toEqual([true, true, true, true, false, false, false, false])
    const isHidden = (id: string) => id === 'hidden'
    const holes = new Occluders(items, isHidden).holesAbove(0, boxOf(card))
    expect(holes).toEqual([
      { x: 50, y: 50, w: 100, h: 100 },
      { x: 200, y: 50, w: 100, h: 100 },
    ])
    expect(holes).toEqual(holesAboveScan(items, 0, boxOf(card), isHidden))
    // an element painted BELOW the card cuts nothing
    expect(new Occluders(items, isHidden).holesAbove(1, boxOf(items[1] as CanvasElement))).toEqual(
      holesAboveScan(items, 1, boxOf(items[1] as CanvasElement), isHidden),
    )
  })

  it('a malformed card box (negative or non-finite size) is answered like the scan answered it', () => {
    const { items, isHidden } = randomBoard(4242, 300)
    const grid = new Occluders(items, isHidden)
    for (const box of [
      { x: 0, y: 0, w: -500, h: 400 },
      { x: Number.NaN, y: 0, w: 100, h: 100 },
      { x: -1e7, y: -1e7, w: 2e7, h: 2e7 },
    ])
      expect(grid.holesAbove(3, box)).toEqual(holesAboveScan(items, 3, box, isHidden))
  })

  it('microbenchmark: 5,000 elements with 100 cards, under the stated budget (printed, generous)', () => {
    // a board like a media-heavy pilot board scaled up: 100 cards spread among 4,900 other elements
    const { items, isHidden } = randomBoard(9001, 5_000)
    const cards = items
      .map((el, index) => ({ el, index }))
      .filter((c) => !c.el.angle)
      .filter((_, i) => i % 30 === 0)
      .slice(0, 100)
    expect(cards.length).toBe(100)
    const run = () => {
      const grid = new Occluders(items, isHidden)
      let holes = 0
      for (const c of cards) holes += grid.holesAbove(c.index, boxOf(c.el)).length
      return holes
    }
    const scan = () => {
      let holes = 0
      for (const c of cards) holes += holesAboveScan(items, c.index, boxOf(c.el), isHidden).length
      return holes
    }
    expect(run()).toBe(scan())
    const time = (fn: () => number, reps: number) => {
      const t0 = performance.now()
      for (let i = 0; i < reps; i++) fn()
      return (performance.now() - t0) / reps
    }
    run() // warm
    const gridMs = time(run, 20)
    const scanMs = time(scan, 5)
    // Budget: 50 ms per pass for the grid (what a 60 Hz frame can lose once, not each image load). Measured on
    // the 64-core dev PC: printed below and recorded in docs/PROGRESS.md; a CI runner is several times slower
    // and still far under it.
    const BUDGET_MS = 50
    console.log(
      `[k1-8 occluders] 5,000 elements, 100 cards: grid ${gridMs.toFixed(2)} ms/pass, old scan ${scanMs.toFixed(2)} ms/pass`,
    )
    expect(gridMs).toBeLessThan(BUDGET_MS)
  })
})
