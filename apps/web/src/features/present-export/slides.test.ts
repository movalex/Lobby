import { frame, group, note, PAGE, page, sid } from '@draftroom/board-ops/test-fixtures'
import type { TLRecord, TLShape, TLShapeId } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { type FrameEntry, frameOutline, presentationOrder } from './board-ops.ts'
import {
  buildSlides,
  findStartIndex,
  fittedSlideRect,
  isSkipped,
  pickPdfFrames,
  reconcileIndex,
  type Slide,
  slideTitle,
  stepIndex,
} from './slides.ts'

// Three frames in a row (reading order A, B, C) plus a frame nested in B and a note inside C.
function board(extra: TLRecord[] = [], meta: Record<string, Record<string, unknown>> = {}) {
  const records: TLRecord[] = [
    page(PAGE, 'Page 1'),
    frame('a', 'Intro', { x: 0, y: 0, meta: meta.a as never }),
    frame('b', 'Ideas', { x: 400, y: 0, meta: meta.b as never }),
    frame('c', 'Plan', { x: 800, y: 0, meta: meta.c as never }),
    frame('b-inner', 'Nested', { x: 10, y: 10, w: 100, h: 50, parentId: sid('b') }),
    note('in-c', 'hello', { x: 20, y: 20, parentId: sid('c') }),
    ...extra,
  ]
  const byId = new Map(records.map((r) => [r.id as string, r]))
  const shapeOf = (id: TLShapeId) => byId.get(id) as TLShape | undefined
  const ancestorsOf = (id: TLShapeId): TLShapeId[] => {
    const out: TLShapeId[] = []
    let current = byId.get(id) as TLShape | undefined
    while (current && typeof current.parentId === 'string' && current.parentId.startsWith('shape:')) {
      out.push(current.parentId as TLShapeId)
      current = byId.get(current.parentId) as TLShape | undefined
    }
    return out
  }
  const order = presentationOrder(records, PAGE)
  const outline = frameOutline(records, PAGE)
  return { records, shapeOf, ancestorsOf, order, outline }
}

const ids = (slides: readonly { id: string }[]) => slides.map((s) => s.id)

describe('isSkipped', () => {
  it('is true only for meta.presentationSkip === true', () => {
    expect(isSkipped({ meta: { presentationSkip: true } })).toBe(true)
    expect(isSkipped({ meta: { presentationSkip: 'true' } })).toBe(false)
    expect(isSkipped({ meta: { presentationSkip: 1 } })).toBe(false)
    expect(isSkipped({ meta: {} })).toBe(false)
    expect(isSkipped({ meta: null })).toBe(false)
    expect(isSkipped({ meta: [true] })).toBe(false)
    expect(isSkipped(undefined)).toBe(false)
  })
})

describe('buildSlides', () => {
  it('uses the top-level frames in presentation (reading) order', () => {
    const { order, shapeOf } = board()
    expect(ids(buildSlides(order, shapeOf))).toEqual([sid('a'), sid('b'), sid('c')])
  })

  it('follows explicit meta.presentationIndex before reading order', () => {
    const { order, shapeOf } = board([], { c: { presentationIndex: 0 }, a: { presentationIndex: 1 } })
    expect(ids(buildSlides(order, shapeOf))).toEqual([sid('c'), sid('a'), sid('b')])
  })

  it('leaves out frames marked skip', () => {
    const { order, shapeOf } = board([], { b: { presentationSkip: true } })
    const slides = buildSlides(order, shapeOf)
    expect(ids(slides)).toEqual([sid('a'), sid('c')])
    expect(slides[1]?.name).toBe('Plan')
    expect(slides[1]?.bounds).toEqual({ x: 800, y: 0, w: 320, h: 180 })
  })

  it('leaves out zero-area frames and returns nothing when every frame is skipped', () => {
    const flat = frame('flat', 'Flat', { x: 0, y: 900, w: 0, h: 100 })
    const { order, shapeOf } = board([flat])
    expect(ids(buildSlides(order, shapeOf))).not.toContain(sid('flat'))
    const all = board([], {
      a: { presentationSkip: true },
      b: { presentationSkip: true },
      c: { presentationSkip: true },
    })
    expect(buildSlides(all.order, all.shapeOf)).toEqual([])
  })

  it('includes frames inside groups (still top-level frames) with page-space bounds', () => {
    const g = group('g', { x: 0, y: 600 })
    const inGroup = frame('in-group', 'Grouped', { x: 50, y: 0, parentId: sid('g') })
    const { order, shapeOf } = board([g, inGroup])
    const slides = buildSlides(order, shapeOf)
    const grouped = slides.find((s) => s.id === sid('in-group'))
    expect(grouped?.bounds).toEqual({ x: 50, y: 600, w: 320, h: 180 })
    expect(ids(slides).at(-1)).toBe(sid('in-group'))
  })
})

describe('slideTitle', () => {
  it('falls back to a numbered title for unnamed frames', () => {
    expect(slideTitle('  Moodboard ', 0)).toBe('Moodboard')
    expect(slideTitle('', 2)).toBe('Frame 3')
    expect(slideTitle('   ', 0)).toBe('Frame 1')
  })
})

