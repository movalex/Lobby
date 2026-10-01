import { describe, expect, it } from 'vitest'
import {
  alignRows,
  appendInFrame,
  BESIDE_GAP,
  CLEARANCE,
  type ClusterInput,
  collides,
  FRAME_MARGIN,
  fitCols,
  frameRegion,
  grid,
  layoutThemes,
  openRegion,
  placeAround,
  placeBeside,
  type Rect,
  ROW_SNAP,
  union,
} from './layout.ts'

// The Lobby tour's "2 · Brainstorm" frame (packages/templates lobby-tour.ts): 1600 x 1000, the question
// ellipse and three theme cards on the left with connectors between them, eight 180 px notes in three
// rows on the right. Text heights are what tldraw renders at those sizes, rounded up.
const FRAME = { w: 1600, h: 1000 }
const TOUR_OBSTACLES: Rect[] = [
  { x: 80, y: 56, w: 1440, h: 64 }, // heading
  { x: 80, y: 136, w: 1240, h: 72 }, // intro (two lines)
  { x: 80, y: 460, w: 360, h: 220 }, // the question
  { x: 560, y: 314, w: 240, h: 72 }, // theme cards
  { x: 560, y: 534, w: 240, h: 72 },
  { x: 560, y: 754, w: 240, h: 72 },
  { x: 440, y: 350, w: 120, h: 440 }, // connectors fanning out
]
const tourNotes = () => {
  const at = (i: number, row: number, col: number) => ({
    id: `n${i}`,
    x: 850 + col * 200,
    y: 260 + row * 220,
    w: 180,
    h: 180,
  })
  return [
    at(0, 0, 0),
    at(1, 0, 1),
    at(2, 0, 2),
    at(3, 1, 0),
    at(4, 1, 1),
    at(5, 2, 0),
    at(6, 2, 1),
    at(7, 2, 2),
  ]
}
/** About 11 px per character at the label size; 34 px lines. */
const labelH = (name: string) => (w: number) => Math.ceil((name.length * 11) / w) * 34

function clusters(groups: string[][], names: string[]): ClusterInput[] {
  return groups.map((ids, i) => ({
    key: names[i] ?? `t${i}`,
    notes: ids.map((id) => ({ id, w: 180, h: 180 })),
    labelH: labelH(names[i] ?? ''),
  }))
}

function expectTidy(layout: ReturnType<typeof layoutThemes>, obstacles: readonly Rect[], inside?: Rect) {
  const boxes = layout.clusters.map((c) => c.box)
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      expect(collides(boxes[i] as Rect, boxes[j] as Rect, 1), `clusters ${i} and ${j}`).toBe(false)
  for (const c of layout.clusters) {
    for (const o of obstacles)
      expect(collides(c.box, o, CLEARANCE - 1), `${c.key} over an obstacle`).toBe(false)
    for (const n of c.notes) {
      // Every note sits below its own label, inside its own cluster.
      expect(n.y).toBeGreaterThanOrEqual(c.label.y + c.label.h)
      expect(n.x).toBeGreaterThanOrEqual(c.box.x)
      expect(n.x + 180).toBeLessThanOrEqual(c.box.x + c.box.w + 0.01)
      expect(n.y + 180).toBeLessThanOrEqual(c.box.y + c.box.h + 0.01)
    }
    if (inside) {
      expect(c.box.x).toBeGreaterThanOrEqual(inside.x)
      expect(c.box.y).toBeGreaterThanOrEqual(inside.y)
      expect(c.box.x + c.box.w).toBeLessThanOrEqual(inside.x + inside.w)
      expect(c.box.y + c.box.h).toBeLessThanOrEqual(inside.y + inside.h)
    }
  }
  // Notes never overlap anything.
  const notes = layout.clusters.flatMap((c) => c.notes.map((n) => ({ x: n.x, y: n.y, w: 180, h: 180 })))
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++)
      expect(collides(notes[i] as Rect, notes[j] as Rect)).toBe(false)
}

