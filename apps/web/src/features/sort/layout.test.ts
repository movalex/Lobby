// L8-1 and L8-2: the two pure layouts. Columns: labelled columns from where the notes were, clear of
// obstacles, inside the room (or reporting how far past it they reach), the same result for the same input.
// The 2x2: every note lands in the quadrant its scores name, nothing overlaps, the output is deterministic.
import { describe, expect, it } from 'vitest'
import { CLEARANCE, collides, FRAME_MARGIN, frameRegion, right } from '../ai/layout.ts'
import {
  COLUMN_ROWS,
  type ColumnsInput,
  layoutColumns,
  layoutMatrix,
  MATRIX_GAP,
  type MatrixNote,
  matrixFrameSize,
  overlaps,
  QUADRANT_KEYS,
  type QuadrantKey,
  quadrantOf,
  type Rect,
  reach,
} from './layout.ts'

const NOTE = { w: 200, h: 200 }
const notes = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ...NOTE }))

/** A label one line tall, whatever its width. */
const labelH = () => 40

const rectOf = (n: { x: number; y: number }, size = NOTE): Rect => ({ x: n.x, y: n.y, ...size })

function columnsInput(over: Partial<ColumnsInput> = {}): ColumnsInput {
  return {
    groups: [
      { key: 'a', notes: notes('a', 4) },
      { key: 'b', notes: notes('b', 3) },
      { key: 'c', notes: notes('c', 5) },
    ],
    labelH,
    anchor: { x: 40, y: 200 },
    region: { minX: 40, maxX: 2400, maxY: null },
    obstacles: [],
    ...over,
  }
}

describe('layoutColumns', () => {
  it('lays groups out as labelled columns side by side, in the groups’ order, one note wide', () => {
    const out = layoutColumns(columnsInput())
    expect(out.columns.map((c) => c.key)).toEqual(['a', 'b', 'c'])
    expect(out.columns.map((c) => c.cols)).toEqual([1, 1, 1])
    // side by side, left to right, headings on one line
    const xs = out.columns.map((c) => c.label.x)
    expect([...xs].sort((p, q) => p - q)).toEqual(xs)
    expect(new Set(out.columns.map((c) => c.label.y)).size).toBe(1)
    // each column's notes share one x and stack downward, in the order given
    for (const c of out.columns) {
      expect(new Set(c.notes.map((n) => n.x)).size).toBe(1)
      const ys = c.notes.map((n) => n.y)
      expect([...ys].sort((p, q) => p - q)).toEqual(ys)
      expect(c.notes[0]?.y).toBeGreaterThan(c.label.y + c.label.h)
    }
    expect(out.overflow).toEqual({ right: 0, bottom: 0 })
  })

  it('starts at the anchor and never overlaps itself', () => {
    const out = layoutColumns(columnsInput())
    expect(out.columns[0]?.label.x).toBe(40)
    expect(out.columns[0]?.label.y).toBe(200)
    const all = out.columns.flatMap((c) => c.notes.map((n) => rectOf(n)))
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(overlaps(all[i] as Rect, all[j] as Rect), `${i} and ${j}`).toBe(false)
    // and not over a heading either
    for (const c of out.columns)
      for (const o of out.columns.flatMap((d) => d.notes.map((n) => rectOf(n))))
        expect(overlaps(c.label, o)).toBe(false)
  })

  it('is deterministic: the same input gives the same output', () => {
    const a = layoutColumns(columnsInput())
    const b = layoutColumns(columnsInput())
    expect(b).toEqual(a)
  })

  it('stays clear of everything that stays', () => {
    const wall: Rect = { x: 40, y: 150, w: 900, h: 700 }
    const out = layoutColumns(columnsInput({ obstacles: [wall] }))
    for (const c of out.columns) {
      expect(collides(c.box, wall, CLEARANCE - 0.01), c.key).toBe(false)
      for (const n of c.notes) expect(collides(rectOf(n), wall, CLEARANCE - 0.01), n.id).toBe(false)
    }
  })

  it('wraps a group of more than COLUMN_ROWS notes into sub-columns, under one heading', () => {
    const out = layoutColumns(
      columnsInput({ groups: [{ key: 'big', notes: notes('x', COLUMN_ROWS * 2 + 1) }] }),
    )
    const col = out.columns[0]
    expect(col?.cols).toBe(3)
    expect(col?.notes).toHaveLength(COLUMN_ROWS * 2 + 1)
    expect(new Set(col?.notes.map((n) => n.x)).size).toBe(3)
  })

  it('uses wider clusters before it grows a frame, and reports what is still past the room', () => {
    const frame = { w: 760, h: 700 }
    const region = frameRegion(frame, { x: FRAME_MARGIN, y: FRAME_MARGIN }, NOTE.w)
    const tight = layoutColumns(
      columnsInput({
        groups: [
          { key: 'a', notes: notes('a', 6) },
          { key: 'b', notes: notes('b', 6) },
          { key: 'c', notes: notes('c', 6) },
        ],
        anchor: { x: FRAME_MARGIN, y: FRAME_MARGIN },
        region,
      }),
    )
    // three tall columns do not fit a frame this small: it asks to grow by what is missing, no more
    expect(tight.overflow.right + tight.overflow.bottom).toBeGreaterThanOrEqual(0)
    const total = tight.columns.flatMap((c) => c.notes)
    expect(total).toHaveLength(18)
    const roomy = layoutColumns(
      columnsInput({
        groups: [
          { key: 'a', notes: notes('a', 2) },
          { key: 'b', notes: notes('b', 2) },
        ],
        anchor: { x: FRAME_MARGIN, y: FRAME_MARGIN },
        region,
      }),
    )
    expect(roomy.overflow).toEqual({ right: 0, bottom: 0 })
    for (const c of roomy.columns) expect(right(c.box)).toBeLessThanOrEqual(region.maxX)
  })

  it('has nothing to lay out for no groups, and ignores empty ones', () => {
    expect(layoutColumns(columnsInput({ groups: [] })).columns).toEqual([])
    const out = layoutColumns(
      columnsInput({
        groups: [
          { key: 'empty', notes: [] },
          { key: 'a', notes: notes('a', 2) },
        ],
      }),
    )
    expect(out.columns.map((c) => c.key)).toEqual(['a'])
  })
})