describe('findStartIndex', () => {
  it('starts at the first slide without a selection', () => {
    const b = board()
    const slides = buildSlides(b.order, b.shapeOf)
    expect(findStartIndex(slides, b.order, [], b.ancestorsOf)).toBe(0)
  })

  it('starts at a selected frame, or at the frame containing a selected shape', () => {
    const b = board()
    const slides = buildSlides(b.order, b.shapeOf)
    expect(findStartIndex(slides, b.order, [sid('c')], b.ancestorsOf)).toBe(2)
    expect(findStartIndex(slides, b.order, [sid('in-c')], b.ancestorsOf)).toBe(2)
    // A nested frame starts at its top-level slide.
    expect(findStartIndex(slides, b.order, [sid('b-inner')], b.ancestorsOf)).toBe(1)
  })

  it('uses the first selected shape that belongs to a slide', () => {
    const b = board([note('loose', 'outside', { x: 0, y: 2000 })])
    const slides = buildSlides(b.order, b.shapeOf)
    expect(findStartIndex(slides, b.order, [sid('loose'), sid('b')], b.ancestorsOf)).toBe(1)
    expect(findStartIndex(slides, b.order, [sid('loose')], b.ancestorsOf)).toBe(0)
  })

  it('starts after a selected frame that is skipped (or before it when it is last)', () => {
    const b = board([], { b: { presentationSkip: true } })
    const slides = buildSlides(b.order, b.shapeOf)
    expect(ids(slides)).toEqual([sid('a'), sid('c')])
    expect(findStartIndex(slides, b.order, [sid('b')], b.ancestorsOf)).toBe(1) // → c
    const tail = board([], { c: { presentationSkip: true } })
    const tailSlides = buildSlides(tail.order, tail.shapeOf)
    expect(findStartIndex(tailSlides, tail.order, [sid('c')], tail.ancestorsOf)).toBe(1) // → b
  })

  it('returns -1 when there are no slides', () => {
    const b = board()
    expect(findStartIndex([], b.order, [sid('a')], b.ancestorsOf)).toBe(-1)
  })
})

describe('fittedSlideRect', () => {
  const range = { min: 0.05, max: 8 }
  it('letterboxes a 16:9 frame on a 16:10 screen (full width, centred vertically)', () => {
    const r = fittedSlideRect({ x: 500, y: 300, w: 1600, h: 900 }, { w: 1440, h: 900 }, range)
    expect(r.zoom).toBeCloseTo(0.9)
    expect(r).toMatchObject({ x: 0, w: 1440 })
    expect(r.h).toBeCloseTo(810)
    expect(r.y).toBeCloseTo(45)
  })
  it('pillarboxes a tall frame', () => {
    const r = fittedSlideRect({ x: 0, y: 0, w: 900, h: 1600 }, { w: 1440, h: 800 }, range)
    expect(r.h).toBeCloseTo(800)
    expect(r.y).toBeCloseTo(0)
    expect(r.x).toBeCloseTo((1440 - 450) / 2)
  })
  it('stops at the maximum zoom for tiny frames (smaller window, still centred)', () => {
    const r = fittedSlideRect({ x: 0, y: 0, w: 20, h: 10 }, { w: 1000, h: 800 }, range)
    expect(r.zoom).toBe(8)
    expect(r).toEqual({ x: 420, y: 360, w: 160, h: 80, zoom: 8 })
  })
})

describe('stepIndex', () => {
  it('moves forward and back without wrapping', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(2)
    expect(stepIndex(0, -1, 3)).toBe(0)
    expect(stepIndex(1, -1, 3)).toBe(0)
    expect(stepIndex(0, 99, 3)).toBe(2)
    expect(stepIndex(2, -99, 3)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(-1)
  })
})

describe('reconcileIndex', () => {
  const s = (name: string): Slide => ({ id: sid(name), name, bounds: { x: 0, y: 0, w: 1, h: 1 } })
  it('keeps the current frame when the list is reordered', () => {
    expect(reconcileIndex(0, sid('a'), [s('b'), s('a'), s('c')])).toBe(1)
  })
  it('lands on the slide now in the same place when the current frame is gone or skipped', () => {
    expect(reconcileIndex(1, sid('b'), [s('a'), s('c')])).toBe(1)
    expect(reconcileIndex(2, sid('c'), [s('a'), s('b')])).toBe(1)
  })
  it('returns -1 when no slides are left', () => {
    expect(reconcileIndex(0, sid('a'), [])).toBe(-1)
  })
})

describe('pickPdfFrames', () => {
  const pick = (
    b: ReturnType<typeof board>,
    selected: TLShapeId[],
    includeSkipped = false,
  ): { frames: string[]; source: string; skippedCount: number } => {
    const r = pickPdfFrames(b.order, b.outline, selected, b.shapeOf, { includeSkipped })
    return { ...r, frames: r.frames.map((f: FrameEntry) => f.id) }
  }

  it('uses every top-level frame in presentation order without a frame selection', () => {
    const b = board([], { c: { presentationIndex: 0 } })
    expect(pick(b, [])).toEqual({ frames: [sid('c'), sid('a'), sid('b')], source: 'all', skippedCount: 0 })
    // A selection without frames exports all frames too.
    expect(pick(b, [sid('in-c')]).source).toBe('all')
  })

  it('leaves out skipped frames unless asked to include them', () => {
    const b = board([], { a: { presentationSkip: true } })
    expect(pick(b, [])).toEqual({ frames: [sid('b'), sid('c')], source: 'all', skippedCount: 1 })
    expect(pick(b, [], true).frames).toEqual([sid('a'), sid('b'), sid('c')])
  })

  it('exports only selected frames (any depth, skipped included) in presentation then outline order', () => {
    const b = board([], { c: { presentationSkip: true }, c2: {} })
    expect(pick(b, [sid('c'), sid('b-inner'), sid('a')])).toEqual({
      frames: [sid('a'), sid('c'), sid('b-inner')],
      source: 'selection',
      skippedCount: 0,
    })
  })
})