describe('layoutThemes', () => {
  const inner = {
    x: FRAME_MARGIN,
    y: FRAME_MARGIN,
    w: FRAME.w - 2 * FRAME_MARGIN,
    h: FRAME.h - 2 * FRAME_MARGIN,
  }

  it('the tour Brainstorm: three themes of 3-2-3 fit the frame beside the theme cards, no growth, no overlaps', () => {
    const notes = tourNotes()
    const anchor = { x: 850, y: 260 }
    const layout = layoutThemes({
      clusters: clusters(
        [
          ['n0', 'n1', 'n2'],
          ['n3', 'n4'],
          ['n5', 'n6', 'n7'],
        ],
        ['Gameplay', 'Story', 'Community & Creators'],
      ),
      anchor,
      region: frameRegion(FRAME, anchor, 180),
      obstacles: TOUR_OBSTACLES,
    })
    expect(layout.overflow).toEqual({ right: 0, bottom: 0 })
    expectTidy(layout, TOUR_OBSTACLES, inner)
    expect(layout.clusters.flatMap((c) => c.notes.map((n) => n.id)).sort()).toEqual(
      notes.map((n) => n.id).sort(),
    )
    // Three columns side by side, tops aligned.
    expect(new Set(layout.clusters.map((c) => c.box.y)).size).toBe(1)
  })

  it('the tour Brainstorm: other 3-theme splits fit too', () => {
    const anchor = { x: 850, y: 260 }
    for (const split of [
      [3, 3, 2],
      [2, 3, 3],
    ]) {
      const ids = tourNotes().map((n) => n.id)
      const groups = [
        ids.slice(0, split[0]),
        ids.slice(split[0], (split[0] ?? 0) + (split[1] ?? 0)),
        ids.slice((split[0] ?? 0) + (split[1] ?? 0)),
      ]
      const layout = layoutThemes({
        clusters: clusters(groups, ['Big Openings', 'Story Twists', 'Made by Players']),
        anchor,
        region: frameRegion(FRAME, anchor, 180),
        obstacles: TOUR_OBSTACLES,
      })
      expect(layout.overflow, split.join('-')).toEqual({ right: 0, bottom: 0 })
      expectTidy(layout, TOUR_OBSTACLES, inner)
    }
  })

  it('the tour Brainstorm: four themes, or a lopsided split, grow the frame downwards as little as needed', () => {
    const anchor = { x: 850, y: 260 }
    for (const groups of [
      [
        ['n0', 'n1'],
        ['n2', 'n3'],
        ['n4', 'n5'],
        ['n6', 'n7'],
      ],
      [
        ['n0', 'n1', 'n2', 'n3'],
        ['n4', 'n5'],
        ['n6', 'n7'],
      ],
    ]) {
      const layout = layoutThemes({
        clusters: clusters(groups, ['Big Openings', 'Story Twists', 'Player Made', 'Live Events']),
        anchor,
        region: frameRegion(FRAME, anchor, 180),
        obstacles: TOUR_OBSTACLES,
      })
      expect(layout.overflow.right).toBe(0)
      // Less than two rows of notes more.
      expect(layout.overflow.bottom).toBeLessThan(400)
      expectTidy(layout, TOUR_OBSTACLES)
    }
  })

  it('too many notes for the frame: the least growth downwards, still tidy', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}`)
    const anchor = { x: 850, y: 260 }
    const layout = layoutThemes({
      clusters: clusters([ids.slice(0, 12), ids.slice(12, 22), ids.slice(22)], ['One', 'Two', 'Three']),
      anchor,
      region: frameRegion(FRAME, anchor, 180),
      obstacles: TOUR_OBSTACLES,
    })
    expect(layout.overflow.right).toBe(0)
    expect(layout.overflow.bottom).toBeGreaterThan(0)
    expectTidy(layout, TOUR_OBSTACLES)
  })

  it('a region narrower than a cluster reaches left instead of spilling out of the frame', () => {
    const region = frameRegion({ w: 1000, h: 1200 }, { x: 900, y: 100 }, 376)
    expect(region.minX).toBe(1000 - FRAME_MARGIN - 376)
    expect(region.maxX).toBe(1000 - FRAME_MARGIN)
    expect(frameRegion({ w: 300, h: 300 }, { x: 250, y: 0 }, 900).minX).toBe(FRAME_MARGIN)
  })

  it('the open canvas: compact, roughly as wide as the notes were, nothing overlapped', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`)
    const notesBounds = { x: 0, y: 0, w: 1400, h: 200 }
    const obstacles = [{ x: 600, y: 300, w: 400, h: 300 }]
    const layout = layoutThemes({
      clusters: clusters([ids.slice(0, 5), ids.slice(5, 9), ids.slice(9)], ['A', 'B', 'C']),
      anchor: { x: 0, y: 0 },
      region: openRegion({ x: 0, y: 0 }, notesBounds, 12 * 200 * 200, 200),
      obstacles,
    })
    expect(layout.overflow).toEqual({ right: 0, bottom: 0 })
    expectTidy(layout, obstacles)
    expect(layout.bounds.w).toBeLessThanOrEqual(1400)
  })

  it('is deterministic and keeps the clusters in order', () => {
    const input = {
      clusters: clusters([['a', 'b'], ['c']], ['First', 'Second']),
      anchor: { x: 0, y: 0 },
      region: { minX: 0, maxX: 2000, maxY: null },
      obstacles: [],
    }
    const a = layoutThemes(input)
    expect(layoutThemes(input)).toEqual(a)
    expect(a.clusters.map((c) => c.key)).toEqual(['First', 'Second'])
    expect(a.clusters[0]?.box.x).toBeLessThan(a.clusters[1]?.box.x ?? 0)
  })

  it('fixed columns and gap (the second pass with measured labels) are honoured', () => {
    const layout = layoutThemes(
      {
        clusters: clusters([['a', 'b', 'c', 'd']], ['Only']),
        anchor: { x: 10, y: 20 },
        region: { minX: 10, maxX: 5000, maxY: null },
        obstacles: [],
      },
      { cols: [2], gap: 32 },
    )
    expect(layout.gap).toBe(32)
    expect(layout.clusters[0]?.cols).toBe(2)
    expect(layout.clusters[0]?.notes.map((n) => [n.x, n.y])).toEqual([
      [10, 68],
      [206, 68],
      [10, 264],
      [206, 264],
    ])
  })
})