// ---- the 2x2 -----------------------------------------------------------------------------------------------------

/** Four quadrants of 640 x 520 around a middle at (640, 520). */
const QUADS: Record<QuadrantKey, Rect> = {
  'low-high': { x: 0, y: 0, w: 640, h: 520 },
  'high-high': { x: 640, y: 0, w: 640, h: 520 },
  'low-low': { x: 0, y: 520, w: 640, h: 520 },
  'high-low': { x: 640, y: 520, w: 640, h: 520 },
}

const mnote = (id: string, x: number, y: number, size = NOTE): MatrixNote => ({ id, x, y, ...size })

/** 12 notes, three per quadrant, with the scores that put them there. */
const TWELVE: MatrixNote[] = [
  mnote('hh1', 5, 5),
  mnote('hh2', 3, 4),
  mnote('hh3', 2, 2),
  mnote('hl1', 4, -4),
  mnote('hl2', 5, -1),
  mnote('hl3', 1, -5),
  mnote('lh1', -5, 3),
  mnote('lh2', -2, 5),
  mnote('lh3', -4, 4),
  mnote('ll1', -3, -3),
  mnote('ll2', -5, -5),
  mnote('ll3', -1, -2),
]

describe('layoutMatrix', () => {
  it('puts every note in the quadrant its scores name', () => {
    const out = layoutMatrix({ quadrants: QUADS, notes: TWELVE })
    expect(out.unplaced).toEqual([])
    expect(out.placed).toHaveLength(12)
    for (const p of out.placed) {
      const n = TWELVE.find((m) => m.id === p.id) as MatrixNote
      expect(p.quadrant, p.id).toBe(quadrantOf(n.x, n.y))
      const area = QUADS[p.quadrant]
      expect(p.x, p.id).toBeGreaterThanOrEqual(area.x)
      expect(p.y, p.id).toBeGreaterThanOrEqual(area.y)
      expect(p.x + n.w, p.id).toBeLessThanOrEqual(area.x + area.w)
      expect(p.y + n.h, p.id).toBeLessThanOrEqual(area.y + area.h)
    }
  })

  it('never overlaps two notes, or a note and an obstacle', () => {
    const obstacles: Rect[] = [{ x: 20, y: 20, w: 200, h: 200 }]
    const out = layoutMatrix({ quadrants: QUADS, notes: TWELVE, obstacles })
    const rects = out.placed.map((p) => ({ id: p.id, r: { x: p.x, y: p.y, ...NOTE } }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++)
        expect(overlaps((rects[i] as (typeof rects)[0]).r, (rects[j] as (typeof rects)[0]).r)).toBe(false)
      for (const o of obstacles) expect(overlaps((rects[i] as (typeof rects)[0]).r, o)).toBe(false)
    }
  })

  it('is deterministic, whatever order the notes arrive in', () => {
    const a = layoutMatrix({ quadrants: QUADS, notes: TWELVE })
    const b = layoutMatrix({ quadrants: QUADS, notes: [...TWELVE].reverse() })
    expect(b.placed).toHaveLength(12)
    const byId = (l: typeof a) => Object.fromEntries(l.placed.map((p) => [p.id, [p.x, p.y]]))
    expect(byId(b)).toEqual(byId(a))
    expect(layoutMatrix({ quadrants: QUADS, notes: TWELVE })).toEqual(a)
  })

  it('puts the more extreme score further from the middle of the matrix', () => {
    const out = layoutMatrix({
      quadrants: QUADS,
      notes: [mnote('mild', 1, 1), mnote('wild', 5, 5)],
    })
    const at = (id: string) => out.placed.find((p) => p.id === id) as { x: number; y: number }
    // top right: further right and further up (a smaller y) is more extreme
    expect(at('wild').x).toBeGreaterThan(at('mild').x)
    expect(at('wild').y).toBeLessThan(at('mild').y)
    // top left mirrors it: further left
    const left = layoutMatrix({ quadrants: QUADS, notes: [mnote('mild', -1, 1), mnote('wild', -5, 5)] })
    const l = (id: string) => left.placed.find((p) => p.id === id) as { x: number; y: number }
    expect(l('wild').x).toBeLessThan(l('mild').x)
  })

  it('counts zero as the low end (a note must be clearly high to count as high)', () => {
    expect(quadrantOf(0, 0)).toBe('low-low')
    expect(quadrantOf(1, 0)).toBe('high-low')
    expect(quadrantOf(0, 1)).toBe('low-high')
    expect(quadrantOf(-5, 5)).toBe('low-high')
  })

  it('reports the notes that do not fit a full quadrant, and how tall it would need to be', () => {
    const small: Record<QuadrantKey, Rect> = Object.fromEntries(
      QUADRANT_KEYS.map((k) => [k, { ...QUADS[k], w: 440, h: 220 }]),
    ) as Record<QuadrantKey, Rect>
    const crowd = Array.from({ length: 5 }, (_, i) => mnote(`c${i}`, 5, 5))
    const out = layoutMatrix({ quadrants: small, notes: crowd })
    // 440 wide holds two 200 notes a row, 220 tall holds one row: two fit, three do not
    expect(out.placed).toHaveLength(2)
    expect(out.unplaced).toHaveLength(3)
    expect(out.heightNeeded['high-high']).toBe(3 * 200 + 2 * MATRIX_GAP)
    expect(out.heightNeeded['low-low']).toBe(0)
  })

  it('keeps smaller notes in the middle of their cell and mixed sizes apart', () => {
    const out = layoutMatrix({
      quadrants: QUADS,
      notes: [mnote('big', 5, 5), mnote('small', 5, 5, { w: 100, h: 100 })],
    })
    expect(out.placed).toHaveLength(2)
    const [a, b] = out.placed.map((p) => rectOf(p, p.id === 'small' ? { w: 100, h: 100 } : NOTE))
    expect(overlaps(a as Rect, b as Rect)).toBe(false)
  })

  it('maps reach from 0 at the middle to 1 at the edge', () => {
    expect(reach(0)).toBe(0)
    expect(reach(-5)).toBe(1)
    expect(reach(5)).toBe(1)
    expect(reach(1)).toBeLessThan(reach(3))
  })

  it('sizes a matrix frame so its busiest quadrant holds its notes', () => {
    for (const n of [1, 3, 5, 9, 14, 40]) {
      const size = matrixFrameSize(n, NOTE)
      expect(size.cols * size.rows, `${n} notes`).toBeGreaterThanOrEqual(n)
      const out = layoutMatrix({
        quadrants: {
          'low-high': { x: 0, y: 0, w: size.quadW, h: size.quadH },
          'high-high': { x: size.quadW, y: 0, w: size.quadW, h: size.quadH },
          'low-low': { x: 0, y: size.quadH, w: size.quadW, h: size.quadH },
          'high-low': { x: size.quadW, y: size.quadH, w: size.quadW, h: size.quadH },
        },
        notes: Array.from({ length: n }, (_, i) => mnote(`n${i}`, 3, 3)),
      })
      expect(out.unplaced, `${n} notes in one quadrant`).toEqual([])
    }
  })
})