describe('alignRows (W5-04: the theme labels on one line)', () => {
  const NAMES = ['Big Gameplay Moments', 'Story Twists', 'Made With Players']
  const nine = () =>
    clusters(
      [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
        ['g', 'h', 'i'],
      ],
      NAMES,
    )
  // Something hanging into the row's top-left corner (a frame's edge, a card) holds the cluster packed
  // there a little lower than its neighbours.
  const HANGING: Rect = { x: 73, y: -200, w: 354, h: 194 }
  const open = (obstacles: Rect[]) => ({
    clusters: nine(),
    anchor: { x: 0, y: 0 },
    region: { minX: 0, maxX: 1500, maxY: null },
    obstacles,
  })

  it('packing alone leaves one cluster of the row lower; aligned, every label of the row shares its line', () => {
    const input = open([HANGING])
    const packed = layoutThemes(input)
    const tops = packed.clusters.map((c) => c.label.y)
    expect(new Set(tops).size).toBeGreaterThan(1)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(ROW_SNAP)
    const aligned = alignRows(packed, input)
    expect(new Set(aligned.clusters.map((c) => c.label.y)).size).toBe(1)
    expect(aligned.clusters[0]?.label.y).toBe(Math.max(...tops))
    // the notes moved with their labels, and still clear of everything
    aligned.clusters.forEach((c, i) => {
      const was = packed.clusters[i]
      const dy = c.label.y - (was?.label.y ?? 0)
      expect(c.notes.map((n) => n.y)).toEqual(was?.notes.map((n) => n.y + dy))
      expect(collides(c.box, HANGING, CLEARANCE - 0.01)).toBe(false)
      for (const o of aligned.clusters)
        if (o !== c) expect(collides(c.box, o.box, aligned.gap - 0.01)).toBe(false)
    })
    expect(aligned.bounds.y).toBe(Math.max(...tops))
  })

  it('a row is left as packed when lining it up would land a cluster on something', () => {
    const input = open([HANGING])
    const packed = layoutThemes(input)
    const low = packed.clusters.reduce((p, c) => (c.box.y > p.box.y ? c : p))
    const other = packed.clusters.find((c) => c.box.y < low.box.y)
    if (!other) throw new Error('no higher cluster')
    // right under the higher cluster: moving it down would touch this
    const under: Rect = {
      x: other.box.x,
      y: other.box.y + other.box.h + CLEARANCE + 1,
      w: other.box.w,
      h: 40,
    }
    const blocked = { ...input, obstacles: [HANGING, under] }
    expect(alignRows(packed, blocked)).toBe(packed)
  })

  it('inside a frame it never reaches further past the floor', () => {
    // a tall cluster on the left, a short one beside it held 22 lower: lining up would push the tall
    // one 22 past the frame's floor
    const cluster = (key: string, x: number, y: number, h: number) => ({
      key,
      label: { x, y, w: 180, h: 34 },
      notes: [{ id: key, x, y: y + 48 }],
      box: { x, y, w: 180, h },
      cols: 1,
    })
    const packed = {
      clusters: [cluster('tall', 0, 0, 400), cluster('short', 244, 22, 200)],
      bounds: { x: 0, y: 0, w: 424, h: 400 },
      overflow: { right: 0, bottom: 0 },
      gap: 64,
    }
    const input = (maxY: number) => ({
      clusters: [],
      anchor: { x: 0, y: 0 },
      region: { minX: 0, maxX: 1000, maxY },
      obstacles: [],
    })
    expect(alignRows(packed, input(400))).toBe(packed)
    const roomy = alignRows(packed, input(500))
    expect(roomy.clusters.map((c) => c.label.y)).toEqual([22, 22])
    expect(roomy.overflow.bottom).toBe(0)
    expect(roomy.bounds).toEqual({ x: 0, y: 22, w: 424, h: 400 })
  })

  it('changes nothing on a layout already on one line (the tour Brainstorm in its frame)', () => {
    const input = {
      clusters: clusters(
        [
          ['n0', 'n1', 'n2'],
          ['n3', 'n4'],
          ['n5', 'n6', 'n7'],
        ],
        NAMES,
      ),
      anchor: { x: 850, y: 260 },
      region: frameRegion(FRAME, { x: 850, y: 260 }, 180),
      obstacles: TOUR_OBSTACLES,
    }
    const packed = layoutThemes(input)
    expect(alignRows(packed, input)).toBe(packed)
  })
})

describe('placeBeside', () => {
  const sel = { x: 0, y: 0, w: 400, h: 200 }

  it('to the right first, then slides and tries the other sides around obstacles', () => {
    expect(placeBeside({ w: 300, h: 100 }, sel, [], null)).toEqual({ x: 448, y: 0 })
    const wall = { x: 420, y: -1000, w: 100, h: 3000 }
    const spot = placeBeside({ w: 300, h: 100 }, sel, [wall], null)
    expect(spot).toEqual({ x: 0, y: 248 })
  })

  it('only the sides asked for (inside a frame: right of or below the selection)', () => {
    const wallRight = { x: 420, y: -5000, w: 100, h: 10000 }
    const wallBelow = { x: -1000, y: 220, w: 3000, h: 100 }
    // Right and below are blocked close by: with every side the left is nearest; with right and below
    // only, the spot is further out on the right.
    expect(placeBeside({ w: 300, h: 100 }, sel, [wallRight, wallBelow], null)).toEqual({ x: -348, y: 0 })
    expect(placeBeside({ w: 300, h: 100 }, sel, [wallRight, wallBelow], null, ['right', 'below'])).toEqual({
      x: 568,
      y: 0,
    })
  })

  it('stays inside a region, or gives up (the caller then goes outside the frame)', () => {
    const region = { x: 0, y: 0, w: 1000, h: 400 }
    const spot = placeBeside({ w: 300, h: 100 }, sel, [], region)
    expect(spot).toEqual({ x: 448, y: 0 })
    expect(placeBeside({ w: 2000, h: 100 }, sel, [], region)).toBeNull()
  })

  it('never lands on anything', () => {
    const obstacles = Array.from({ length: 20 }, (_, i) => ({
      x: 450 + (i % 5) * 120,
      y: (i % 4) * 90,
      w: 100,
      h: 80,
    }))
    const spot = placeBeside({ w: 360, h: 240 }, sel, obstacles, null)
    if (!spot) throw new Error('no spot')
    const r = { ...spot, w: 360, h: 240 }
    for (const o of [...obstacles, sel]) expect(collides(r, o)).toBe(false)
  })

  it('placeAround centres on a free point, else goes beside it', () => {
    expect(placeAround({ w: 200, h: 100 }, { x: 500, y: 500 }, [])).toEqual({ x: 400, y: 450 })
    const spot = placeAround({ w: 200, h: 100 }, { x: 500, y: 500 }, [{ x: 450, y: 450, w: 100, h: 100 }])
    expect(collides({ ...spot, w: 200, h: 100 }, { x: 450, y: 450, w: 100, h: 100 })).toBe(false)
  })
})

describe('grid and union', () => {
  it('grid cells and size', () => {
    const g = grid(5, 3, { w: 200, h: 200 }, 20)
    expect(g.cells).toEqual([
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 440, y: 0 },
      { x: 0, y: 220 },
      { x: 220, y: 220 },
    ])
    expect([g.w, g.h]).toEqual([640, 420])
    expect(grid(2, 6, { w: 10, h: 10 }, 0).w).toBe(20)
  })

  it('union', () => {
    expect(union([])).toBeNull()
    expect(
      union([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: -5, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, w: 25, h: 15 })
  })
})

// DANA-07: results stay in the frame, under its content, aligned with it; the frame grows downwards only.
describe('appendInFrame and fitCols', () => {
  // The tour's "5 · Retro" frame: heading, intro, three column headers and two rows of notes.
  const RETRO = { w: 1600, h: 1000 }
  const content: Rect[] = [
    { x: 80, y: 56, w: 1440, h: 64 },
    { x: 80, y: 136, w: 900, h: 36 },
    { x: 80, y: 280, w: 480, h: 72 },
    { x: 80, y: 372, w: 1440, h: 460 },
  ]

  it('goes under the content, left-aligned with it, and says how tall the frame must be', () => {
    const at = appendInFrame({ w: 560, h: 200 }, RETRO, content)
    expect(at.x).toBe(80)
    expect(at.y).toBe(832 + BESIDE_GAP)
    expect(at.h).toBe(832 + BESIDE_GAP + 200 + FRAME_MARGIN)
    // Never over anything already there, never above the frame's top (where its name label is).
    for (const r of content) expect(collides({ ...at, w: 560, h: 200 }, r)).toBe(false)
    expect(at.y).toBeGreaterThan(0)
  })

  it('keeps the frame when the block fits, and stays inside its sides', () => {
    expect(appendInFrame({ w: 560, h: 60 }, RETRO, content.slice(0, 3))).toEqual({ x: 80, y: 400, h: 1000 })
    expect(appendInFrame({ w: 1700, h: 60 }, RETRO, content).x).toBe(FRAME_MARGIN)
    const right = appendInFrame({ w: 600, h: 60 }, RETRO, [{ x: 1200, y: 100, w: 300, h: 100 }])
    expect(right.x + 600).toBeLessThanOrEqual(RETRO.w - FRAME_MARGIN)
    expect(appendInFrame({ w: 200, h: 200 }, RETRO, [])).toEqual({
      x: FRAME_MARGIN,
      y: FRAME_MARGIN,
      h: 1000,
    })
  })

  it('fitCols: fewer columns when the frame is narrow', () => {
    expect(fitCols(12, 4, 200, null)).toBe(4)
    // An 800-wide retro column (720 inside): three 200 px notes fit, four do not.
    expect(fitCols(12, 4, 200, 720)).toBe(3)
    expect(fitCols(3, 3, 200, 720)).toBe(3)
    expect(fitCols(5, 4, 200, 150)).toBe(1)
    expect(fitCols(2, 4, 200, 2000)).toBe(2)
  })
})
